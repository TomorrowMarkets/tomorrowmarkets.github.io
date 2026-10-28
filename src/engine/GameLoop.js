import { BotFleet } from './BotFleet.js';
import { TickAccumulator } from './bars.js';
import { HistoricalMarket } from './HistoricalMarket.js';

const SESSION_OPEN_SECS = 9 * 3600 + 30 * 60;
const SESSION_CLOSE_SECS = 18 * 3600;
const SIM_SECS_PER_TICK = 15;
const GAME_DURATION_MINUTES = 10;
const TOTAL_TICKS = (SESSION_CLOSE_SECS - SESSION_OPEN_SECS) / SIM_SECS_PER_TICK;
const MAX_BACKLOG_TICKS = 40;
function formatSimTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  return `${String(hours % 12 || 12).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
}

export class PulseClock {
  constructor(intervalMs, onPulse) {
    this.intervalMs = intervalMs;
    this.onPulse = onPulse;
    this.worker = null;
    this.workerUrl = null;
    this.timer = null;
  }

  start() {
    this.stop();
    try {
      const src = 'let t=null;onmessage=(e)=>{clearInterval(t);t=null;if(e.data>0)t=setInterval(()=>postMessage(1),e.data);};';
      this.workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = () => this.onPulse();
      this.worker.onerror = () => this.useFallback();
      this.worker.postMessage(this.intervalMs);
    } catch (err) {
      this.useFallback();
    }
  }

  useFallback() {
    this.stopWorker();
    if (!this.timer) this.timer = setInterval(() => this.onPulse(), this.intervalMs);
  }

  stopWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
  }

  stop() {
    this.stopWorker();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export class GameLoop {
  constructor(orderBook, eventBus, { durationMinutes = GAME_DURATION_MINUTES, afterStep, onPulse, onFinish, onNews, shouldPause, onPaused } = {}) {
    this.orderBook = orderBook;
    this.historical = null;
    this.fleet = new BotFleet(orderBook, eventBus, {
      simSecsPerTick: SIM_SECS_PER_TICK,
      openSecs: SESSION_OPEN_SECS,
      closeSecs: SESSION_CLOSE_SECS,
      onNews
    });
    this.afterStep = afterStep;
    this.onPulse = onPulse;
    this.onFinish = onFinish;
    this.shouldPause = shouldPause || null; // (tick) => bool: stop after this tick until resume()
    this.onPaused = onPaused || null;
    this.paused = false;
    this.pausedAt = 0;

    this.totalTicks = TOTAL_TICKS;
    this.tickIntervalMs = (durationMinutes * 60 * 1000) / this.totalTicks; // ≈294 ms for 10 minutes

    this.ticksDone = 0;
    this.simulatedSeconds = SESSION_OPEN_SECS;
    this.priceHistory = [];
    this.running = false;

    // Every trade between two ticks feeds that tick's high, low and volume.
    this.tickBar = new TickAccumulator();
    this.lastClose = null;
    this.collecting = false;
    eventBus.on('TRADE', (t) => {
      if (this.collecting) this.tickBar.addTrade(t.price, t.qty);
    });
    this.finished = false;
    this.startedAt = 0;

    this.clock = new PulseClock(Math.min(100, this.tickIntervalMs / 3), () => this.pump());
  }

  configure({ durationMinutes = GAME_DURATION_MINUTES, historicalData = null } = {}) {
    if (this.running) throw new Error('The market is already running.');
    if (![10, 15, 20].includes(durationMinutes)) throw new Error('Choose a 10, 15 or 20 minute session.');
    this.historical = historicalData ? new HistoricalMarket(this.orderBook, historicalData) : null;
    this.orderBook.referencePrice = null;
    this.tickIntervalMs = durationMinutes * 60000 / this.totalTicks;
    this.clock.intervalMs = Math.min(100, this.tickIntervalMs / 3);
  }

  currentTime() {
    return this.historical?.timestamp
      ? this.historical.timestamp.replace('T', ' ').replace('Z', ' UTC')
      : formatSimTime(this.simulatedSeconds);
  }

  progress() {
    return this.ticksDone / this.totalTicks;
  }

  start() {
    this.ticksDone = 0;
    this.simulatedSeconds = SESSION_OPEN_SECS;
    this.finished = false;
    this.paused = false;
    this.tickBar.reset();
    this.lastClose = null;
    this.collecting = true;
    if (this.historical) this.historical.start();
    this.priceHistory = [this.makePoint()];
    if (!this.historical) this.fleet.start(this.priceHistory); // 1,000 traders arrive and build the opening book
    this.startedAt = performance.now();
    this.running = true;
    this.clock.start();
    if (this.onPulse) this.onPulse([this.priceHistory[0]]);
  }

  stop() {
    this.running = false;
    this.paused = false;
    this.collecting = false;
    this.clock.stop();
  }

  // Freeze the day right after the tick just played. The wall clock is
  // pinned to that tick, so resuming neither skips ticks nor bursts through
  // the ones that would have been due during the pause.
  pause() {
    if (this.paused || !this.running) return;
    this.paused = true;
    this.pausedAt = this.startedAt + this.ticksDone * this.tickIntervalMs;
    this.clock.stop();
  }

  resume() {
    if (!this.paused || !this.running) return;
    this.startedAt += performance.now() - this.pausedAt;
    this.paused = false;
    this.clock.start();
  }

  // Runs however many ticks the wall clock says are due, so the day always
  // lasts GAME_DURATION_MINUTES even if pulses arrive late or bunched up.
  pump() {
    if (!this.running || this.paused) return;
    let due = Math.min(this.totalTicks, Math.floor((performance.now() - this.startedAt) / this.tickIntervalMs));
    const backlog = due - this.ticksDone;
    if (backlog > MAX_BACKLOG_TICKS) {
      // Host was frozen (sleeping laptop, suspended tab). Pause instead of fast-forwarding.
      const skip = backlog - MAX_BACKLOG_TICKS;
      this.startedAt += skip * this.tickIntervalMs;
      due -= skip;
    }

    const points = [];
    while (this.ticksDone < due) {
      points.push(this.step());
      if (this.shouldPause && this.ticksDone < this.totalTicks && this.shouldPause(this.ticksDone)) {
        this.pause();
        break;
      }
    }
    if (points.length && this.onPulse) this.onPulse(points);
    if (this.paused) {
      if (this.onPaused) this.onPaused(this.ticksDone);
      return;
    }

    if (this.ticksDone >= this.totalTicks) {
      this.finished = true;
      this.stop();
      if (!this.historical) this.fleet.endDay(this.priceHistory); // Tomorrow AI's final reward for the day
      if (this.onFinish) this.onFinish();
    }
  }

  step() {
    this.ticksDone += 1;
    this.simulatedSeconds = SESSION_OPEN_SECS + this.ticksDone * SIM_SECS_PER_TICK;
    this.orderBook.currentTick = this.ticksDone;
    this.orderBook.expireOrders(this.ticksDone);
    if (this.historical) this.historical.advance(this.progress(), () => {
      this.tickBar.addTrade(this.orderBook.getMidPrice(), 0);
      if (this.afterStep) this.afterStep();
    });
    else this.fleet.onTick({ tick: this.ticksDone, simSeconds: this.simulatedSeconds, history: this.priceHistory });
    if (this.afterStep) this.afterStep();
    const point = this.makePoint();
    this.priceHistory.push(point);
    return point;
  }

  // One bar per tick: `price` is the closing mid (the bots read it), plus
  // open/high/low/volume/value for candles and indicators (see engine/bars.js).
  makePoint() {
    const close = this.orderBook.getMidPrice();
    const bar = this.tickBar.take(this.lastClose ?? close, close);
    this.lastClose = close;
    return { ...bar, simTimeStr: this.currentTime(), simSecs: this.simulatedSeconds, sourceTimestamp: this.historical?.timestamp || null };
  }
}


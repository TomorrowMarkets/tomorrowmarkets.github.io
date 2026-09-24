// src/engine/simulate.js
// Runs a whole trading day of the bot market with no UI, as fast as the
// machine allows (about 2 seconds). Same book, same fleet, same schedule as
// the live game. With a seed the day is reproducible: everyone who asks for
// seed 'x' gets the same day, which is what a shared challenge or a
// backtest needs. Works in the browser and in Node.

import { OrderBook } from './OrderBook.js';
import { BotFleet } from './BotFleet.js';
import { seed as seedRandom } from './random.js';

const OPEN_SECS = 9 * 3600 + 30 * 60; // 09:30
const CLOSE_SECS = 18 * 3600;         // 18:00
const SIM_SECS_PER_TICK = 15;

class Bus {
  constructor() { this.listeners = {}; }
  on(event, fn) { (this.listeners[event] ||= []).push(fn); }
  emit(event, data) { for (const fn of this.listeners[event] || []) fn(data); }
}

// Returns { bars, trades, fleet, book }:
//   bars   one per minute: { time (secs since midnight), open, high, low, close, volume }
//          (prices are the mid, like the in-game chart; volume is shares traded)
//   trades every fill of the day, if keepTrades is set
// onStep({ tick, simSeconds, book, fleet, history }) runs after every 15-second step.
export function simulateDay({ seed = null, keepTrades = false, onStep = null } = {}) {
  if (seed != null) seedRandom(seed);
  const bus = new Bus();
  const book = new OrderBook(bus);
  const fleet = new BotFleet(book, bus, { simSecsPerTick: SIM_SECS_PER_TICK, openSecs: OPEN_SECS, closeSecs: CLOSE_SECS });
  const trades = [];
  let volume = 0;
  bus.on('TRADE', (t) => {
    volume += t.qty;
    if (keepTrades) trades.push(t);
  });

  const history = [{ price: book.getMidPrice(), simSecs: OPEN_SECS }];
  fleet.start(history);

  const ticksPerMinute = 60 / SIM_SECS_PER_TICK;
  const totalTicks = (CLOSE_SECS - OPEN_SECS) / SIM_SECS_PER_TICK;
  const bars = [];
  let bar = null;
  for (let tick = 1; tick <= totalTicks; tick++) {
    const simSeconds = OPEN_SECS + tick * SIM_SECS_PER_TICK;
    book.currentTick = tick;
    book.expireOrders(tick);
    fleet.onTick({ tick, simSeconds, history });
    const price = book.getMidPrice();
    history.push({ price, simSecs: simSeconds });
    if (onStep) onStep({ tick, simSeconds, book, fleet, history });

    if (!bar) {
      const open = history[history.length - 2].price;
      bar = { time: simSeconds - SIM_SECS_PER_TICK, open, high: open, low: open, close: open, volume: 0 };
    }
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    if (tick % ticksPerMinute === 0) {
      bar.volume = volume;
      volume = 0;
      bars.push(bar);
      bar = null;
    }
  }
  return { bars, trades, fleet, book };
}

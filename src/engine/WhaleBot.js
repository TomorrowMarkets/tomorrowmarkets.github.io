
import { BaseBot } from './BaseBot.js';

export class WhaleBot extends BaseBot {
  /**
   * @param {string} id 
   * @param {string} name 
   * @param {OrderBook} orderBook 
   * @param {EventBus} eventBus 
   */
  constructor(id, name, orderBook, eventBus) {
    // Whales require large balance to absorb full book sweeps
    super(id, name, orderBook, eventBus, 10000000);

    this.maxSharesPerBurst = 10000;
    this.burstDurationSeconds = 2;
    
    this.scheduledBursts = [];
    this.currentBurst = null;
    this.initialized = false;
  }

  /**
   * Divide game duration into 3 equal windows and pick a random start time 
   * inside each window so bursts are spaced out randomly without overlapping.
   */
  scheduleBursts(totalDurationSeconds, startClockSeconds) {
    this.scheduledBursts = [];
    const windowSize = totalDurationSeconds / 3;

    for (let i = 0; i < 3; i++) {
      const windowStart = startClockSeconds + (i * windowSize);
      // Ensure at least 3s buffer before window end so the 2s burst fits cleanly
      const maxOffset = Math.max(1, windowSize - 3);
      const startTime = windowStart + (Math.random() * maxOffset);
      const direction = Math.random() > 0.5 ? 'BUY' : 'SELL';

      this.scheduledBursts.push({
        startTime,
        endTime: startTime + this.burstDurationSeconds,
        direction,
        sharesTraded: 0,
        completed: false
      });
    }

    this.initialized = true;
  }

  /**
   * Triggered on every game engine tick.
   * @param {Object} marketState Current game clock, duration, and order book state.
   */
  onTick(marketState) {
    const currentClock = marketState.clockSeconds || 0;
    const matchDuration = (marketState.durationMinutes || 10) * 60;

    // Lazily schedule the 3 burst windows on game start
    if (!this.initialized) {
      this.scheduleBursts(matchDuration, currentClock);
    }

    // Check if we need to enter an active burst
    if (!this.currentBurst) {
      const activeBurst = this.scheduledBursts.find(
        b => !b.completed && currentClock >= b.startTime && currentClock <= b.endTime
      );

      if (activeBurst) {
        this.currentBurst = activeBurst;

        // Emit event for UI notifications (e.g. Toast alert or ticker banner)
        if (this.eventBus) {
          this.eventBus.emit('WHALE_BURST_START', {
            botId: this.id,
            botName: this.name,
            direction: this.currentBurst.direction
          });
        }
      }
    }

    // Execute aggressive order sweep if inside active 2-second burst
    if (this.currentBurst) {
      const isExpired = currentClock > this.currentBurst.endTime;
      const isCapReached = this.currentBurst.sharesTraded >= this.maxSharesPerBurst;

      if (isExpired || isCapReached) {
        this.currentBurst.completed = true;
        this.currentBurst = null;
        return;
      }

      const remainingCap = this.maxSharesPerBurst - this.currentBurst.sharesTraded;
      if (remainingCap <= 0) return;

      // Submit aggressive market order to sweep all available depth up to remaining cap
      const side = this.currentBurst.direction;
      const sweepPrice = side === 'BUY' ? 999999.00 : 0.01;

      this.submitOrder(side, sweepPrice, remainingCap, 'MARKET');
      this.currentBurst.sharesTraded += remainingCap;
    }
  }

  /**
   * Reset whale schedule when a match restarts or lobby resets
   */
  reset() {
    this.scheduledBursts = [];
    this.currentBurst = null;
    this.initialized = false;
  }
}

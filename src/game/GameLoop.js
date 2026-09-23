export class GameLoop {
  /**
   * @param {Object} orderBook 
   * @param {Array} bots 
   * @param {Object} eventBus 
   * @param {number} gameDurationMinutes Real-world game length (10, 20, or 30 mins)
   */
  constructor(orderBook, bots = [], eventBus = null, gameDurationMinutes = 10) {
    this.orderBook = orderBook;
    this.bots = bots;
    this.eventBus = eventBus;
    
    this.simSecsPerTick = 15; // 15 seconds per step
    this.totalSimSecs = 9 * 3600; // 9 trading hours = 32,400s
    this.totalTicks = this.totalSimSecs / this.simSecsPerTick; // 2,160 total steps
    
    // Calculate millisecond delay per tick for game duration
    const realMsTotal = gameDurationMinutes * 60 * 1000;
    this.tickIntervalMs = Math.floor(realMsTotal / this.totalTicks);

    this.simulatedSeconds = 9 * 3600 + 30 * 60; // Start market at 09:30:00 AM
    this.priceHistory = [];
    this.intervalId = null;
  }

  getSimTimeFormatted() {
    const hours = Math.floor(this.simulatedSeconds / 3600);
    const mins = Math.floor((this.simulatedSeconds % 3600) / 60);
    const secs = this.simulatedSeconds % 60;
    
    const hStr = String(hours > 12 ? hours - 12 : hours).padStart(2, '0');
    const mStr = String(mins).padStart(2, '0');
    const sStr = String(secs).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';

    return `${hStr}:${mStr}:${sStr} ${ampm}`;
  }

  start() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  tick() {
    // Advance simulation time by 15 seconds
    this.simulatedSeconds += this.simSecsPerTick;

    // Run bot actions
    this.bots.forEach((bot) => bot.onTick());

    const currentMid = this.orderBook.getMidPrice();
    const timeStr = this.getSimTimeFormatted();

    // Store rich price history node
    this.priceHistory.push({
      price: currentMid,
      simTimeStr: timeStr,
      simSecs: this.simulatedSeconds
    });

    // Cap total array length to 1 trading day (2160 steps)
    if (this.priceHistory.length > this.totalTicks) {
      this.priceHistory.shift();
    }

    if (this.eventBus) {
      this.eventBus.emit('TICK', {
        midPrice: currentMid,
        simTimeStr: timeStr,
        priceHistory: this.priceHistory,
        bids: this.orderBook.bids,
        asks: this.orderBook.asks
      });
    }
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
  }
}

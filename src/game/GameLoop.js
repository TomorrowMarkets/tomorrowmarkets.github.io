import { BotFleet } from './engine/BotFleet.js';

export class GameLoop {
  constructor(orderBook, eventBus = null, gameDurationMinutes = 10) {
    this.orderBook = orderBook;
    this.eventBus = eventBus;
    
    // Initialize the 100-bot fleet
    this.botFleet = new BotFleet(this.orderBook);

    this.simSecsPerTick = 15; 
    this.totalSimSecs = 9 * 3600; 
    this.totalTicks = this.totalSimSecs / this.simSecsPerTick; 
    
    const realMsTotal = gameDurationMinutes * 60 * 1000;
    this.tickIntervalMs = Math.floor(realMsTotal / this.totalTicks);

    this.simulatedSeconds = 9 * 3600 + 30 * 60; // Start at 09:30:00 AM
    this.priceHistory = [];
    this.intervalId = null;
  }

  start() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  tick() {
    this.simulatedSeconds += this.simSecsPerTick;

    // Run all 100 bots against order book and price history
    this.botFleet.onTick(this.priceHistory);

    const currentMid = this.orderBook.getMidPrice();
    const timeStr = this.getSimTimeFormatted();

    this.priceHistory.push({
      price: currentMid,
      simTimeStr: timeStr,
      simSecs: this.simulatedSeconds
    });

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
}

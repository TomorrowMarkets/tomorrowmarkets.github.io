// src/game/GameLoop.js
export class GameLoop {
  constructor(orderBook, bots = [], network = null, eventBus = null) {
    this.orderBook = orderBook;
    this.bots = bots;
    this.network = network;
    this.eventBus = eventBus;
    
    this.clockSeconds = 34200; // 09:30:00 AM
    this.durationMinutes = 10;
    this.gameSpeed = 26;
    this.priceHistory = [100.00];
    this.intervalId = null;
    this.active = false;
  }

  start(durationMinutes = 10, gameSpeed = 26) {
    this.durationMinutes = durationMinutes;
    this.gameSpeed = gameSpeed;
    this.active = true;

    this.intervalId = setInterval(() => this.tick(), 500);
  }

  stop() {
    this.active = false;
    if (this.intervalId) clearInterval(this.intervalId);
  }

  tick() {
    if (!this.active) return;

    this.clockSeconds += Math.round(this.gameSpeed / 2);
    const currentMid = this.orderBook.getMidPrice();

    this.priceHistory.push(currentMid);
    if (this.priceHistory.length > 80) this.priceHistory.shift();

    const marketState = {
      clockSeconds: this.clockSeconds,
      durationMinutes: this.durationMinutes,
      midPrice: currentMid,
      lastPrice: this.orderBook.lastPrice,
      priceHistory: this.priceHistory
    };

    // Execute Bot Behaviors
    this.bots.forEach(bot => bot.onTick(marketState));

    // Emit tick data to UI and Network
    if (this.eventBus) {
      this.eventBus.emit('TICK', {
        ...marketState,
        bids: this.orderBook.bids,
        asks: this.orderBook.asks
      });
    }
  }
}


// src/engine/BaseBot.js
export class BaseBot {
  constructor(id, name, orderBook, eventBus, capital = 50000) {
    this.id = id;
    this.name = name;
    this.orderBook = orderBook;
    this.eventBus = eventBus;
    this.cash = capital;
    this.shares = 0;
    this.activeOrders = [];
  }

  // Invoked on every game tick
  onTick(marketState) {
    throw new Error("onTick() must be implemented by subclass strategy.");
  }

  // Utility to send limit order directly to orderBook
  submitOrder(side, price, qty, type = 'LIMIT') {
    return this.orderBook.processOrder({
      playerId: this.id,
      side,
      price,
      qty,
      type
    });
  }
}

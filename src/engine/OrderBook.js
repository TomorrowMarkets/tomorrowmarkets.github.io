
import { events } from '../EventBus.js';

export class OrderBook {
  constructor() {
    this.bids = [];
    this.asks = [];
  }

  submitOrder(side, type, price, qty, senderId) {
    // 1. Order matching logic here...
    const tradeResult = this.matchOrder(side, type, price, qty, senderId);

    // 2. Broadcast event to whoever wants it (UI, Network, GameLoop)
    events.emit('ORDER_BOOK_UPDATED', { bids: this.bids, asks: this.asks });
    if (tradeResult.executed) {
      events.emit('TRADE_EXECUTED', tradeResult);
    }
  }

  matchOrder(side, type, price, qty, senderId) {
    // Pure matching engine logic...
    return { executed: true, price, qty, senderId };
  }
}

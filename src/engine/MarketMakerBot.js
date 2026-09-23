
// src/engine/MarketMakerBot.js
import { BaseBot } from './BaseBot.js';

export class MarketMakerBot extends BaseBot {
  constructor(id, name, orderBook, eventBus) {
    super(id, name, orderBook, eventBus);
    this.spreadHalf = 0.05;
    this.orderQty = 10;
  }

  onTick(marketState) {
    const midPrice = marketState.midPrice || 100.00;

    // Cancel existing orders if needed, then place dual-sided quotes
    const bidPrice = parseFloat((midPrice - this.spreadHalf).toFixed(2));
    const askPrice = parseFloat((midPrice + this.spreadHalf).toFixed(2));

    this.submitOrder('BUY', bidPrice, this.orderQty, 'LIMIT');
    this.submitOrder('SELL', askPrice, this.orderQty, 'LIMIT');
  }
}

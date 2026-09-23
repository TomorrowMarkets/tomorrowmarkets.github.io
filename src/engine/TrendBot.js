import { BaseBot } from './BaseBot.js';

export class TrendBot extends BaseBot {
  /**
   * @param {string} id 
   * @param {string} name 
   * @param {OrderBook} orderBook 
   * @param {EventBus} eventBus 
   * @param {number} [capital=50000] 
   */
  constructor(id, name, orderBook, eventBus, capital = 50000) {
    super(id, name, orderBook, eventBus, capital);

    this.lastPrice = null;
    this.consecutiveUp = 0;
    this.consecutiveDown = 0;
    this.orderQty = 20; // Default size per entry
    this.position = 0;  // > 0 Long, < 0 Short, 0 Flat
  }

  /**
   * Evaluates consecutive price moves on each tick.
   * @param {Object} marketState Current market state containing lastPrice / midPrice.
   */
  onTick(marketState) {
    const currentPrice = marketState.lastPrice || marketState.midPrice;
    if (!currentPrice) return;

    // 1. Track direction relative to last price tick
    if (this.lastPrice !== null) {
      if (currentPrice > this.lastPrice) {
        this.consecutiveUp++;
        this.consecutiveDown = 0;
      } else if (currentPrice < this.lastPrice) {
        this.consecutiveDown++;
        this.consecutiveUp = 0;
      }
    }
    this.lastPrice = currentPrice;

    // 2. Buy Trigger: Price went UP twice in a row
    if (this.consecutiveUp >= 2) {
      if (this.position <= 0) {
        // If short, close short position first and go long
        const qtyToBuy = this.position < 0 ? Math.abs(this.position) + this.orderQty : this.orderQty;
        this.submitOrder('BUY', 999999.00, qtyToBuy, 'MARKET');
        this.position += qtyToBuy;
        this.consecutiveUp = 0; // Reset streak counter after execution
      }
    }

    // 3. Sell Trigger: Price went DOWN twice in a row
    else if (this.consecutiveDown >= 2) {
      if (this.position >= 0) {
        // If long, exit long position first and go short
        const qtyToSell = this.position > 0 ? this.position + this.orderQty : this.orderQty;
        this.submitOrder('SELL', 0.01, qtyToSell, 'MARKET');
        this.position -= qtyToSell;
        this.consecutiveDown = 0; // Reset streak counter after execution
      }
    }
  }
}

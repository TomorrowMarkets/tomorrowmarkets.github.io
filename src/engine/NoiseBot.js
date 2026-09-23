
import { BaseBot } from './BaseBot.js';

export class NoiseBot extends BaseBot {
  /**
   * @param {string} id 
   * @param {string} name 
   * @param {OrderBook} orderBook 
   * @param {EventBus} eventBus 
   * @param {number} [capital=50000] 
   */
  constructor(id, name, orderBook, eventBus, capital = 50000) {
    super(id, name, orderBook, eventBus, capital);

    // Configurable noise parameters
    this.actionProbability = 0.4;       // 40% chance to submit an order per tick
    this.marketOrderProbability = 0.3;  // 30% MARKET orders, 70% LIMIT orders
    this.minQty = 1;                    // Min order size
    this.maxQty = 50;                   // Max order size
    this.priceSpreadOffset = 0.60;      // Max price deviation (±$0.60) from mid-price
  }

  /**
   * Triggered on every game tick. Randomizes activity, direction, size, type, and price.
   * @param {Object} marketState Current game clock and order book state.
   */
  onTick(marketState) {
    // 1. Random Timing: Skip execution if the roll fails this tick
    if (Math.random() > this.actionProbability) {
      return;
    }

    const midPrice = marketState.midPrice || 100.00;

    // 2. Random Side: BUY or SELL
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';

    // 3. Random Quantity (e.g. 1 to 50 shares)
    const qty = Math.floor(Math.random() * (this.maxQty - this.minQty + 1)) + this.minQty;

    // 4. Random Order Type: MARKET or LIMIT
    const isMarket = Math.random() < this.marketOrderProbability;
    const type = isMarket ? 'MARKET' : 'LIMIT';

    // 5. Price Determination
    let price;
    if (type === 'MARKET') {
      price = side === 'BUY' ? 999999.00 : 0.01;
    } else {
      // Pick a random price offset between -$0.60 and +$0.60 relative to mid-price
      const offset = (Math.random() * 2 - 1) * this.priceSpreadOffset;
      price = parseFloat(Math.max(0.01, midPrice + offset).toFixed(2));
    }

    // Submit order to order book
    this.submitOrder(side, price, qty, type);
  }
}

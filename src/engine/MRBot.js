import { BaseBot } from './BaseBot.js';

export class MRBot extends BaseBot {
  /**
   * @param {string} id 
   * @param {string} name 
   * @param {OrderBook} orderBook 
   * @param {EventBus} eventBus 
   * @param {number} [capital=50000] 
   */
  constructor(id, name, orderBook, eventBus, capital = 50000) {
    super(id, name, orderBook, eventBus, capital);

    this.windowSize = 20;
    this.orderQty = 15;
    this.activeBidId = null;
    this.activeAskId = null;
  }

  /**
   * Calculates 20-period SMA and posts offset Limit Orders on each tick.
   * @param {Object} marketState Current market state containing priceHistory array.
   */
  onTick(marketState) {
    const history = marketState.priceHistory || [];
    if (history.length === 0) return;

    // 1. Calculate 20-period SMA (or use available history length if < 20)
    const windowSlice = history.slice(-this.windowSize);
    const sma = windowSlice.reduce((sum, price) => sum + price, 0) / windowSlice.length;

    // 2. Calculate target limit prices
    const targetBid = parseFloat((sma - 1.00).toFixed(2));
    const targetAsk = parseFloat((sma + 1.00).toFixed(2));

    if (targetBid <= 0) return;

    // 3. Cancel previous resting quotes if supported by OrderBook
    if (this.orderBook && typeof this.orderBook.cancelOrder === 'function') {
      if (this.activeBidId) this.orderBook.cancelOrder(this.activeBidId);
      if (this.activeAskId) this.orderBook.cancelOrder(this.activeAskId);
    }

    // 4. Submit updated Limit Orders
    const bidResult = this.submitOrder('BUY', targetBid, this.orderQty, 'LIMIT');
    if (bidResult && bidResult.id) this.activeBidId = bidResult.id;

    const askResult = this.submitOrder('SELL', targetAsk, this.orderQty, 'LIMIT');
    if (askResult && askResult.id) this.activeAskId = askResult.id;
  }
}

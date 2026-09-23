// src/engine/OrderBook.js
export class OrderBook {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.bids = []; // Resting BUY limit orders
    this.asks = []; // Resting SELL limit orders
    this.lastPrice = 100.00;
  }

  processOrder({ playerId, side, price, qty, type }) {
    let remainingQty = qty;
    const effectivePrice = type === 'MARKET' ? (side === 'BUY' ? 999999 : 0.01) : price;
    const orderId = Math.random().toString(36).substr(2, 6);

    if (side === 'BUY') {
      this.asks.sort((a, b) => a.price - b.price);
      while (remainingQty > 0 && this.asks.length > 0 && this.asks[0].price <= effectivePrice) {
        const ask = this.asks[0];
        const fillQty = Math.min(remainingQty, ask.qty);
        const execPrice = ask.price;

        this.executeTrade(playerId, ask.playerId, execPrice, fillQty);

        ask.qty -= fillQty;
        remainingQty -= fillQty;
        if (ask.qty <= 0) this.asks.shift();
      }

      if (remainingQty > 0 && type === 'LIMIT') {
        const order = { id: orderId, playerId, price: effectivePrice, qty: remainingQty };
        this.bids.push(order);
        this.bids.sort((a, b) => b.price - a.price);
        return order;
      }
    } else if (side === 'SELL') {
      this.bids.sort((a, b) => b.price - a.price);
      while (remainingQty > 0 && this.bids.length > 0 && this.bids[0].price >= effectivePrice) {
        const bid = this.bids[0];
        const fillQty = Math.min(remainingQty, bid.qty);
        const execPrice = bid.price;

        this.executeTrade(bid.playerId, playerId, execPrice, fillQty);

        bid.qty -= fillQty;
        remainingQty -= fillQty;
        if (bid.qty <= 0) this.bids.shift();
      }

      if (remainingQty > 0 && type === 'LIMIT') {
        const order = { id: orderId, playerId, price: effectivePrice, qty: remainingQty };
        this.asks.push(order);
        this.asks.sort((a, b) => a.price - b.price);
        return order;
      }
    }
  }

  executeTrade(buyerId, sellerId, price, qty) {
    this.lastPrice = price;
    if (this.eventBus) {
      this.eventBus.emit('TRADE_EXECUTED', { buyerId, sellerId, price, qty });
    }
  }

  cancelOrder(orderId) {
    this.bids = this.bids.filter(o => o.id !== orderId);
    this.asks = this.asks.filter(o => o.id !== orderId);
  }

  getMidPrice() {
    if (this.bids.length > 0 && this.asks.length > 0) {
      return parseFloat(((this.bids[0].price + this.asks[0].price) / 2).toFixed(2));
    }
    return this.lastPrice;
  }
}

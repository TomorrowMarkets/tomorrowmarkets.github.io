export class OrderBook {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.bids = [];
    this.asks = [];
    this.lastPrice = 100.00;
  }

  getMidPrice() {
    if (this.bids.length > 0 && this.asks.length > 0) {
      return (this.bids[0].price + this.asks[0].price) / 2;
    }
    if (this.bids.length > 0) return this.bids[0].price;
    if (this.asks.length > 0) return this.asks[0].price;
    return this.lastPrice || 100.00;
  }

  processOrder(order) {
    const { playerId, side, price, qty, type } = order;

    if (type === 'MARKET') {
      this.executeMarketOrder(playerId, side, qty);
    } else {
      this.executeLimitOrder(playerId, side, price, qty);
    }
  }

  executeMarketOrder(playerId, side, qty) {
    let remainingQty = qty;
    const targetBook = side === 'BUY' ? this.asks : this.bids;

    while (remainingQty > 0 && targetBook.length > 0) {
      const topOrder = targetBook[0];
      const execQty = Math.min(remainingQty, topOrder.qty);
      const execPrice = topOrder.price;

      this.lastPrice = execPrice;
      remainingQty -= execQty;
      topOrder.qty -= execQty;

      const trade = {
        buyerId: side === 'BUY' ? playerId : topOrder.playerId,
        sellerId: side === 'SELL' ? playerId : topOrder.playerId,
        price: execPrice,
        qty: execQty
      };

      if (this.eventBus) this.eventBus.emit('TRADE', trade);

      if (topOrder.qty <= 0) {
        targetBook.shift();
      }
    }
  }

  executeLimitOrder(playerId, side, price, qty) {
    let remainingQty = qty;

    if (side === 'BUY') {
      while (remainingQty > 0 && this.asks.length > 0 && this.asks[0].price <= price) {
        const topAsk = this.asks[0];
        const execQty = Math.min(remainingQty, topAsk.qty);
        const execPrice = topAsk.price;

        this.lastPrice = execPrice;
        remainingQty -= execQty;
        topAsk.qty -= execQty;

        const trade = {
          buyerId: playerId,
          sellerId: topAsk.playerId,
          price: execPrice,
          qty: execQty
        };

        if (this.eventBus) this.eventBus.emit('TRADE', trade);

        if (topAsk.qty <= 0) {
          this.asks.shift();
        }
      }

      if (remainingQty > 0) {
        this.bids.push({ id: Math.random().toString(), playerId, price, qty: remainingQty });
        this.bids.sort((a, b) => b.price - a.price);
      }
    } else {
      while (remainingQty > 0 && this.bids.length > 0 && this.bids[0].price >= price) {
        const topBid = this.bids[0];
        const execQty = Math.min(remainingQty, topBid.qty);
        const execPrice = topBid.price;

        this.lastPrice = execPrice;
        remainingQty -= execQty;
        topBid.qty -= execQty;

        const trade = {
          buyerId: topBid.playerId,
          sellerId: playerId,
          price: execPrice,
          qty: execQty
        };

        if (this.eventBus) this.eventBus.emit('TRADE', trade);

        if (topBid.qty <= 0) {
          this.bids.shift();
        }
      }

      if (remainingQty > 0) {
        this.asks.push({ id: Math.random().toString(), playerId, price, qty: remainingQty });
        this.asks.sort((a, b) => a.price - b.price);
      }
    }
  }
}

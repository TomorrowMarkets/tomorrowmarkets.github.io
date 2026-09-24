// src/engine/OrderBook.js
// Price-time priority limit order book. Emits a TRADE event on the event bus
// for every fill. An id index makes cancels O(log n) so a thousand bots can
// cancel and re-quote every tick.

const round2 = (n) => Math.round(n * 100) / 100;

export class OrderBook {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.bids = []; // best (highest) first
    this.asks = []; // best (lowest) first
    this.index = new Map(); // orderId -> { order, side }
    this.lastPrice = 100.0;
    this.currentTick = 0;
    this.seq = 0;
    this.nextExpiry = Infinity;
  }

  nextId(prefix = 'o') {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  bestBid() { return this.bids.length ? this.bids[0].price : null; }
  bestAsk() { return this.asks.length ? this.asks[0].price : null; }

  // Mid of the best bid and ask. If one side is empty the "mid" would jump to
  // the other side's best price, so fall back to the last trade instead.
  getMidPrice() {
    if (this.bids.length > 0 && this.asks.length > 0) return (this.bids[0].price + this.asks[0].price) / 2;
    return this.lastPrice || 100.0;
  }

  // Aggregated price levels, best first: [{ price, qty }]
  levels(side, depth) {
    const orders = side === 'BUY' ? this.bids : this.asks;
    const out = [];
    for (const o of orders) {
      const last = out[out.length - 1];
      if (last && last.price === o.price) last.qty += o.qty;
      else if (out.length === depth) break;
      else out.push({ price: o.price, qty: o.qty });
    }
    return out;
  }

  // ---- book maintenance -------------------------------------------------

  insert(side, order) {
    const book = side === 'BUY' ? this.bids : this.asks;
    const isBetter = side === 'BUY' ? (a, b) => a > b : (a, b) => a < b;
    let lo = 0;
    let hi = book.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (isBetter(order.price, book[m].price)) hi = m;
      else lo = m + 1;
    }
    book.splice(lo, 0, order);
    this.index.set(order.id, { order, side });
    if (order.expiresAt != null && order.expiresAt < this.nextExpiry) this.nextExpiry = order.expiresAt;
  }

  locate(book, side, order) {
    let lo = 0;
    let hi = book.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      const p = book[m].price;
      if (side === 'BUY' ? p > order.price : p < order.price) lo = m + 1;
      else hi = m;
    }
    for (let i = lo; i < book.length && book[i].price === order.price; i++) {
      if (book[i] === order) return i;
    }
    return book.indexOf(order);
  }

  has(orderId) {
    return this.index.has(orderId);
  }

  findOrder(orderId) {
    const e = this.index.get(orderId);
    return e ? { order: e.order, side: e.side } : null;
  }

  // Remove one resting order. If playerId is given it must own the order.
  removeOrder(orderId, playerId = null) {
    const e = this.index.get(orderId);
    if (!e || (playerId != null && e.order.playerId !== playerId)) return null;
    const book = e.side === 'BUY' ? this.bids : this.asks;
    const i = this.locate(book, e.side, e.order);
    if (i !== -1) book.splice(i, 1);
    this.index.delete(orderId);
    return { order: e.order, side: e.side };
  }

  cancelOrder(orderId, playerId = null) {
    return this.removeOrder(orderId, playerId) !== null;
  }

  clearPlayerOrders(playerId) {
    const keep = (o) => {
      if (o.playerId !== playerId) return true;
      this.index.delete(o.id);
      return false;
    };
    this.bids = this.bids.filter(keep);
    this.asks = this.asks.filter(keep);
  }

  expireOrders(tick) {
    if (tick < this.nextExpiry) return;
    let next = Infinity;
    const keep = (o) => {
      if (o.expiresAt != null && o.expiresAt <= tick) {
        this.index.delete(o.id);
        return false;
      }
      if (o.expiresAt != null && o.expiresAt < next) next = o.expiresAt;
      return true;
    };
    this.bids = this.bids.filter(keep);
    this.asks = this.asks.filter(keep);
    this.nextExpiry = next;
  }

  getPlayerOpenOrders(playerId) {
    return [
      ...this.bids.filter((b) => b.playerId === playerId).map((b) => ({ ...b, side: 'BUY' })),
      ...this.asks.filter((a) => a.playerId === playerId).map((a) => ({ ...a, side: 'SELL' }))
    ];
  }

  // ---- matching -----------------------------------------------------------

  // Returns { id, filledQty, avgPrice, restingQty } or null if the order was invalid.
  processOrder(order) {
    const { playerId, side } = order;
    const qty = Math.floor(order.qty);
    if (!(qty > 0)) return null;
    const id = order.id || this.nextId('b');

    if (order.type === 'MARKET') {
      const r = this.match(playerId, side, qty, null, id);
      return { id, ...r, restingQty: 0 };
    }

    const price = round2(order.price);
    if (!(price > 0)) return null;
    const r = this.match(playerId, side, qty, price, id);
    const restingQty = qty - r.filledQty;
    if (restingQty > 0) {
      this.insert(side, { id, playerId, price, qty: restingQty, expiresAt: order.expiresAt ?? null });
    }
    return { id, ...r, restingQty };
  }

  match(playerId, side, qty, limitPrice, orderId) {
    const book = side === 'BUY' ? this.asks : this.bids;
    let remaining = qty;
    let filled = 0;
    let notional = 0;

    while (remaining > 0 && book.length > 0) {
      const top = book[0];
      if (limitPrice != null && (side === 'BUY' ? top.price > limitPrice : top.price < limitPrice)) break;

      const execQty = Math.min(remaining, top.qty);
      const execPrice = top.price;
      remaining -= execQty;
      filled += execQty;
      notional += execQty * execPrice;
      top.qty -= execQty;
      if (top.qty <= 0) {
        book.shift();
        this.index.delete(top.id);
      }
      this.lastPrice = execPrice;

      if (this.eventBus) {
        this.eventBus.emit('TRADE', side === 'BUY'
          ? { buyerId: playerId, sellerId: top.playerId, price: execPrice, qty: execQty, buyOrderId: orderId, sellOrderId: top.id }
          : { buyerId: top.playerId, sellerId: playerId, price: execPrice, qty: execQty, buyOrderId: top.id, sellOrderId: orderId });
      }
    }
    return { filledQty: filled, avgPrice: filled ? notional / filled : 0 };
  }
}

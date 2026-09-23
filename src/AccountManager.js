
// src/AccountManager.js
export class AccountManager {
  constructor(eventBus, initialCash = 10000) {
    this.eventBus = eventBus;
    this.cash = initialCash;
    this.shares = 0;
    this.avgEntry = 0;
    this.realizedPnL = 0;

    if (this.eventBus) {
      this.eventBus.on('TRADE_EXECUTED', (trade) => this.onTradeExecuted(trade));
    }
  }

  onTradeExecuted({ buyerId, sellerId, price, qty, myId }) {
    const isBuyer = buyerId === myId;
    const isSeller = sellerId === myId;

    if (!isBuyer && !isSeller) return;

    if (isBuyer) {
      const cost = price * qty;
      this.cash -= cost;
      const totalShares = this.shares + qty;
      this.avgEntry = totalShares > 0 ? ((this.shares * this.avgEntry) + cost) / totalShares : 0;
      this.shares = totalShares;
    }

    if (isSeller) {
      this.cash += price * qty;
      const pnl = (price - this.avgEntry) * qty;
      this.realizedPnL += pnl;
      this.shares -= qty;
      if (this.shares === 0) this.avgEntry = 0;
    }

    if (this.eventBus) {
      this.eventBus.emit('PORTFOLIO_UPDATED', this.getMetrics());
    }
  }

  getMetrics(currentMidPrice = 100.00) {
    const posValue = this.shares * currentMidPrice;
    const unrealizedPnL = this.shares * (currentMidPrice - this.avgEntry);
    const totalEquity = this.cash + posValue;
    const totalPnL = totalEquity - 10000.00;

    return {
      cash: this.cash,
      shares: this.shares,
      avgEntry: this.avgEntry,
      posValue,
      unrealizedPnL,
      realizedPnL: this.realizedPnL,
      totalEquity,
      totalPnL
    };
  }
}

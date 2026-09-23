export class AccountManager {
  constructor(eventBus, playerId = 'Trader_1') {
    this.eventBus = eventBus;
    this.playerId = playerId;
    this.cash = 10000.00;
    this.shares = 0;
    this.avgEntry = 0.00;
    this.realizedPnL = 0.00;

    if (this.eventBus) {
      this.eventBus.on('TRADE', (trade) => this.onTrade(trade));
    }
  }

  setPlayerId(id) {
    this.playerId = id;
  }

  onTrade(trade) {
    const { buyerId, sellerId, price, qty } = trade;
    let updated = false;

    if (buyerId === this.playerId) {
      const cost = price * qty;
      this.cash -= cost;
      const totalCost = (this.shares * this.avgEntry) + cost;
      this.shares += qty;
      this.avgEntry = this.shares > 0 ? totalCost / this.shares : 0;
      updated = true;
    }

    if (sellerId === this.playerId) {
      const revenue = price * qty;
      this.cash += revenue;
      const pnl = (price - this.avgEntry) * qty;
      this.realizedPnL += pnl;
      this.shares -= qty;
      if (this.shares <= 0) {
        this.shares = 0;
        this.avgEntry = 0;
      }
      updated = true;
    }

    if (updated && this.eventBus) {
      this.eventBus.emit('ACCOUNT_UPDATE', {
        cash: this.cash,
        shares: this.shares,
        avgEntry: this.avgEntry,
        realizedPnL: this.realizedPnL
      });
    }
  }
}

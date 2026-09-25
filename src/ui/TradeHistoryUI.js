// src/ui/TradeHistoryUI.js
// Fills the strategy panel in discretionary games: each of your own fills
// with its side, lot size, price and the PnL that fill realized.
//
// Trade PnL is the change in the account's realized PnL caused by the fill,
// so construct this AFTER the AccountManager: its TRADE listener must have
// applied the fill before this one reads the account (see initApp).
// Fills that only open or add to a position realize nothing and show "–".
const MAX_ROWS = 150;
const round2 = (n) => Math.round(n * 100) / 100;

export class TradeHistoryUI {
  constructor(eventBus, accountManager, getCurrentUserId) {
    this.accountManager = accountManager;
    this.getCurrentUserId = getCurrentUserId;
    this.list = document.getElementById('trade-history-list');
    this.summary = document.getElementById('trade-history-summary');
    this.rows = [];
    this.fills = 0;
    this.lastRealized = 0;
    this.simTime = '';

    eventBus.on('TICK', (d) => {
      if (d && d.simTimeStr) this.simTime = d.simTimeStr;
    });
    eventBus.on('TRADE', (t) => this.onTrade(t));
  }

  reset() {
    this.rows = [];
    this.fills = 0;
    this.lastRealized = this.accountManager.realizedPnL || 0;
    if (this.list) this.list.innerHTML = '<div class="empty">No fills yet this session</div>';
    this.renderSummary();
  }

  onTrade(t) {
    const me = this.getCurrentUserId();
    const bought = t.buyerId === me;
    const sold = t.sellerId === me;
    if (!bought && !sold) return;

    const realized = this.accountManager.realizedPnL || 0;
    const pnl = round2(realized - this.lastRealized);
    this.lastRealized = realized;
    this.fills += 1;

    const side = bought ? 'BUY' : 'SELL';
    const pnlText = pnl === 0 ? '–' : `${pnl > 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;
    const pnlClass = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 't-faint';
    this.rows.unshift(`
      <div class="row-card grid grid-cols-[1fr_1fr_1fr_1fr] items-center text-xs num">
        <span class="t-faint">${this.simTime}</span>
        <span class="flex items-center gap-1.5">
          <span class="chip ${bought ? 'chip-buy' : 'chip-sell'}">${side}</span>
          <span class="t-ink font-medium">${t.qty}</span>
        </span>
        <span class="text-right t-ink">$${t.price.toFixed(2)}</span>
        <span class="text-right font-semibold ${pnlClass}">${pnlText}</span>
      </div>`);
    if (this.rows.length > MAX_ROWS) this.rows.length = MAX_ROWS;
    if (this.list) this.list.innerHTML = this.rows.join('');
    this.renderSummary();
  }

  renderSummary() {
    if (!this.summary) return;
    const r = round2(this.accountManager.realizedPnL || 0);
    this.summary.textContent = `${this.fills} ${this.fills === 1 ? 'fill' : 'fills'} · realized ${r < 0 ? '-' : '+'}$${Math.abs(r).toFixed(2)}`;
  }
}

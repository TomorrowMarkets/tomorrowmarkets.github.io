// src/ui/AlgoActionLogUI.js
// Fills the strategy panel in algorithmic games: a status line for your own
// script (language, what it's doing, the current decision round), every
// trader's running PnL, and a shared log of the orders each strategy placed,
// with side, size and price. Your own print() output is shown only to you.
// Events on the eventBus:
//   ALGO_STATUS { playerId, language, status, detail }
//   ALGO_ROUND  { round, phase: 'waiting' | 'live', pending, total }
//   ALGO_LOG    { playerId, name, simTime, level, text }
//   TICK        carries standings: [{ id, total, name?, isAI? }], best first
const MAX_ROWS = 120;

const CHIPS = {
  buy: '<span class="chip chip-buy">BUY</span>',
  sell: '<span class="chip chip-sell">SELL</span>',
  error: '<span class="chip chip-sell">ERROR</span>',
  warn: '<span class="chip chip-gold">NOTE</span>',
  log: '<span class="chip chip-neutral">PRINT</span>'
};

const STATUS_TEXT = {
  idle: 'Waiting for the market',
  loading: 'Loading…',
  ready: 'Ready for the next round',
  running: 'Deciding…'
};

export class AlgoActionLogUI {
  constructor(eventBus, getCurrentUserId) {
    this.getCurrentUserId = getCurrentUserId;
    const $ = (id) => document.getElementById(id);
    this.strip = $('algo-status-strip');
    this.standings = $('algo-standings');
    this.list = $('algo-log-list');
    this.rows = [];
    this.status = null;
    this.round = null;
    this.live = false; // only algorithmic games show this panel

    eventBus.on('ALGO_STATUS', (s) => {
      if (s.playerId !== this.getCurrentUserId()) return;
      this.status = s;
      this.renderStrip();
    });
    eventBus.on('ALGO_ROUND', (r) => {
      this.round = r;
      this.renderStrip();
    });
    eventBus.on('ALGO_LOG', (e) => this.addRow(e));
    eventBus.on('TICK', (d) => {
      // Skipped while the panel is hidden or the tab is in the background,
      // so a discretionary game never pays for this.
      if (!this.live || document.hidden || !d || !d.standings) return;
      this.renderStandings(d.standings);
    });
  }

  // Called when a game starts; `live` is true only in algorithmic games.
  reset(live = false) {
    this.live = live;
    this.rows = [];
    this.round = null;
    if (this.standings) {
      this.standings.classList.add('hidden');
      this.standings.innerHTML = '';
    }
    if (this.list) this.list.innerHTML = '<div class="empty">No strategy orders yet. The first decision round comes a few sim-minutes after the open.</div>';
    this.renderStrip();
  }

  renderStrip() {
    if (!this.strip) return;
    const s = this.status;
    if (!s) {
      this.strip.classList.add('hidden');
      return;
    }
    this.strip.classList.remove('hidden');
    const dot = s.status === 'error' ? 'is-error' : s.status === 'running' ? 'is-running' : 'is-ready';
    const label = s.status === 'error' ? `Stopped: ${s.detail || 'see the log'}` : (STATUS_TEXT[s.status] || '');
    const r = this.round;
    const round = !r ? '' : r.phase === 'waiting'
      ? `Round ${r.round}: waiting on ${r.pending} of ${r.total} ${r.total === 1 ? 'strategy' : 'strategies'}`
      : `Round ${r.round} done, market running`;
    this.strip.innerHTML = `
      <span class="algo-status-dot ${dot}"></span>
      <span class="t-ink font-medium">${s.language === 'r' ? 'R' : 'Python'} strategy</span>
      <span class="t-muted truncate">${escapeHtml(label)}</span>
      ${round ? `<span class="ml-auto t-faint num shrink-0">${escapeHtml(round)}</span>` : ''}`;
  }

  // One chip per trader, best PnL first. Bots aren't in here: only the
  // humans (and Tomorrow AI) have accounts in the ledger.
  renderStandings(rows) {
    if (!this.standings || !rows.length) return;
    const me = this.getCurrentUserId();
    this.standings.classList.remove('hidden');
    this.standings.innerHTML = rows.map((st, i) => {
      const v = Math.round(st.total * 100) / 100;
      const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 't-faint';
      const isMe = st.id === me;
      return `<span class="algo-standing${isMe ? ' is-me' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="who">${escapeHtml(st.name || st.id)}${isMe ? ' <span class="t-faint" style="font-weight:400">(You)</span>' : ''}${st.isAI ? ' <span class="chip chip-gold">AI</span>' : ''}</span>
        <span class="pnl ${cls}">${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}</span>
      </span>`;
    }).join('');
  }

  addRow({ playerId, name, simTime, level, text }) {
    if (!this.list) return;
    const isMe = playerId === this.getCurrentUserId();
    this.rows.unshift(`
      <div class="row-card flex items-start justify-between gap-3 text-xs">
        <div class="min-w-0 flex items-start gap-2">
          ${CHIPS[level] || CHIPS.log}
          <div class="min-w-0">
            <span class="t-ink font-medium">${escapeHtml(name || playerId || 'Trader')}${isMe ? ' <span class="t-faint font-normal">(You)</span>' : ''}</span>
            <span class="t-muted num algo-log-text">${escapeHtml(text)}</span>
          </div>
        </div>
        <span class="t-faint num shrink-0">${escapeHtml(simTime || '')}</span>
      </div>`);
    if (this.rows.length > MAX_ROWS) this.rows.length = MAX_ROWS;
    this.list.innerHTML = this.rows.join('');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

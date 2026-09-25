// src/ui/AlgoActionLogUI.js
// Fills the strategy panel in algorithmic games: a status line for your own
// script (language, what it's doing, the current decision round) and a
// shared log of every order each strategy in the room placed, with side,
// size and price. Your own print() output is shown only to you.
// Events on the eventBus:
//   ALGO_STATUS { playerId, language, status, detail }
//   ALGO_ROUND  { round, phase: 'waiting' | 'live', pending, total }
//   ALGO_LOG    { playerId, name, simTime, level, text }
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
    this.list = $('algo-log-list');
    this.rows = [];
    this.status = null;
    this.round = null;

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
  }

  reset() {
    this.rows = [];
    this.round = null;
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

import { PeerNetwork } from './net/PeerNetwork.js';
import { OrderBook } from './engine/OrderBook.js';
import { BotFleet } from './engine/BotFleet.js';
import { TickAccumulator } from './engine/bars.js';
import { PriceChart } from './ui/PriceChart.js';
import { mountLobbyFacts } from './ui/lobby-facts.js';
import { createRunTracker, isConfigured as leaderboardLive } from './services/leaderboard-api.js';
import { BranchingDQN } from './engine/ai/brain.js';
import { createAgent, AI_ID, AI_NAME } from './engine/ai/RLTrader.js';
import { uploadExperience, syncEnabled } from './engine/ai/sync.js';
import { buildSnapshot } from './engine/algo/AlgoAPI.js';
import { AlgoLabUI } from './ui/AlgoLabUI.js';
import { AlgoActionLogUI } from './ui/AlgoActionLogUI.js';
import { TradeHistoryUI } from './ui/TradeHistoryUI.js';

// ===================================================================
// 0. SESSION CONSTANTS & SHARED HELPERS
// ===================================================================
const SESSION_OPEN_SECS = 9 * 3600 + 30 * 60; // 09:30:00 AM
const SESSION_CLOSE_SECS = 18 * 3600;         // 06:00:00 PM
const SIM_SECS_PER_TICK = 15;
const GAME_DURATION_MINUTES = 10;             // real-world length of the whole trading day
const TOTAL_TICKS = (SESSION_CLOSE_SECS - SESSION_OPEN_SECS) / SIM_SECS_PER_TICK; // 2040
const STARTING_CASH = 10000;
const BOOK_LEVELS = 15;             // price levels per side shown in the order book (and sent to clients)
const MAX_BACKLOG_TICKS = 40;       // a stall longer than this pauses the day instead of fast-forwarding it
const NOISE_ORDER_TTL_TICKS = 40;   // noise-bot limit orders expire after 10 sim-minutes (keeps the book small)

const HUMAN_ACTIONS = new Set(['SUBMIT_ORDER', 'CANCEL_ORDER', 'MODIFY_ORDER', 'MODIFY_BRACKET', 'CANCEL_BRACKET', 'CANCEL_ALL']);

// Algorithmic games: the market pauses for a decision round every
// ALGO_DECISION_EVERY_TICKS ticks (20 ticks = 5 sim-minutes, ~100 rounds a
// day) and waits up to ALGO_DECISION_TIMEOUT_MS for every strategy. Each
// strategy's own budget is 60 s (see AlgoRunner); the extra 5 s covers the
// network round trip for players in a room.
const ALGO_DECISION_EVERY_TICKS = 20;
const ALGO_DECISION_TIMEOUT_MS = 65000;
const REOPEN_LAB_KEY = 'tomorrowMarkets.reopenAlgoLab';

const round2 = (n) => Math.round(n * 100) / 100;

function fmtMoney(n) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSigned(n) {
  const v = round2(n);
  return `${v < 0 ? '-' : '+'}${fmtMoney(v)}`;
}

function fmtPct(n) {
  const v = round2(n);
  return `${v < 0 ? '' : '+'}${v.toFixed(2)}%`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatSimTime(totalSecs) {
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(h12)}:${pad(mins)}:${pad(secs)} ${hours >= 12 ? 'PM' : 'AM'}`;
}

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
}

// Letters (incl. æøå), digits, space, dot, dash, underscore. Keeps handles safe and
// guarantees nobody can collide with an internal bot id (those contain a colon).
function sanitizeHandle(raw) {
  const clean = String(raw || '').replace(/[^\p{L}\p{N}_\- .]/gu, '').trim().slice(0, 16);
  return clean || 'Trader';
}

// '' / null -> null (no level). Valid positive number -> rounded to cents. Anything else -> NaN.
function parseOptionalPrice(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? round2(n) : NaN;
}

// entrySide: the side of the order that OPENS the exposure (BUY = long, SELL = short).
function validateBracket(entrySide, ref, sl, tp, { dir, refLabel }) {
  if (Number.isNaN(sl)) return 'Stop loss must be a price above $0, or left empty.';
  if (Number.isNaN(tp)) return 'Take profit must be a price above $0, or left empty.';
  const isLong = entrySide === 'BUY';
  const refStr = fmtMoney(ref);
  if (sl != null && (isLong ? sl >= ref : sl <= ref)) {
    return `For a ${dir}, the stop loss must be ${isLong ? 'below' : 'above'} ${refLabel} (${refStr}).`;
  }
  if (tp != null && (isLong ? tp <= ref : tp >= ref)) {
    return `For a ${dir}, the take profit must be ${isLong ? 'above' : 'below'} ${refLabel} (${refStr}).`;
  }
  return null;
}

// ===================================================================
// 1. EVENT BUS
// ===================================================================
class EventBus {
  constructor() {
    this.listeners = {};
  }
  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }
  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => cb(data));
    }
  }
}

// ===================================================================
// 2. ACCOUNTS
// Account      = pure position/PnL state for one trader.
// AccountManager = the local player's account, wired to the UI.
// Ledger       = every human trader's account; only used by the authority
//                (host / single player) for validation, SL/TP and rankings.
// ===================================================================
class Account {
  constructor(playerId, cash = STARTING_CASH) {
    this.playerId = playerId;
    this.cash = cash;
    this.shares = 0;
    this.avgEntry = 0.0;
    this.realizedPnL = 0.0;
  }

  applyTrade(trade) {
    let touched = false;
    if (trade.buyerId === this.playerId) {
      this.applyBuy(trade.price, trade.qty);
      touched = true;
    }
    if (trade.sellerId === this.playerId) {
      this.applySell(trade.price, trade.qty);
      touched = true;
    }
    return touched;
  }

  applyBuy(price, qty) {
    let remainingQty = qty;
    if (this.shares < 0) {
      const coverQty = Math.min(remainingQty, Math.abs(this.shares));
      const pnl = (this.avgEntry - price) * coverQty;
      this.realizedPnL += pnl;
      this.cash += coverQty * this.avgEntry + pnl;
      this.shares += coverQty;
      if (this.shares === 0) this.avgEntry = 0;
      remainingQty -= coverQty;
    }
    if (remainingQty > 0) {
      const cost = price * remainingQty;
      this.cash -= cost;
      const totalCost = this.shares * this.avgEntry + cost;
      this.shares += remainingQty;
      this.avgEntry = this.shares > 0 ? totalCost / this.shares : 0;
    }
  }

  applySell(price, qty) {
    let remainingQty = qty;
    if (this.shares > 0) {
      const closeQty = Math.min(remainingQty, this.shares);
      const pnl = (price - this.avgEntry) * closeQty;
      this.realizedPnL += pnl;
      this.cash += closeQty * this.avgEntry + pnl;
      this.shares -= closeQty;
      if (this.shares === 0) this.avgEntry = 0;
      remainingQty -= closeQty;
    }
    if (remainingQty > 0) {
      const shortCost = price * remainingQty;
      this.cash -= shortCost;
      const currentShortQty = Math.abs(this.shares);
      const totalShortVal = currentShortQty * this.avgEntry + shortCost;
      this.shares -= remainingQty;
      this.avgEntry = Math.abs(this.shares) > 0 ? totalShortVal / Math.abs(this.shares) : 0;
    }
  }

  unrealized(mid) {
    if (this.shares > 0) return this.shares * (mid - this.avgEntry);
    if (this.shares < 0) return Math.abs(this.shares) * (this.avgEntry - mid);
    return 0;
  }

  totalPnL(mid) {
    return this.realizedPnL + this.unrealized(mid);
  }

  // How many shares an exit order on `exitSide` can close without flipping the position.
  closable(exitSide) {
    return exitSide === 'SELL' ? Math.max(0, this.shares) : Math.max(0, -this.shares);
  }

  canPlaceOrder(side, type, price, qty, currentMidPrice = 100) {
    const execPrice = type === 'MARKET' ? currentMidPrice : price;
    const orderCost = execPrice * qty;

    if (side === 'BUY') {
      if (this.shares >= 0) {
        if (this.cash < orderCost) {
          return { allowed: false, reason: `Insufficient capital (${fmtMoney(this.cash)}) to buy ${qty} shares (${fmtMoney(orderCost)}).` };
        }
      } else {
        const shortQtyToCover = Math.min(qty, Math.abs(this.shares));
        const flipCost = (qty - shortQtyToCover) * execPrice;
        if (flipCost > 0 && this.cash < flipCost) {
          return { allowed: false, reason: `Insufficient capital (${fmtMoney(this.cash)}) to open a long position.` };
        }
      }
    } else if (side === 'SELL') {
      if (this.shares <= 0) {
        if (this.cash < orderCost) {
          return { allowed: false, reason: `Insufficient capital (${fmtMoney(this.cash)}) to short sell ${qty} shares (${fmtMoney(orderCost)}).` };
        }
      } else {
        const longQtyToClose = Math.min(qty, this.shares);
        const flipCost = (qty - longQtyToClose) * execPrice;
        if (flipCost > 0 && this.cash < flipCost) {
          return { allowed: false, reason: `Insufficient capital (${fmtMoney(this.cash)}) to open a short position.` };
        }
      }
    }
    return { allowed: true };
  }

  snapshot() {
    return { cash: this.cash, shares: this.shares, avgEntry: this.avgEntry, realizedPnL: this.realizedPnL };
  }
}

class AccountManager extends Account {
  constructor(eventBus, playerId = 'Trader_1') {
    super(playerId);
    this.eventBus = eventBus;
    if (this.eventBus) {
      this.eventBus.on('TRADE', (trade) => {
        if (this.applyTrade(trade)) this.broadcastState();
      });
    }
  }

  setPlayerId(id) {
    this.playerId = id;
    this.broadcastState();
  }

  broadcastState() {
    if (this.eventBus) this.eventBus.emit('ACCOUNT_UPDATE', this.snapshot());
  }
}

class Ledger {
  constructor(eventBus) {
    this.accounts = new Map();
    eventBus.on('TRADE', (t) => {
      const buyer = this.accounts.get(t.buyerId);
      if (buyer) buyer.applyBuy(t.price, t.qty);
      const seller = this.accounts.get(t.sellerId);
      if (seller) seller.applySell(t.price, t.qty);
    });
  }

  register(id) {
    if (!this.accounts.has(id)) this.accounts.set(id, new Account(id));
    return this.accounts.get(id);
  }

  has(id) { return this.accounts.has(id); }
  get(id) { return this.accounts.get(id); }
  ids() { return [...this.accounts.keys()]; }

  standings(mid) {
    return [...this.accounts.values()]
      .map((a) => ({
        id: a.playerId,
        realized: a.realizedPnL,
        unrealized: a.unrealized(mid),
        total: a.totalPnL(mid),
        shares: a.shares
      }))
      .sort((x, y) => y.total - x.total);
  }
}

// ===================================================================
// 3. ORDER BOOK: see ./engine/OrderBook.js
// ===================================================================

// ===================================================================
// 4. STOP LOSS / TAKE PROFIT (authority only)
// An entry order may carry sl/tp levels. Every fill of that order adds
// shares to a "bracket" (id = entry order id). Each game step the bracket
// is checked against the mid price; when SL or TP is hit, the whole
// bracket closes with a market order (one-cancels-other).
// ===================================================================
class BracketManager {
  constructor(orderBook, ledger, notify) {
    this.orderBook = orderBook;
    this.ledger = ledger;
    this.notify = notify;
    this.meta = new Map();   // working entry orderId -> { playerId, side, sl, tp }
    this.active = new Map(); // bracketId (= entry orderId) -> { id, playerId, exitSide, qty, sl, tp }
  }

  onTrade(t) {
    this.attach(t.buyOrderId, t.qty);
    this.attach(t.sellOrderId, t.qty);
  }

  attach(orderId, qty) {
    const m = this.meta.get(orderId);
    if (!m) return;
    let br = this.active.get(orderId);
    if (!br) {
      br = { id: orderId, playerId: m.playerId, exitSide: m.side === 'BUY' ? 'SELL' : 'BUY', qty: 0, sl: m.sl, tp: m.tp };
      this.active.set(orderId, br);
    }
    br.qty += qty;
  }

  setOrderLevels(orderId, playerId, side, sl, tp) {
    if (sl == null && tp == null) this.meta.delete(orderId);
    else this.meta.set(orderId, { playerId, side, sl, tp });
  }

  getOrderLevels(orderId) {
    return this.meta.get(orderId) || null;
  }

  dropOrder(orderId) {
    this.meta.delete(orderId);
  }

  get(id) {
    return this.active.get(id) || null;
  }

  syncLevels(id, sl, tp) {
    const br = this.active.get(id);
    if (!br) return;
    if (sl == null && tp == null) this.active.delete(id);
    else {
      br.sl = sl;
      br.tp = tp;
    }
  }

  remove(id, playerId) {
    const br = this.active.get(id);
    if (!br || br.playerId !== playerId) return false;
    this.active.delete(id);
    this.meta.delete(id); // also stop protecting any further fills of the entry order
    return true;
  }

  clear() {
    this.meta.clear();
    this.active.clear();
  }

  evaluate() {
    for (const id of [...this.meta.keys()]) {
      if (!this.orderBook.findOrder(id)) this.meta.delete(id);
    }

    for (const br of [...this.active.values()]) {
      if (!this.active.has(br.id)) continue;
      const acct = this.ledger.get(br.playerId);
      const closable = acct ? acct.closable(br.exitSide) : 0;
      const parentWorking = this.orderBook.findOrder(br.id) !== null;

      // Position was (partly) closed by hand: never let SL/TP flip it the other way.
      br.qty = Math.min(br.qty, closable);
      if (closable <= 0) {
        if (!parentWorking) this.active.delete(br.id);
        continue;
      }

      const mid = this.orderBook.getMidPrice();
      const isLong = br.exitSide === 'SELL';
      const slHit = br.sl != null && (isLong ? mid <= br.sl : mid >= br.sl);
      const tpHit = !slHit && br.tp != null && (isLong ? mid >= br.tp : mid <= br.tp);
      if (!slHit && !tpHit) continue;

      this.active.delete(br.id);
      let extra = '';
      if (parentWorking) {
        this.orderBook.cancelOrder(br.id, br.playerId);
        this.meta.delete(br.id);
        extra = ' The rest of the entry order was cancelled.';
      }

      const res = this.orderBook.processOrder({
        id: this.orderBook.nextId('x'),
        playerId: br.playerId,
        side: br.exitSide,
        type: 'MARKET',
        qty: br.qty
      });

      const label = slHit ? 'Stop loss' : 'Take profit';
      const verb = br.exitSide === 'SELL' ? 'sold' : 'bought';
      if (res && res.filledQty > 0) {
        const partial = res.filledQty < br.qty ? ` (only ${res.filledQty} of ${br.qty}, the book was thin)` : '';
        this.notify(br.playerId, `${label} triggered: ${verb} ${res.filledQty} @ ${fmtMoney(res.avgPrice)}${partial}.${extra}`, slHit ? 'warn' : 'success');
      } else {
        this.notify(br.playerId, `${label} triggered, but there were no orders to trade against.${extra}`, 'warn');
      }
    }
  }

  byPlayer() {
    const out = {};
    for (const br of this.active.values()) {
      const acct = this.ledger.get(br.playerId);
      const qty = Math.min(br.qty, acct ? acct.closable(br.exitSide) : 0);
      if (qty <= 0) continue;
      (out[br.playerId] ||= []).push({ id: br.id, exitSide: br.exitSide, qty, sl: br.sl, tp: br.tp });
    }
    return out;
  }
}

// ===================================================================
// 5. BOTS: see ./engine/bots.js (strategies) and ./engine/BotFleet.js
//    (population, daily schedule, US-open event)
// ===================================================================

// ===================================================================
// 6. UI COMPONENTS
// ===================================================================
function createToaster(container) {
  return (text, level = 'info') => {
    if (!container) {
      console.log(`[${level}] ${text}`);
      return;
    }
    while (container.children.length >= 4) container.firstChild.remove();
    const el = document.createElement('div');
    el.className = `toast toast-${['success', 'warn', 'error', 'news'].includes(level) ? level : 'info'}`;
    el.setAttribute('role', level === 'error' ? 'alert' : 'status');
    el.textContent = text;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 4000);
  };
}

class BookUI {
  constructor(eventBus) {
    this.asksContainer = document.getElementById('asks-container');
    this.bidsContainer = document.getElementById('bids-container');
    this.midDisplay = document.getElementById('mid-price-display');
    this.spreadDisplay = document.getElementById('spread-display');
    this.last = null;

    eventBus.on('TICK', (data) => {
      this.last = data;
      if (!document.hidden) this.render(data.bids, data.asks, data.midPrice);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.last) this.render(this.last.bids, this.last.asks, this.last.midPrice);
    });
  }

  // bids / asks arrive as aggregated price levels, best first: [{ price, qty }]
  render(bids = [], asks = [], midPrice = 100.0) {
    if (this.midDisplay) this.midDisplay.innerText = '$' + midPrice.toFixed(2);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    if (this.spreadDisplay) this.spreadDisplay.innerText = '$' + (bestAsk && bestBid ? (bestAsk - bestBid).toFixed(2) : '0.00');

    // Depth bars are scaled to the largest level currently on screen.
    const maxQty = Math.max(1, ...bids.slice(0, BOOK_LEVELS).map((l) => l.qty), ...asks.slice(0, BOOK_LEVELS).map((l) => l.qty));
    const row = (lvl, side) => {
      if (!lvl) return '<div class="lvl"></div>';
      const depth = ((lvl.qty / maxQty) * 100).toFixed(1);
      const total = Math.round(lvl.price * lvl.qty).toLocaleString('en-US');
      return `<div class="lvl lvl-${side}" style="--d:${depth}%"><span>$${lvl.price.toFixed(2)}</span><span>${lvl.qty}</span><span>${total}</span></div>`;
    };

    if (this.asksContainer) {
      // Worst ask at the top, best ask next to the spread; empty slots pad the top.
      const slots = [];
      for (let i = BOOK_LEVELS - 1; i >= 0; i--) slots.push(row(asks[i], 'ask'));
      this.asksContainer.innerHTML = slots.join('');
    }
    if (this.bidsContainer) {
      const slots = [];
      for (let i = 0; i < BOOK_LEVELS; i++) slots.push(row(bids[i], 'bid'));
      this.bidsContainer.innerHTML = slots.join('');
    }
  }
}

// The price chart lives in ./ui/PriceChart.js

const MINI_TONES = { neutral: 'mini', danger: 'mini mini-danger', primary: 'mini mini-primary' };

function actionBtn(action, id, label, tone = 'neutral') {
  return `<button type="button" data-action="${action}" data-id="${escapeHtml(id)}" class="${MINI_TONES[tone]}">${label}</button>`;
}

function levelTags(sl, tp) {
  const tags = [];
  if (sl != null) tags.push(`<span class="t-ask">SL $${sl.toFixed(2)}</span>`);
  if (tp != null) tags.push(`<span class="t-bid">TP $${tp.toFixed(2)}</span>`);
  return tags.length ? `<div class="mt-1 flex gap-3 text-[10.5px] num">${tags.join('')}</div>` : '';
}

function editFields(fields) {
  return `<div class="grid grid-cols-2 gap-1.5 mt-2">${fields.map((f) => `
    <label class="block">
      <span class="block text-[10px] t-muted mb-0.5">${f.label}</span>
      <input data-field="${f.name}" type="number" inputmode="decimal" step="${f.step || '0.01'}" min="0" value="${f.value ?? ''}" placeholder="${f.placeholder || ''}"
        class="field field-sm num" />
    </label>`).join('')}</div>`;
}

class ControlsUI {
  constructor(eventBus, accountManager, getCurrentUserId, toast) {
    this.eventBus = eventBus;
    this.accountManager = accountManager;
    this.getCurrentUserId = getCurrentUserId;
    this.toast = toast;
    this.orderType = 'LIMIT';
    this.lastMidPrice = 100.0;
    this.marketOpen = false;

    this.myOrders = [];
    this.myBrackets = [];
    this.editing = null; // { kind: 'order' | 'bracket', id }
    this.ordersSig = null;
    this.bracketsSig = null;

    const $ = (id) => document.getElementById(id);
    this.typeLimitBtn = $('type-limit-btn');
    this.typeMarketBtn = $('type-market-btn');
    this.priceContainer = $('price-input-container');
    this.priceInput = $('order-price');
    this.qtyInput = $('order-qty');
    this.slInput = $('order-sl');
    this.tpInput = $('order-tp');
    this.btnBuy = $('btn-buy');
    this.btnSell = $('btn-sell');

    this.portCash = $('port-cash');
    this.portShares = $('port-shares');
    this.portAvgPrice = $('port-avg-price');
    this.portPosVal = $('port-pos-val');
    this.portUnrealized = $('port-unrealized');
    this.portRealized = $('port-realized');

    this.openOrdersList = $('open-orders-list');
    this.openOrdersCount = $('open-orders-count');
    this.bracketsList = $('brackets-list');
    this.bracketsCount = $('brackets-count');

    this.initListeners();
  }

  initListeners() {
    if (this.typeLimitBtn) this.typeLimitBtn.addEventListener('click', () => this.setOrderType('LIMIT'));
    if (this.typeMarketBtn) this.typeMarketBtn.addEventListener('click', () => this.setOrderType('MARKET'));
    if (this.btnBuy) this.btnBuy.addEventListener('click', () => this.submitOrder('BUY'));
    if (this.btnSell) this.btnSell.addEventListener('click', () => this.submitOrder('SELL'));

    for (const list of [this.openOrdersList, this.bracketsList]) {
      if (!list) continue;
      list.addEventListener('click', (e) => this.onListClick(e));
      list.addEventListener('keydown', (e) => this.onListKeydown(e));
    }

    this.eventBus.on('ACCOUNT_UPDATE', (acc) => this.renderAccount(acc));
    this.eventBus.on('MARKET_STATE', ({ open }) => this.setMarketOpen(open));
    this.eventBus.on('TICK', (data) => {
      this.lastMidPrice = data.midPrice;
      this.updateUnrealizedPnL(data.midPrice);
      const me = this.getCurrentUserId();
      this.myOrders = (data.playerOrders && data.playerOrders[me]) || [];
      this.myBrackets = (data.brackets && data.brackets[me]) || [];
      this.renderOpenOrders();
      this.renderBrackets();
    });
  }

  send(action) {
    this.eventBus.emit('USER_ACTION', action);
  }

  setMarketOpen(open) {
    this.marketOpen = open;
    for (const btn of [this.btnBuy, this.btnSell]) {
      if (btn) btn.disabled = !open;
    }
    if (!open) {
      this.editing = null;
      this.renderAll(true);
    }
  }

  setOrderType(type) {
    this.orderType = type;
    if (this.typeMarketBtn) this.typeMarketBtn.classList.toggle('is-active', type === 'MARKET');
    if (this.typeLimitBtn) this.typeLimitBtn.classList.toggle('is-active', type !== 'MARKET');
    if (this.priceContainer) this.priceContainer.classList.toggle('opacity-40', type === 'MARKET');
    if (this.priceContainer) this.priceContainer.classList.toggle('pointer-events-none', type === 'MARKET');
  }

  submitOrder(side) {
    if (!this.marketOpen) {
      this.toast('The market is closed.', 'warn');
      return;
    }
    const qty = Math.floor(Number(this.qtyInput ? this.qtyInput.value : 10));
    if (!(qty >= 1)) {
      this.toast('Enter a quantity of at least 1.', 'error');
      return;
    }
    const isMarket = this.orderType === 'MARKET';
    const price = isMarket ? 0 : parseOptionalPrice(this.priceInput ? this.priceInput.value : '');
    if (!isMarket && !(price > 0)) {
      this.toast('Enter a limit price above $0.', 'error');
      return;
    }
    const sl = parseOptionalPrice(this.slInput ? this.slInput.value : '');
    const tp = parseOptionalPrice(this.tpInput ? this.tpInput.value : '');
    const err = validateBracket(side, isMarket ? this.lastMidPrice : price, sl, tp, {
      dir: side === 'BUY' ? 'buy' : 'sell',
      refLabel: isMarket ? 'the current price' : 'your limit price'
    });
    if (err) {
      this.toast(err, 'error');
      return;
    }
    const check = this.accountManager.canPlaceOrder(side, this.orderType, price, qty, this.lastMidPrice);
    if (!check.allowed) {
      this.toast(`Order rejected: ${check.reason}`, 'error');
      return;
    }

    this.send({ type: 'SUBMIT_ORDER', order: { side, type: this.orderType, price, qty, sl, tp } });
    if (this.slInput) this.slInput.value = '';
    if (this.tpInput) this.tpInput.value = '';
  }

  // ---- Working orders & SL/TP lists -------------------------------------

  onListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    switch (action) {
      case 'cancel-order':
        if (this.editing && this.editing.id === id) this.editing = null;
        this.send({ type: 'CANCEL_ORDER', orderId: id });
        break;
      case 'edit-order':
        this.openEditor('order', id);
        break;
      case 'save-order':
        this.saveOrderEdit(id);
        break;
      case 'remove-bracket':
        if (this.editing && this.editing.id === id) this.editing = null;
        this.send({ type: 'CANCEL_BRACKET', bracketId: id });
        break;
      case 'edit-bracket':
        this.openEditor('bracket', id);
        break;
      case 'save-bracket':
        this.saveBracketEdit(id);
        break;
      case 'close-edit':
        this.editing = null;
        this.renderAll(true);
        break;
      default:
        break;
    }
  }

  onListKeydown(e) {
    if (!e.target.dataset || !e.target.dataset.field) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = e.target.closest('[data-row]');
      const save = row && row.querySelector('[data-action^="save-"]');
      if (save) save.click();
    } else if (e.key === 'Escape') {
      this.editing = null;
      this.renderAll(true);
    }
  }

  openEditor(kind, id) {
    this.editing = { kind, id };
    this.renderAll(true);
    const container = kind === 'order' ? this.openOrdersList : this.bracketsList;
    const first = container && container.querySelector('[data-editing] [data-field]');
    if (first) first.focus();
  }

  readEditor(container) {
    const row = container && container.querySelector('[data-editing]');
    const get = (name) => {
      const el = row && row.querySelector(`[data-field="${name}"]`);
      return el ? el.value : '';
    };
    return get;
  }

  saveOrderEdit(id) {
    const ord = this.myOrders.find((o) => o.id === id);
    if (!ord) {
      this.editing = null;
      this.renderAll(true);
      this.toast('That order already filled or was removed.', 'info');
      return;
    }
    const get = this.readEditor(this.openOrdersList);
    const price = parseOptionalPrice(get('price'));
    const qty = Math.floor(Number(get('qty')));
    if (!(price > 0)) return this.toast('Enter a limit price above $0.', 'error');
    if (!(qty >= 1)) return this.toast('Enter a quantity of at least 1.', 'error');
    const sl = parseOptionalPrice(get('sl'));
    const tp = parseOptionalPrice(get('tp'));
    const err = validateBracket(ord.side, price, sl, tp, { dir: ord.side === 'BUY' ? 'buy' : 'sell', refLabel: 'the limit price' });
    if (err) return this.toast(err, 'error');

    this.editing = null;
    this.send({ type: 'MODIFY_ORDER', orderId: id, changes: { price, qty, sl, tp } });
    this.renderAll(true);
  }

  saveBracketEdit(id) {
    const br = this.myBrackets.find((b) => b.id === id);
    if (!br) {
      this.editing = null;
      this.renderAll(true);
      this.toast('That position is already closed.', 'info');
      return;
    }
    const get = this.readEditor(this.bracketsList);
    const sl = parseOptionalPrice(get('sl'));
    const tp = parseOptionalPrice(get('tp'));
    if (sl != null || tp != null) {
      const entrySide = br.exitSide === 'SELL' ? 'BUY' : 'SELL';
      const err = validateBracket(entrySide, this.lastMidPrice, sl, tp, {
        dir: entrySide === 'BUY' ? 'long position' : 'short position',
        refLabel: 'the current price'
      });
      if (err) return this.toast(err, 'error');
    }
    this.editing = null;
    this.send({ type: 'MODIFY_BRACKET', bracketId: id, sl, tp });
    this.renderAll(true);
  }

  renderAll(force = false) {
    if (force) {
      this.ordersSig = null;
      this.bracketsSig = null;
    }
    this.renderOpenOrders();
    this.renderBrackets();
  }

  // Only rebuild the DOM when something actually changed. Rebuilding every tick
  // swallowed clicks on the Delete button and would wipe half-typed edits.
  replaceHtml(container, html) {
    const oldRow = container.querySelector('[data-editing]');
    const oldKey = oldRow ? oldRow.dataset.editing : null;
    const saved = {};
    if (oldRow) oldRow.querySelectorAll('[data-field]').forEach((el) => (saved[el.dataset.field] = el.value));
    const active = document.activeElement;
    const focusedField = active && container.contains(active) && active.dataset ? active.dataset.field : null;

    container.innerHTML = html;

    const newRow = container.querySelector('[data-editing]');
    if (newRow && oldKey && newRow.dataset.editing === oldKey) {
      for (const [field, value] of Object.entries(saved)) {
        const el = newRow.querySelector(`[data-field="${field}"]`);
        if (el) el.value = value;
      }
      if (focusedField) {
        const el = newRow.querySelector(`[data-field="${focusedField}"]`);
        if (el) el.focus();
      }
    }
  }

  renderOpenOrders() {
    if (!this.openOrdersList) return;
    if (this.editing && this.editing.kind === 'order' && !this.myOrders.some((o) => o.id === this.editing.id)) {
      this.editing = null;
      this.toast('That order filled or was removed while you were editing it.', 'info');
    }
    const sig = JSON.stringify([this.myOrders, this.editing]);
    if (sig === this.ordersSig) return;
    this.ordersSig = sig;

    if (this.openOrdersCount) this.openOrdersCount.innerText = this.myOrders.length;
    const html = this.myOrders.length === 0
      ? `<div class="empty">No active open orders</div>`
      : this.myOrders.map((o) => this.orderRow(o)).join('');
    this.replaceHtml(this.openOrdersList, html);
  }

  renderBrackets() {
    if (!this.bracketsList) return;
    if (this.editing && this.editing.kind === 'bracket' && !this.myBrackets.some((b) => b.id === this.editing.id)) {
      this.editing = null;
      this.toast('That position closed while you were editing it.', 'info');
    }
    const sig = JSON.stringify([this.myBrackets, this.editing]);
    if (sig === this.bracketsSig) return;
    this.bracketsSig = sig;

    if (this.bracketsCount) this.bracketsCount.innerText = this.myBrackets.length;
    const html = this.myBrackets.length === 0
      ? `<div class="empty">No stop loss or take profit on open positions</div>`
      : this.myBrackets.map((b) => this.bracketRow(b)).join('');
    this.replaceHtml(this.bracketsList, html);
  }

  orderRow(o) {
    const editing = this.editing && this.editing.kind === 'order' && this.editing.id === o.id;
    const header = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 num">
          <span class="chip ${o.side === 'BUY' ? 'chip-buy' : 'chip-sell'}">${o.side}</span>
          <span class="font-semibold t-ink">${o.qty}</span>
          <span class="t-faint">@</span>
          <span class="t-ink">$${o.price.toFixed(2)}</span>
        </div>
        ${editing ? '' : `<div class="flex gap-1">${actionBtn('edit-order', o.id, 'Edit')}${actionBtn('cancel-order', o.id, 'Delete', 'danger')}</div>`}
      </div>`;

    const body = editing
      ? editFields([
          { name: 'price', label: 'Limit price', value: o.price.toFixed(2) },
          { name: 'qty', label: 'Quantity', value: o.qty, step: '1' },
          { name: 'sl', label: 'Stop loss', value: o.sl != null ? o.sl.toFixed(2) : '', placeholder: 'None' },
          { name: 'tp', label: 'Take profit', value: o.tp != null ? o.tp.toFixed(2) : '', placeholder: 'None' }
        ]) + `<div class="flex justify-end gap-1 mt-2">${actionBtn('close-edit', o.id, 'Close')}${actionBtn('save-order', o.id, 'Save', 'primary')}</div>`
      : levelTags(o.sl, o.tp);

    return `<div data-row="${escapeHtml(o.id)}" ${editing ? `data-editing="order:${escapeHtml(o.id)}"` : ''} class="row-card${editing ? ' is-editing' : ''}">${header}${body}</div>`;
  }

  bracketRow(b) {
    const isLong = b.exitSide === 'SELL';
    const editing = this.editing && this.editing.kind === 'bracket' && this.editing.id === b.id;
    const header = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 num">
          <span class="chip ${isLong ? 'chip-buy' : 'chip-sell'}">${isLong ? 'LONG' : 'SHORT'}</span>
          <span class="font-semibold t-ink">${b.qty}</span>
          <span class="t-faint">shares</span>
        </div>
        ${editing ? '' : `<div class="flex gap-1">${actionBtn('edit-bracket', b.id, 'Edit')}${actionBtn('remove-bracket', b.id, 'Remove', 'danger')}</div>`}
      </div>`;

    const body = editing
      ? editFields([
          { name: 'sl', label: 'Stop loss', value: b.sl != null ? b.sl.toFixed(2) : '', placeholder: 'None' },
          { name: 'tp', label: 'Take profit', value: b.tp != null ? b.tp.toFixed(2) : '', placeholder: 'None' }
        ]) + `<div class="flex justify-end gap-1 mt-2">${actionBtn('close-edit', b.id, 'Close')}${actionBtn('save-bracket', b.id, 'Save', 'primary')}</div>`
      : levelTags(b.sl, b.tp);

    return `<div data-row="${escapeHtml(b.id)}" ${editing ? `data-editing="bracket:${escapeHtml(b.id)}"` : ''} class="row-card${editing ? ' is-editing' : ''}">${header}${body}</div>`;
  }

  // ---- Account panel -----------------------------------------------------

  renderAccount(acc) {
    if (!acc) return;
    if (this.portCash) this.portCash.innerText = fmtMoney(acc.cash);
    if (this.portShares) {
      this.portShares.innerText = acc.shares;
      this.portShares.className = acc.shares < 0 ? 'neg' : acc.shares > 0 ? 'pos' : '';
    }
    if (this.portAvgPrice) this.portAvgPrice.innerText = fmtMoney(acc.avgEntry);
    if (this.portRealized) {
      const r = acc.realizedPnL || 0;
      this.portRealized.innerText = fmtSigned(r);
      this.portRealized.className = round2(r) >= 0 ? 'pos' : 'neg';
    }
    this.updateUnrealizedPnL(this.lastMidPrice);
  }

  updateUnrealizedPnL(midPrice) {
    if (!this.accountManager || !midPrice) return;
    const acc = this.accountManager;
    const posVal = acc.shares * midPrice;
    const unrealized = acc.unrealized(midPrice);
    if (this.portPosVal) this.portPosVal.innerText = `${posVal < 0 ? '-' : ''}${fmtMoney(posVal)}`;
    if (this.portUnrealized) {
      this.portUnrealized.innerText = fmtSigned(unrealized);
      this.portUnrealized.className = round2(unrealized) >= 0 ? 'pos' : 'neg';
    }
  }
}

// This player's line in the final results (falls back to their own account
// if the host's standings don't include them).
function myStanding(results, me, fallbackAccount) {
  const standings = (results && results.standings) || [];
  const mine = standings.find((s) => s.id === me);
  if (mine) return mine;
  if (fallbackAccount && results) {
    return {
      id: me,
      realized: fallbackAccount.realizedPnL,
      unrealized: fallbackAccount.unrealized(results.finalPrice),
      total: fallbackAccount.totalPnL(results.finalPrice),
      shares: fallbackAccount.shares
    };
  }
  return { id: me, total: 0, realized: 0, unrealized: 0, shares: 0 };
}

class GameOverUI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.root = $('game-over');
    this.title = $('go-title');
    this.subtitle = $('go-subtitle');
    this.pnl = $('go-pnl');
    this.ret = $('go-return');
    this.realized = $('go-realized');
    this.unrealized = $('go-unrealized');
    this.note = $('go-note');
    this.rankWrap = $('go-rankings');
    this.rankSummary = $('go-rank-summary');
    this.rankList = $('go-rank-list');
    this.leaderboard = $('go-leaderboard');
    this.backBtn = $('btn-back-to-menu');
    if (this.backBtn) this.backBtn.addEventListener('click', () => window.location.reload());
  }

  show(results, me, fallbackAccount) {
    if (!this.root || !results) return;
    const standings = results.standings || [];
    const mine = myStanding(results, me, fallbackAccount);

    const rank = standings.findIndex((s) => s.id === me) + 1;
    const isMulti = standings.length > 1;
    const tone = (v) => (round2(v) >= 0 ? 'pos' : 'neg');

    if (this.title) {
      this.title.innerText = !isMulti || rank === 0
        ? 'Market closed'
        : rank === 1 ? 'You won the day' : `You finished ${ordinal(rank)} of ${standings.length}`;
    }
    if (this.subtitle) {
      this.subtitle.innerText = `The closing bell rang at ${results.closeTime}. Last price ${fmtMoney(results.finalPrice)}.`;
    }
    if (this.pnl) {
      this.pnl.innerText = fmtSigned(mine.total);
      this.pnl.className = `go-pnl num ${tone(mine.total)}`;
    }
    if (this.ret) this.ret.innerText = `${fmtPct((mine.total / STARTING_CASH) * 100)} on ${fmtMoney(STARTING_CASH)} starting cash`;
    if (this.realized) {
      this.realized.innerText = fmtSigned(mine.realized);
      this.realized.className = `num font-semibold ${tone(mine.realized)}`;
    }
    if (this.unrealized) {
      this.unrealized.innerText = fmtSigned(mine.unrealized);
      this.unrealized.className = `num font-semibold ${tone(mine.unrealized)}`;
    }
    if (this.note) {
      const open = mine.shares || 0;
      this.note.classList.toggle('hidden', open === 0);
      this.note.innerText = open === 0 ? '' : `Your ${open > 0 ? 'long' : 'short'} position of ${Math.abs(open)} shares was valued at the closing price.`;
    }

    if (this.rankWrap) this.rankWrap.classList.toggle('hidden', !isMulti);
    if (isMulti && this.rankList) {
      if (this.rankSummary) this.rankSummary.innerText = `${standings.length} traders`;
      this.rankList.innerHTML = standings.map((s, i) => {
        const isMe = s.id === me;
        return `
          <div class="row-card row-card-roomy${isMe ? ' is-me' : ''} flex items-center justify-between text-xs num">
            <span class="flex items-center gap-3 min-w-0">
              <span class="w-5 ${i === 0 ? 't-gold font-bold' : 't-faint'}">${i + 1}</span>
              <span class="t-ink font-medium truncate">${escapeHtml(s.name || s.id)}${isMe ? ' <span class="t-faint font-normal">(You)</span>' : ''}${s.isAI ? ' <span class="chip chip-gold">AI</span>' : ''}</span>
            </span>
            <span class="flex items-center gap-3 shrink-0">
              <span class="font-semibold ${tone(s.total)}">${fmtSigned(s.total)}</span>
              <span class="w-16 text-right t-faint">${fmtPct((s.total / STARTING_CASH) * 100)}</span>
            </span>
          </div>`;
      }).join('');
    }

    this.root.classList.remove('hidden');
    if (this.backBtn) this.backBtn.focus();
  }

  // Global leaderboard result: pending -> placed / not placed. Stays hidden
  // if the leaderboard isn't set up or couldn't be reached.
  showLeaderboard(state, category, rank = null) {
    const el = this.leaderboard;
    if (!el) return;
    const board = category === 'algorithmic' ? 'Algorithmic' : 'Discretionary';
    const link = `<a class="footer-link" href="leaderboard.html#${category}">See the leaderboard</a>`;
    if (state === 'pending') el.textContent = 'Saving your score to the leaderboard…';
    else if (state === 'placed') el.innerHTML = `You placed ${ordinal(rank)} on the ${board} leaderboard. ${link}`;
    else if (state === 'missed') el.innerHTML = `This score didn't make the ${board} top 1,000. ${link}`;
    el.classList.toggle('hidden', state === 'hidden');
  }
}

// ===================================================================
// LOBBY BACKGROUND: a live Monte Carlo simulation. A fan of simulated
// price paths draws across the start screen; the path that finishes
// highest (the frontier) is drawn in gold. Then it fades and reruns.
// ===================================================================
class PathsBackground {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.raf = null;
    this.running = false;
    this.reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.onResize = () => {
      this.resize();
      if (!this.running) this.drawFrame();
    };
  }

  start() {
    if (!this.ctx || this.running) return;
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.newRun();
    if (this.reduceMotion) {
      this.progress = 1; // one still frame, no animation
      this.drawFrame();
      return;
    }
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this.advance(now);
      this.drawFrame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  newRun() {
    const gauss = () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    this.steps = 240;
    this.paths = [];
    for (let p = 0; p < 30; p++) {
      const ys = new Float32Array(this.steps + 1);
      let y = 0;
      let vol = 1;
      for (let i = 1; i <= this.steps; i++) {
        vol = 0.93 * vol + 0.07 * (0.55 + Math.random() * 1.0); // gentle volatility clustering
        y += 0.0019 + vol * gauss() * 0.011;                     // slight upward drift
        ys[i] = y;
      }
      this.paths.push(ys);
    }
    this.leader = 0;
    this.paths.forEach((ys, i) => {
      if (ys[this.steps] > this.paths[this.leader][this.steps]) this.leader = i;
    });
    this.progress = 0;
    this.phase = 'draw';
    this.alpha = 1;
  }

  advance(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.phase === 'draw') {
      this.progress = Math.min(1, this.progress + dt / 7.5);
      if (this.progress >= 1) {
        this.phase = 'hold';
        this.holdUntil = now + 2800;
      }
    } else if (this.phase === 'hold') {
      if (now >= this.holdUntil) this.phase = 'fade';
    } else {
      this.alpha -= dt / 1.4;
      if (this.alpha <= 0) this.newRun();
    }
  }

  drawFrame() {
    const { ctx, w, h } = this;
    if (!ctx || !w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const a = Math.max(0, this.alpha);
    const x0 = w * 0.035;
    const x1 = w * 1.02;
    const y0 = h * 0.8;   // fan starts low-left, beneath the statement, and rises toward the card
    const scale = h * 0.5;
    const upto = Math.max(1, Math.floor(this.progress * this.steps));
    const X = (i) => x0 + ((x1 - x0) * i) / this.steps;
    const Y = (v) => y0 - v * scale;

    const trace = (ys) => {
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      for (let i = 1; i <= upto; i++) ctx.lineTo(X(i), Y(ys[i]));
      ctx.stroke();
    };

    ctx.lineJoin = 'round';
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(11, 29, 71, ${0.15 * a})`;
    this.paths.forEach((ys, i) => {
      if (i !== this.leader) trace(ys);
    });

    ctx.fillStyle = `rgba(11, 29, 71, ${0.3 * a})`;
    this.paths.forEach((ys, i) => {
      if (i === this.leader) return;
      ctx.beginPath();
      ctx.arc(X(upto), Y(ys[upto]), 1.6, 0, Math.PI * 2);
      ctx.fill();
    });

    const lead = this.paths[this.leader];
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(176, 141, 60, ${0.95 * a})`;
    trace(lead);
    ctx.fillStyle = `rgba(176, 141, 60, ${0.18 * a})`;
    ctx.beginPath();
    ctx.arc(X(upto), Y(lead[upto]), 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(176, 141, 60, ${a})`;
    ctx.beginPath();
    ctx.arc(X(upto), Y(lead[upto]), 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Common starting point: "today"
    ctx.fillStyle = `rgba(11, 29, 71, ${0.55 * a})`;
    ctx.beginPath();
    ctx.arc(X(0), Y(0), 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ===================================================================
// 7. TIME-SCALED GAME LOOP ENGINE
// ===================================================================

// Browsers clamp setInterval in background tabs to ~1/second (sometimes far
// less), which is what made the whole game slow down when the host tabbed
// out. Timers inside a Web Worker aren't clamped that way, so the worker
// just sends "pulses" and the main thread does the work. If Workers are
// unavailable we fall back to a normal interval.
class PulseClock {
  constructor(intervalMs, onPulse) {
    this.intervalMs = intervalMs;
    this.onPulse = onPulse;
    this.worker = null;
    this.workerUrl = null;
    this.timer = null;
  }

  start() {
    this.stop();
    try {
      const src = 'let t=null;onmessage=(e)=>{clearInterval(t);t=null;if(e.data>0)t=setInterval(()=>postMessage(1),e.data);};';
      this.workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = () => this.onPulse();
      this.worker.onerror = () => this.useFallback();
      this.worker.postMessage(this.intervalMs);
    } catch (err) {
      this.useFallback();
    }
  }

  useFallback() {
    this.stopWorker();
    if (!this.timer) this.timer = setInterval(() => this.onPulse(), this.intervalMs);
  }

  stopWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
  }

  stop() {
    this.stopWorker();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

class GameLoop {
  constructor(orderBook, eventBus, { durationMinutes = GAME_DURATION_MINUTES, afterStep, onPulse, onFinish, onNews, shouldPause, onPaused } = {}) {
    this.orderBook = orderBook;
    this.fleet = new BotFleet(orderBook, eventBus, {
      simSecsPerTick: SIM_SECS_PER_TICK,
      openSecs: SESSION_OPEN_SECS,
      closeSecs: SESSION_CLOSE_SECS,
      onNews
    });
    this.afterStep = afterStep;
    this.onPulse = onPulse;
    this.onFinish = onFinish;
    this.shouldPause = shouldPause || null; // (tick) => bool: stop after this tick until resume()
    this.onPaused = onPaused || null;
    this.paused = false;
    this.pausedAt = 0;

    this.totalTicks = TOTAL_TICKS;
    this.tickIntervalMs = (durationMinutes * 60 * 1000) / this.totalTicks; // ≈294 ms for 10 minutes

    this.ticksDone = 0;
    this.simulatedSeconds = SESSION_OPEN_SECS;
    this.priceHistory = [];
    this.running = false;

    // Every trade between two ticks feeds that tick's high, low and volume.
    this.tickBar = new TickAccumulator();
    this.lastClose = null;
    this.collecting = false;
    eventBus.on('TRADE', (t) => {
      if (this.collecting) this.tickBar.addTrade(t.price, t.qty);
    });
    this.finished = false;
    this.startedAt = 0;

    this.clock = new PulseClock(Math.min(100, this.tickIntervalMs / 3), () => this.pump());
  }

  progress() {
    return this.ticksDone / this.totalTicks;
  }

  start() {
    this.ticksDone = 0;
    this.simulatedSeconds = SESSION_OPEN_SECS;
    this.finished = false;
    this.paused = false;
    this.tickBar.reset();
    this.lastClose = null;
    this.collecting = true;
    this.priceHistory = [this.makePoint()];
    this.fleet.start(this.priceHistory); // 1,000 traders arrive and build the opening book
    this.startedAt = performance.now();
    this.running = true;
    this.clock.start();
    if (this.onPulse) this.onPulse([this.priceHistory[0]]);
  }

  stop() {
    this.running = false;
    this.paused = false;
    this.collecting = false;
    this.clock.stop();
  }

  // Freeze the day right after the tick just played. The wall clock is
  // pinned to that tick, so resuming neither skips ticks nor bursts through
  // the ones that would have been due during the pause.
  pause() {
    if (this.paused || !this.running) return;
    this.paused = true;
    this.pausedAt = this.startedAt + this.ticksDone * this.tickIntervalMs;
    this.clock.stop();
  }

  resume() {
    if (!this.paused || !this.running) return;
    this.startedAt += performance.now() - this.pausedAt;
    this.paused = false;
    this.clock.start();
  }

  // Runs however many ticks the wall clock says are due, so the day always
  // lasts GAME_DURATION_MINUTES even if pulses arrive late or bunched up.
  pump() {
    if (!this.running || this.paused) return;
    let due = Math.min(this.totalTicks, Math.floor((performance.now() - this.startedAt) / this.tickIntervalMs));
    const backlog = due - this.ticksDone;
    if (backlog > MAX_BACKLOG_TICKS) {
      // Host was frozen (sleeping laptop, suspended tab). Pause instead of fast-forwarding.
      const skip = backlog - MAX_BACKLOG_TICKS;
      this.startedAt += skip * this.tickIntervalMs;
      due -= skip;
    }

    const points = [];
    while (this.ticksDone < due) {
      points.push(this.step());
      if (this.shouldPause && this.ticksDone < this.totalTicks && this.shouldPause(this.ticksDone)) {
        this.pause();
        break;
      }
    }
    if (points.length && this.onPulse) this.onPulse(points);
    if (this.paused) {
      if (this.onPaused) this.onPaused(this.ticksDone);
      return;
    }

    if (this.ticksDone >= this.totalTicks) {
      this.finished = true;
      this.stop();
      this.fleet.endDay(this.priceHistory); // Tomorrow AI's final reward for the day
      if (this.onFinish) this.onFinish();
    }
  }

  step() {
    this.ticksDone += 1;
    this.simulatedSeconds = SESSION_OPEN_SECS + this.ticksDone * SIM_SECS_PER_TICK;
    this.orderBook.currentTick = this.ticksDone;
    this.orderBook.expireOrders(this.ticksDone);
    this.fleet.onTick({ tick: this.ticksDone, simSeconds: this.simulatedSeconds, history: this.priceHistory });
    if (this.afterStep) this.afterStep();
    const point = this.makePoint();
    this.priceHistory.push(point);
    return point;
  }

  // One bar per tick: `price` is the closing mid (the bots read it), plus
  // open/high/low/volume/value for candles and indicators (see engine/bars.js).
  makePoint() {
    const close = this.orderBook.getMidPrice();
    const bar = this.tickBar.take(this.lastClose ?? close, close);
    this.lastClose = close;
    return { ...bar, simTimeStr: formatSimTime(this.simulatedSeconds), simSecs: this.simulatedSeconds };
  }
}

// ===================================================================
// TOMORROW AI: one learning trader per game.
//   - Starts from the published long-term brain (assets/ai-brain.json).
//   - Learns live during the game (gently, so one game refines rather than
//     overwrites what it knows) and caches that refinement in this browser.
//   - At the closing bell uploads the game's experience to the inbox; the
//     nightly trainer (tools/nightly-ai.mjs) folds every game into the next
//     published generation. See src/engine/ai/sync.js to switch uploads on.
// ===================================================================
const AI_STORAGE_KEY = 'tomorrowMarkets.aiBrain';
const AI_LIVE_SETTINGS = { bufferSize: 4000, warmup: 256, batch: 32, learnEvery: 4, lr: 5e-5 };

async function loadAIBrain() {
  let shipped = null;
  let local = null;
  try {
    const res = await fetch('assets/ai-brain.json', { cache: 'no-cache' });
    if (res.ok) shipped = await res.json();
  } catch (err) { /* no published brain yet */ }
  try {
    const raw = localStorage.getItem(AI_STORAGE_KEY);
    if (raw) local = JSON.parse(raw);
  } catch (err) { /* storage unavailable */ }
  // A newer published generation always wins; this browser's refined copy is
  // only used while the published brain is still the same generation.
  let best = shipped;
  if (local && (!shipped || (local.generation || 0) > (shipped.generation || 0) ||
      ((local.generation || 0) === (shipped.generation || 0) && local.episodes > shipped.episodes))) best = local;
  try {
    const agent = best ? BranchingDQN.fromJSON(best, AI_LIVE_SETTINGS) : createAgent(AI_LIVE_SETTINGS);
    agent.savedConfig = best ? best.config : createAgent().config; // saved without the live-game tweaks
    return agent;
  } catch (err) {
    console.warn('Tomorrow AI: brain file not usable, starting fresh.', err);
    const agent = createAgent(AI_LIVE_SETTINGS);
    agent.savedConfig = createAgent().config;
    return agent;
  }
}

function saveAIBrain(agent) {
  if (!agent) return;
  try {
    const json = agent.toJSON();
    json.config = agent.savedConfig || json.config;
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(json));
  } catch (err) { /* storage full or blocked: the refinement just isn't cached */ }
}

// Developer helpers in the browser console: TomorrowAI.info(), .download(), .reset()
function exposeAIConsole(getAgent) {
  window.TomorrowAI = {
    info() {
      const a = getAgent();
      if (!a) return 'not loaded';
      return {
        generation: a.generation,
        daysOfExperience: a.episodes,
        decisions: a.decisions,
        exploring: `${(a.epsilon * 100).toFixed(1)}%`,
        parameters: a.online.paramCount,
        uploads: syncEnabled() ? 'on' : 'off (see src/engine/ai/sync.js)'
      };
    },
    download() {
      const a = getAgent();
      if (!a) return;
      const json = a.toJSON();
      json.config = a.savedConfig || json.config;
      const url = URL.createObjectURL(new Blob([JSON.stringify(json)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: 'ai-brain.json' }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    reset() {
      try { localStorage.removeItem(AI_STORAGE_KEY); } catch (err) { /* ignore */ }
      return "This browser's cached AI was cleared. Reload to use the published brain.";
    }
  };
}

// ===================================================================
// 8. APPLICATION INITIALIZATION & LOBBY ROUTING
// Roles: 'solo' and 'host' are the authority (run the book, bots, SL/TP,
// ledger). 'client' only renders state and sends actions to the host.
// ===================================================================
function initApp() {
  const eventBus = new EventBus();
  const peerNetwork = new PeerNetwork(eventBus);
  const accountManager = new AccountManager(eventBus, 'Trader_1');
  const orderBook = new OrderBook(eventBus);
  const ledger = new Ledger(eventBus);
  const toast = createToaster(document.getElementById('toast-container'));

  let role = 'lobby'; // 'solo' | 'host' | 'client'
  let currentUserId = 'Trader_1';
  let connectedPlayers = []; // [{ id, isHost }]
  let marketOpen = false;
  let clientHistory = [];
  let joinToken = null;
  const tokenToId = new Map();
  let runTracker = null;    // this game's leaderboard ticket
  let stopFacts = null;
  let sessionMode = 'discretionary'; // 'discretionary' | 'algorithmic', chosen fresh every game
  let algoRunner = null;             // this player's AlgoRunner while sessionMode === 'algorithmic'
  let pendingLaunch = null;          // { kind: 'solo' | 'host' | 'join', run } waiting on the mode choice
  let lastTick = null;               // latest TICK payload: what a strategy's snapshot is built from

  const isAuthority = () => role === 'solo' || role === 'host';
  const getCurrentUserId = () => currentUserId;

  function notify(playerId, text, level = 'info') {
    if (playerId === currentUserId) toast(text, level);
    else if (role === 'host') peerNetwork.broadcast({ type: 'NOTICE', playerId, text, level });
  }

  const brackets = new BracketManager(orderBook, ledger, notify);
  eventBus.on('TRADE', (t) => {
    if (isAuthority()) brackets.onTrade(t);
  });

  // Market news (opening crowd, traders joining/leaving, US open) for every player
  function announce(text) {
    toast(text, 'news');
    if (role === 'host') peerNetwork.broadcast({ type: 'NEWS', text });
  }

  let aiAgent = null;
  const aiReady = loadAIBrain().then((agent) => {
    aiAgent = agent;
    exposeAIConsole(() => aiAgent);
  });

  const gameLoop = new GameLoop(orderBook, eventBus, {
    durationMinutes: GAME_DURATION_MINUTES,
    afterStep: () => brackets.evaluate(),
    onPulse: (points) => publishState(points),
    onFinish: () => closeMarket(),
    onNews: (text) => announce(text),
    shouldPause: (tick) => sessionMode === 'algorithmic' && tick % ALGO_DECISION_EVERY_TICKS === 0,
    onPaused: () => startDecisionRound()
  });

  const lobbyPaths = new PathsBackground(document.getElementById('lobby-canvas'));
  lobbyPaths.start();

  new BookUI(eventBus);
  new PriceChart(eventBus, getCurrentUserId, {
    originSecs: SESSION_OPEN_SECS,
    secsPerTick: SIM_SECS_PER_TICK,
    totalTicks: TOTAL_TICKS
  });
  new ControlsUI(eventBus, accountManager, getCurrentUserId, toast);
  const gameOverUI = new GameOverUI();
  const algoLabUI = new AlgoLabUI();
  const algoActionLog = new AlgoActionLogUI(eventBus, getCurrentUserId);
  const tradeHistoryUI = new TradeHistoryUI(eventBus, accountManager, getCurrentUserId);

  // DOM Elements
  const $ = (id) => document.getElementById(id);
  const lobbyScreen = $('lobby-screen');
  const lobbyMenu = $('lobby-menu');
  const waitingRoom = $('waiting-room');
  const tradingScreen = $('trading-screen');
  const btnSinglePlayer = $('btn-single-player');
  const btnHostMultiplayer = $('btn-host-multiplayer');
  const btnJoinMultiplayer = $('btn-join-multiplayer');
  const btnStartGame = $('btn-start-game');
  const roomCodeInput = $('room-code-input');
  const modeSelect = $('mode-select');
  const btnModeDiscretionary = $('mode-discretionary');
  const btnModeAlgorithmic = $('mode-algorithmic');
  const btnModeBack = $('btn-mode-back');
  const indicatorPlaceholder = $('indicator-placeholder');
  const tradeHistoryPanel = $('trade-history-panel');
  const algoLogPanel = $('algo-log-panel');
  const indicatorTitle = $('indicator-title');
  const indicatorMeta = $('indicator-meta');
  const indicatorDot = $('indicator-dot');
  const tradeHistorySummary = $('trade-history-summary');
  const roomModeChip = $('room-mode-chip');
  const modeBadge = $('mode-badge');
  const orderEntryPanel = $('order-entry-panel');
  const orderEntryNote = $('order-entry-algo-note');
  const btnEditStrategy = $('btn-edit-strategy');
  const displayRoomCode = $('display-room-code');
  const playerList = $('player-list');
  const playerCount = $('player-count');
  const hostControls = $('host-controls');
  const clientStatus = $('client-status');
  const roomBadge = $('room-badge');
  const roomCodeDisplay = $('room-code-display');
  const sessionProgress = $('session-progress');

  const traderCount = $('trader-count');
  eventBus.on('TICK', (data) => {
    lastTick = data;
    if (traderCount && typeof data.traders === 'number') traderCount.innerText = data.traders.toLocaleString('en-US');
    if (sessionProgress && typeof data.progress === 'number') {
      sessionProgress.style.width = `${Math.min(100, data.progress * 100).toFixed(1)}%`;
    }
  });

  function getTraderName() {
    const input = $('trader-name-input');
    return sanitizeHandle(input ? input.value : '');
  }

  function renderPlayerList() {
    if (!playerList) return;
    if (playerCount) playerCount.innerText = `${connectedPlayers.length} ${connectedPlayers.length === 1 ? 'Player' : 'Players'}`;
    playerList.innerHTML = connectedPlayers.map((p) => `
      <div class="row-card row-card-roomy flex items-center justify-between text-xs">
        <span class="t-ink font-medium flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full inline-block" style="background: var(--bid)"></span>
          ${escapeHtml(p.id)}${p.id === currentUserId ? ' <span class="t-faint font-normal">(You)</span>' : ''}
        </span>
        <span class="chip ${p.isHost ? 'chip-gold' : 'chip-neutral'}">${p.isHost ? 'Host' : 'Trader'}</span>
      </div>
    `).join('');
  }

  function uniquePlayerId(base) {
    const taken = new Set(connectedPlayers.map((p) => p.id));
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base.slice(0, 13)}_${n++}`;
    return id;
  }

  function showFacts() {
    if (!stopFacts) stopFacts = mountLobbyFacts($('lobby-facts'));
  }

  function hideFacts() {
    if (stopFacts) stopFacts();
    stopFacts = null;
  }

  function startRunTracking(mode) {
    runTracker = createRunTracker({ mode, durationMin: GAME_DURATION_MINUTES });
  }

  // Submit this player's final PnL to the global leaderboard (once per game).
  function submitRun(results) {
    const tracker = runTracker;
    runTracker = null;
    if (!tracker) return;
    const category = sessionMode; // the two leaderboards are kept apart by the mode chosen before the game
    const mine = myStanding(results, currentUserId, accountManager);
    if (leaderboardLive) gameOverUI.showLeaderboard('pending', category);
    tracker.finish({ handle: currentUserId, category, pnl: mine.total }).then((res) => {
      if (!res) gameOverUI.showLeaderboard('hidden', category);
      else if (res.rank) gameOverUI.showLeaderboard('placed', category, res.rank);
      else gameOverUI.showLeaderboard('missed', category);
    });
  }

  function launchTradingScreen() {
    hideFacts();
    lobbyPaths.stop();
    if (lobbyScreen) lobbyScreen.classList.add('hidden');
    if (tradingScreen) tradingScreen.classList.remove('hidden');
    applySessionMode();
  }

  // ---- Discretionary / Algorithmic ----------------------------------------
  // Single player, Host and Join each stop at the mode choice before doing
  // what they used to do straight away. `pendingLaunch.run` is that original
  // flow; it runs once a mode (and for Algorithmic, a tested strategy) is set.

  const modeLabel = (m) => (m === 'algorithmic' ? 'Algorithmic' : 'Discretionary');

  function showModeSelect(kind, run) {
    pendingLaunch = { kind, run };
    if (lobbyMenu) lobbyMenu.classList.add('hidden');
    if (modeSelect) modeSelect.classList.remove('hidden');
    if (btnModeDiscretionary) btnModeDiscretionary.focus();
  }

  function backToLobbyMenu() {
    pendingLaunch = null;
    role = 'lobby';
    sessionMode = 'discretionary';
    disposeAlgoRunner();
    if (modeSelect) modeSelect.classList.add('hidden');
    if (waitingRoom) waitingRoom.classList.add('hidden');
    if (lobbyMenu) lobbyMenu.classList.remove('hidden');
  }

  function runPendingLaunch() {
    const launch = pendingLaunch;
    pendingLaunch = null;
    if (modeSelect) modeSelect.classList.add('hidden');
    if (roomModeChip) roomModeChip.textContent = modeLabel(sessionMode);
    if (launch) launch.run();
  }

  function openAlgoLab(note = '') {
    if (modeSelect) modeSelect.classList.add('hidden');
    if (lobbyScreen) lobbyScreen.classList.add('hidden');
    lobbyPaths.stop();
    algoLabUI.open({ note });
  }

  function disposeAlgoRunner() {
    if (algoRunner) algoRunner.dispose();
    algoRunner = null;
  }

  function algoLogEntry(level, text) {
    return { playerId: currentUserId, name: currentUserId, simTime: lastTick ? lastTick.simTimeStr : '', level, text };
  }

  function attachAlgoRunner(runner) {
    disposeAlgoRunner();
    algoRunner = runner;
    runner.onStatus = (status, detail) => {
      eventBus.emit('ALGO_STATUS', { playerId: currentUserId, language: runner.language, status, detail });
    };
    runner.onLog = ({ level, text }) => {
      if (level === 'debug') return console.debug(`[strategy] ${text}`);
      // print() output is only shown to you; orders and problems go to the whole room.
      if (level === 'log') return eventBus.emit('ALGO_LOG', algoLogEntry('log', text));
      const entry = algoLogEntry(level, text);
      if (role === 'client') {
        peerNetwork.broadcast({ type: 'ALGO_LOG', entry }); // the host echoes it to everyone, you included
      } else {
        eventBus.emit('ALGO_LOG', entry);
        if (role === 'host') peerNetwork.broadcast({ type: 'ALGO_LOG', entry });
      }
    };
    // Orders take exactly the same route as the order ticket's Buy/Sell.
    runner.onAction = (action) => eventBus.emit('USER_ACTION', action);
  }

  // Swaps the bottom panel (and the order ticket) to match this session:
  // your own fills for discretionary, the strategy log for algorithmic.
  function applySessionMode() {
    const isAlgo = sessionMode === 'algorithmic';
    if (indicatorPlaceholder) indicatorPlaceholder.classList.add('hidden');
    if (tradeHistoryPanel) tradeHistoryPanel.classList.toggle('hidden', isAlgo);
    if (algoLogPanel) algoLogPanel.classList.toggle('hidden', !isAlgo);
    if (indicatorTitle) indicatorTitle.textContent = isAlgo ? 'Algorithmic strategy engine' : 'Trade history';
    if (indicatorMeta) {
      indicatorMeta.textContent = `Decision round every ${ALGO_DECISION_EVERY_TICKS * SIM_SECS_PER_TICK / 60} sim-min`;
      indicatorMeta.classList.toggle('hidden', !isAlgo);
    }
    if (tradeHistorySummary) tradeHistorySummary.classList.toggle('hidden', isAlgo);
    if (indicatorDot) indicatorDot.style.background = isAlgo ? 'var(--bid)' : 'var(--gold)';
    if (modeBadge) {
      modeBadge.textContent = modeLabel(sessionMode);
      modeBadge.className = `chip ${isAlgo ? 'chip-gold' : 'chip-neutral'}`;
    }
    if (orderEntryPanel) orderEntryPanel.classList.toggle('algo-locked', isAlgo);
    if (orderEntryNote) orderEntryNote.classList.toggle('hidden', !isAlgo);
    tradeHistoryUI.reset();
    algoActionLog.reset(isAlgo);
    if (isAlgo && algoRunner) {
      eventBus.emit('ALGO_STATUS', { playerId: currentUserId, language: algoRunner.language, status: algoRunner.status });
    }
  }

  // ---- Algorithmic decision rounds (authority) ----------------------------
  // Every ALGO_DECISION_EVERY_TICKS the game loop pauses (see GameLoop's
  // shouldPause). Every strategy in the room gets the same snapshot and up
  // to ALGO_DECISION_TIMEOUT_MS to answer; clients run theirs in their own
  // browser and reply ALGO_DONE after sending their orders. The market
  // resumes when everyone has answered, or when time runs out.

  let decision = null;       // { round, waiting: Set<playerId>, total, timer }
  let decisionRound = 0;
  const droppedPlayers = new Set(); // left the room, or missed a round's deadline: not waited on
  const connToId = new Map();       // host: PeerJS connection -> playerId

  function emitRound(info) {
    eventBus.emit('ALGO_ROUND', info);
    if (role === 'host') peerNetwork.broadcast({ type: 'ALGO_ROUND', info });
  }

  function startDecisionRound() {
    decisionRound += 1;
    const round = decisionRound;
    const waiting = new Set(ledger.ids().filter((id) => id !== AI_ID && !droppedPlayers.has(id)));
    if (waiting.size === 0) {
      gameLoop.resume();
      return;
    }
    const total = waiting.size;
    decision = { round, waiting, total, timer: setTimeout(() => endDecisionRound(round, true), ALGO_DECISION_TIMEOUT_MS) };
    emitRound({ round, phase: 'waiting', pending: total, total });
    if (role === 'host') peerNetwork.broadcast({ type: 'ALGO_DECISION', round });
    if (waiting.has(currentUserId)) runLocalDecision(round).then(() => finishDecision(currentUserId, round));
  }

  function finishDecision(playerId, round) {
    if (!decision || decision.round !== round || !decision.waiting.delete(playerId)) return;
    if (decision.waiting.size === 0) endDecisionRound(round, false);
    else emitRound({ round, phase: 'waiting', pending: decision.waiting.size, total: decision.total });
  }

  function endDecisionRound(round, timedOut) {
    if (!decision || decision.round !== round) return;
    clearTimeout(decision.timer);
    const late = [...decision.waiting];
    decision = null;
    if (timedOut && late.length) {
      // Don't make everyone wait a full minute every round for a player who
      // may have gone. They're back in from the next round as soon as they
      // answer (see onHostMessage ALGO_DONE).
      for (const id of late) droppedPlayers.add(id);
      announce(`Round ${round}: carried on without ${late.join(', ')} after ${ALGO_DECISION_TIMEOUT_MS / 1000}s. They'll rejoin the rounds once they respond.`);
    }
    if (!marketOpen) return;
    publishState();
    emitRound({ round, phase: 'live' });
    gameLoop.resume();
  }

  // Runs this browser's own strategy on the latest state it has seen. Used
  // by the authority for its own player and by clients on ALGO_DECISION.
  async function runLocalDecision(round) {
    if (!algoRunner || !lastTick) return;
    try {
      await algoRunner.decide(buildSnapshot({
        priceHistory: lastTick.priceHistory || [],
        bids: lastTick.bids || [],
        asks: lastTick.asks || [],
        mid: lastTick.midPrice,
        openOrders: (lastTick.playerOrders && lastTick.playerOrders[currentUserId]) || [],
        account: accountManager,
        simTimeStr: lastTick.simTimeStr,
        round
      }));
    } catch (err) {
      console.warn('Strategy round failed', err); // decide() handles its own errors; this is a last resort
    }
  }

  // ---- Authority: state publishing ------------------------------------

  function collectHumanOrders() {
    const out = {};
    for (const id of ledger.ids()) out[id] = [];
    for (const [book, side] of [[orderBook.bids, 'BUY'], [orderBook.asks, 'SELL']]) {
      for (const o of book) {
        const bucket = out[o.playerId];
        if (!bucket) continue;
        const lv = brackets.getOrderLevels(o.id);
        bucket.push({ id: o.id, side, price: o.price, qty: o.qty, sl: lv ? lv.sl : null, tp: lv ? lv.tp : null });
      }
    }
    return out;
  }

  // Clients get a slim payload: top of book, only the NEW chart points, and
  // every human's own orders/brackets. The old version re-sent the full book
  // and the full price history on every tick, which grew all game long.
  function publishState(points = []) {
    const payload = {
      midPrice: orderBook.getMidPrice(),
      simTimeStr: formatSimTime(gameLoop.simulatedSeconds),
      progress: gameLoop.progress(),
      points,
      bids: orderBook.levels('BUY', BOOK_LEVELS),
      asks: orderBook.levels('SELL', BOOK_LEVELS),
      traders: gameLoop.fleet.size + ledger.ids().filter((id) => id !== AI_ID).length,
      playerOrders: collectHumanOrders(),
      brackets: brackets.byPlayer(),
      // Every trader's running PnL, best first, so the strategy panel can
      // show the room's standings live instead of only at the closing bell.
      standings: ledger.standings(orderBook.getMidPrice())
        .map((st) => (st.id === AI_ID ? { ...st, name: AI_NAME, isAI: true } : st))
    };
    eventBus.emit('TICK', { ...payload, priceHistory: gameLoop.priceHistory });
    if (role === 'host') peerNetwork.broadcast({ type: 'SYNC_TICK', payload });
  }

  // Only trades involving a human matter to clients (bot-vs-bot trades were
  // previously broadcast one message each).
  eventBus.on('TRADE', (t) => {
    if (role !== 'host') return;
    const isPlayer = (id) => id !== AI_ID && ledger.has(id);
    if (isPlayer(t.buyerId) || isPlayer(t.sellerId)) {
      peerNetwork.broadcast({ type: 'SYNC_TRADE', payload: t });
    }
  });

  // ---- Authority: player actions ----------------------------------------

  function submitForPlayer(playerId, o, mid) {
    const side = o.side === 'SELL' ? 'SELL' : 'BUY';
    const type = o.type === 'MARKET' ? 'MARKET' : 'LIMIT';
    const qty = Math.floor(Number(o.qty));
    if (!(qty >= 1)) return notify(playerId, 'Enter a quantity of at least 1.', 'error');
    const price = type === 'LIMIT' ? parseOptionalPrice(o.price) : 0;
    if (type === 'LIMIT' && !(price > 0)) return notify(playerId, 'Enter a limit price above $0.', 'error');

    const sl = parseOptionalPrice(o.sl);
    const tp = parseOptionalPrice(o.tp);
    const err = validateBracket(side, type === 'MARKET' ? mid : price, sl, tp, {
      dir: side === 'BUY' ? 'buy' : 'sell',
      refLabel: type === 'MARKET' ? 'the current price' : 'your limit price'
    });
    if (err) return notify(playerId, err, 'error');

    const check = ledger.get(playerId).canPlaceOrder(side, type, price, qty, mid);
    if (!check.allowed) return notify(playerId, `Order rejected: ${check.reason}`, 'error');

    const id = orderBook.nextId('u');
    brackets.setOrderLevels(id, playerId, side, sl, tp); // must exist before matching so fills attach
    const res = orderBook.processOrder({ id, playerId, side, type, price, qty });
    if (!res || res.restingQty === 0) brackets.dropOrder(id);
    if (res && type === 'MARKET' && res.filledQty < qty) {
      notify(playerId, `Only ${res.filledQty} of ${qty} filled: not enough orders on the book.`, 'warn');
    }
  }

  function modifyForPlayer(playerId, orderId, ch, mid) {
    const found = orderBook.findOrder(orderId);
    if (!found || found.order.playerId !== playerId) return notify(playerId, 'That order already filled or was removed.', 'info');
    const { order, side } = found;

    const price = parseOptionalPrice(ch.price);
    const qty = Math.floor(Number(ch.qty));
    if (!(price > 0)) return notify(playerId, 'Enter a limit price above $0.', 'error');
    if (!(qty >= 1)) return notify(playerId, 'Enter a quantity of at least 1.', 'error');

    const sl = parseOptionalPrice(ch.sl);
    const tp = parseOptionalPrice(ch.tp);
    const err = validateBracket(side, price, sl, tp, { dir: side === 'BUY' ? 'buy' : 'sell', refLabel: 'the limit price' });
    if (err) return notify(playerId, err, 'error');
    if (brackets.get(orderId)) {
      // Part of this order already filled, so the levels also protect a live position.
      const err2 = validateBracket(side, mid, sl, tp, { dir: side === 'BUY' ? 'long position' : 'short position', refLabel: 'the current price' });
      if (err2) return notify(playerId, err2, 'error');
    }

    const repriced = price !== order.price || qty !== order.qty;
    if (repriced) {
      const check = ledger.get(playerId).canPlaceOrder(side, 'LIMIT', price, qty, mid);
      if (!check.allowed) return notify(playerId, `Change rejected: ${check.reason}`, 'error');
    }

    brackets.setOrderLevels(orderId, playerId, side, sl, tp);
    brackets.syncLevels(orderId, sl, tp);

    if (repriced) {
      // Cancel/replace under the same id: the order loses its queue position
      // and may fill straight away if the new price crosses the spread.
      orderBook.removeOrder(orderId, playerId);
      const res = orderBook.processOrder({ id: orderId, playerId, side, type: 'LIMIT', price, qty });
      if (!res || res.restingQty === 0) brackets.dropOrder(orderId);
    }
  }

  function modifyBracketForPlayer(playerId, bracketId, a, mid) {
    const br = brackets.get(bracketId);
    if (!br || br.playerId !== playerId) return notify(playerId, 'That position is already closed.', 'info');

    const sl = parseOptionalPrice(a.sl);
    const tp = parseOptionalPrice(a.tp);
    if (sl == null && tp == null) {
      brackets.remove(bracketId, playerId);
      return notify(playerId, 'Stop loss and take profit removed.', 'info');
    }
    const entrySide = br.exitSide === 'SELL' ? 'BUY' : 'SELL';
    const err = validateBracket(entrySide, mid, sl, tp, {
      dir: entrySide === 'BUY' ? 'long position' : 'short position',
      refLabel: 'the current price'
    });
    if (err) return notify(playerId, err, 'error');

    brackets.syncLevels(bracketId, sl, tp);
    const lv = brackets.getOrderLevels(bracketId);
    if (lv) brackets.setOrderLevels(bracketId, playerId, lv.side, sl, tp);
  }

  function handleAction(action, playerId) {
    if (!action || !ledger.has(playerId)) return;
    if (!marketOpen) return notify(playerId, 'The market is closed.', 'warn');
    if (sessionMode === 'algorithmic' && (action.type === 'SUBMIT_ORDER' || action.type === 'MODIFY_ORDER') && action.source !== 'algo') {
      return notify(playerId, 'Manual orders are off in algorithmic games: your strategy trades for you.', 'warn');
    }
    const mid = orderBook.getMidPrice();

    switch (action.type) {
      case 'SUBMIT_ORDER':
        return submitForPlayer(playerId, action.order || {}, mid);
      case 'CANCEL_ORDER':
        if (orderBook.cancelOrder(action.orderId, playerId)) brackets.dropOrder(action.orderId);
        else notify(playerId, 'That order already filled or was removed.', 'info');
        return undefined;
      case 'MODIFY_ORDER':
        return modifyForPlayer(playerId, action.orderId, action.changes || {}, mid);
      case 'MODIFY_BRACKET':
        return modifyBracketForPlayer(playerId, action.bracketId, action, mid);
      case 'CANCEL_BRACKET':
        if (brackets.remove(action.bracketId, playerId)) notify(playerId, 'Stop loss and take profit removed.', 'info');
        return undefined;
      case 'CANCEL_ALL':
        for (const o of orderBook.getPlayerOpenOrders(playerId)) {
          if (orderBook.cancelOrder(o.id, playerId)) brackets.dropOrder(o.id);
        }
        return undefined;
      default:
        return undefined;
    }
  }

  // Local UI -> authority (directly, or over the network for clients)
  eventBus.on('USER_ACTION', (action) => {
    if (isAuthority()) {
      handleAction(action, currentUserId);
      if (marketOpen) publishState(); // instant feedback instead of waiting for the next tick
    } else if (role === 'client') {
      peerNetwork.broadcast({ ...action, playerId: currentUserId });
    }
  });

  // ---- Game start / end ---------------------------------------------------

  function beginMarket() {
    startRunTracking(role === 'solo' ? 'single' : 'multi');
    decision = null;
    decisionRound = 0;
    droppedPlayers.clear();
    if (aiAgent) {
      gameLoop.fleet.aiAgent = aiAgent;
      ledger.register(AI_ID); // trades on the same $10,000 as everyone else
    }
    marketOpen = true;
    eventBus.emit('MARKET_STATE', { open: true });
    accountManager.broadcastState();
    launchTradingScreen();
    gameLoop.start();
    if (aiAgent) {
      const days = aiAgent.episodes;
      announce(days > 0
        ? `${AI_NAME} is trading today, with ${days.toLocaleString('en-US')} days of practice behind it.`
        : `${AI_NAME} is trading today for the very first time. Expect chaos.`);
    }
  }

  function closeMarket() {
    if (!marketOpen) return;
    marketOpen = false;
    const finalPrice = orderBook.getMidPrice();
    for (const id of ledger.ids()) orderBook.clearPlayerOrders(id);
    brackets.clear();
    publishState([]);

    const results = {
      finalPrice,
      closeTime: formatSimTime(SESSION_CLOSE_SECS),
      standings: ledger.standings(finalPrice).map((s) => (s.id === AI_ID ? { ...s, name: AI_NAME, isAI: true } : s))
    };
    saveAIBrain(aiAgent); // keep today's live refinement in this browser
    const aiTrader = gameLoop.fleet.ai;
    if (aiTrader) {
      const humans = ledger.ids().filter((id) => id !== AI_ID).length;
      uploadExperience(aiTrader.experience(), { humans }); // for the nightly long-term learning
    }
    if (role === 'host') peerNetwork.broadcast({ type: 'GAME_OVER', results });
    endGame(results);
  }

  function endGame(results) {
    marketOpen = false;
    eventBus.emit('MARKET_STATE', { open: false });
    if (decision) {
      clearTimeout(decision.timer);
      decision = null;
    }
    gameOverUI.show(results, currentUserId, accountManager);
    if (btnEditStrategy) btnEditStrategy.classList.toggle('hidden', sessionMode !== 'algorithmic');
    submitRun(results);
  }

  // ---- Networking -----------------------------------------------------------

  eventBus.on('NET_HOST_CONNECTED', () => {
    peerNetwork.broadcast({ type: 'JOIN_LOBBY', handle: currentUserId, token: joinToken, mode: sessionMode });
  });

  function onHostMessage(data, conn) {
    if (data.type === 'JOIN_LOBBY') {
      if (marketOpen || gameLoop.finished) {
        peerNetwork.broadcast({ type: 'JOIN_REJECTED', token: data.token, reason: 'This game has already started.' });
        return;
      }
      // Everyone in a room plays the same mode, so each score lands on one leaderboard.
      if ((data.mode || 'discretionary') !== sessionMode) {
        peerNetwork.broadcast({
          type: 'JOIN_REJECTED',
          token: data.token,
          reason: `This room is ${modeLabel(sessionMode).toLowerCase()}. Join again and choose ${modeLabel(sessionMode)}.`
        });
        return;
      }
      let id = data.token ? tokenToId.get(data.token) : null;
      if (!id) {
        id = uniquePlayerId(sanitizeHandle(data.handle));
        if (data.token) tokenToId.set(data.token, id);
        connectedPlayers.push({ id, isHost: false });
        ledger.register(id);
      }
      if (conn) connToId.set(conn, id);
      peerNetwork.broadcast({ type: 'WELCOME', token: data.token, playerId: id });
      peerNetwork.broadcast({ type: 'LOBBY_UPDATE', players: connectedPlayers });
      renderPlayerList();
    } else if (HUMAN_ACTIONS.has(data.type)) {
      handleAction(data, data.playerId);
      if (marketOpen) publishState();
    } else if (data.type === 'ALGO_LOG' && data.entry) {
      eventBus.emit('ALGO_LOG', data.entry);
      peerNetwork.broadcast({ type: 'ALGO_LOG', entry: data.entry });
    } else if (data.type === 'ALGO_DONE') {
      const id = connToId.get(conn) || data.playerId;
      if (droppedPlayers.has(id) && connToId.has(conn)) droppedPlayers.delete(id); // a late answer: they're back
      finishDecision(id, data.round);
    }
  }

  function onClientMessage(data) {
    switch (data.type) {
      case 'LOBBY_UPDATE':
        connectedPlayers = data.players || [];
        renderPlayerList();
        break;
      case 'WELCOME':
        if (data.token !== joinToken) break;
        if (data.playerId !== currentUserId) toast(`That name was taken, so you're trading as ${data.playerId}.`, 'info');
        currentUserId = data.playerId;
        accountManager.setPlayerId(currentUserId);
        renderPlayerList();
        break;
      case 'JOIN_REJECTED':
        if (data.token !== joinToken) break;
        toast(data.reason || 'Could not join that room.', 'error');
        hideFacts();
        backToLobbyMenu();
        break;
      case 'START_GAME':
        startRunTracking('multi');
        clientHistory = [];
        marketOpen = true;
        eventBus.emit('MARKET_STATE', { open: true });
        accountManager.broadcastState();
        launchTradingScreen();
        break;
      case 'SYNC_TICK': {
        const p = data.payload || {};
        if (p.points && p.points.length) {
          clientHistory.push(...p.points);
          const overflow = clientHistory.length - (TOTAL_TICKS + 1);
          if (overflow > 0) clientHistory.splice(0, overflow);
        }
        eventBus.emit('TICK', { ...p, priceHistory: clientHistory });
        break;
      }
      case 'SYNC_TRADE':
        eventBus.emit('TRADE', data.payload);
        break;
      case 'ALGO_LOG':
        eventBus.emit('ALGO_LOG', data.entry);
        break;
      case 'ALGO_ROUND':
        eventBus.emit('ALGO_ROUND', data.info);
        break;
      case 'ALGO_DECISION': {
        // Run our strategy on the state we just received; the host resumes
        // the market once every player has answered.
        const { round } = data;
        runLocalDecision(round).finally(() => {
          peerNetwork.broadcast({ type: 'ALGO_DONE', round, playerId: currentUserId });
        });
        break;
      }
      case 'NOTICE':
        if (data.playerId === currentUserId) toast(data.text, data.level);
        break;
      case 'NEWS':
        toast(data.text, 'news');
        break;
      case 'GAME_OVER':
        endGame(data.results);
        break;
      default:
        break;
    }
  }

  eventBus.on('NET_DATA_RECEIVED', ({ data, conn } = {}) => {
    if (!data || typeof data !== 'object') return;
    if (role === 'host') onHostMessage(data, conn);
    else if (role === 'client') onClientMessage(data);
  });

  // A player who leaves mid-game is never waited on in later decision rounds.
  eventBus.on('NET_CLIENT_DISCONNECTED', (conn) => {
    if (role !== 'host') return;
    const id = connToId.get(conn);
    connToId.delete(conn);
    if (!id || !marketOpen) return;
    droppedPlayers.add(id);
    if (decision) finishDecision(id, decision.round);
  });

  // ---- Lobby buttons --------------------------------------------------------

  // Each entry point asks for the mode first (showModeSelect); these are the
  // original flows, run once the mode (and strategy, if algorithmic) is set.

  function startSinglePlayer() {
    role = 'solo';
    currentUserId = getTraderName();
    ledger.register(currentUserId);
    accountManager.setPlayerId(currentUserId);
    aiReady.then(beginMarket);
  }

  function startHosting() {
    role = 'host';
    currentUserId = getTraderName();
    ledger.register(currentUserId);
    accountManager.setPlayerId(currentUserId);

    const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
    peerNetwork.initHost(roomCode);

    if (displayRoomCode) displayRoomCode.innerText = roomCode;
    if (roomCodeDisplay) roomCodeDisplay.innerText = roomCode;
    if (roomBadge) roomBadge.classList.remove('hidden');

    connectedPlayers = [{ id: currentUserId, isHost: true }];
    renderPlayerList();

    if (lobbyMenu) lobbyMenu.classList.add('hidden');
    if (waitingRoom) waitingRoom.classList.remove('hidden');
    if (hostControls) hostControls.classList.remove('hidden');
    if (clientStatus) clientStatus.classList.add('hidden');
    showFacts();
  }

  function startJoining(code) {
    role = 'client';
    currentUserId = getTraderName();
    joinToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
    accountManager.setPlayerId(currentUserId);

    peerNetwork.initClient(code, currentUserId);

    if (displayRoomCode) displayRoomCode.innerText = code;
    if (roomCodeDisplay) roomCodeDisplay.innerText = code;
    if (roomBadge) roomBadge.classList.remove('hidden');

    connectedPlayers = [{ id: currentUserId, isHost: false }];
    renderPlayerList();

    if (lobbyMenu) lobbyMenu.classList.add('hidden');
    if (waitingRoom) waitingRoom.classList.remove('hidden');
    if (hostControls) hostControls.classList.add('hidden');
    if (clientStatus) clientStatus.classList.remove('hidden');
    showFacts();
  }

  if (btnSinglePlayer) {
    btnSinglePlayer.addEventListener('click', () => {
      if (role !== 'lobby') return;
      showModeSelect('solo', startSinglePlayer);
    });
  }

  if (btnHostMultiplayer) {
    btnHostMultiplayer.addEventListener('click', () => {
      if (role !== 'lobby') return;
      showModeSelect('host', startHosting);
    });
  }

  if (btnJoinMultiplayer) {
    btnJoinMultiplayer.addEventListener('click', () => {
      if (role !== 'lobby') return;
      const code = roomCodeInput ? roomCodeInput.value.trim() : '';
      if (!code) {
        toast('Enter the 6-digit room code from your host.', 'error');
        return;
      }
      showModeSelect('join', () => startJoining(code));
    });
  }

  // ---- Mode choice & Algo Lab ------------------------------------------------

  if (btnModeDiscretionary) {
    btnModeDiscretionary.addEventListener('click', () => {
      if (!pendingLaunch) return;
      sessionMode = 'discretionary';
      disposeAlgoRunner();
      runPendingLaunch();
    });
  }

  if (btnModeAlgorithmic) {
    btnModeAlgorithmic.addEventListener('click', () => {
      if (!pendingLaunch) return;
      sessionMode = 'algorithmic';
      openAlgoLab();
    });
  }

  if (btnModeBack) btnModeBack.addEventListener('click', () => backToLobbyMenu());

  algoLabUI.onReady = (runner) => {
    attachAlgoRunner(runner);
    algoLabUI.close();
    // Solo goes straight to the market; host and join go on to the waiting room.
    if (pendingLaunch && pendingLaunch.kind !== 'solo') {
      if (lobbyScreen) lobbyScreen.classList.remove('hidden');
      lobbyPaths.start();
    }
    runPendingLaunch();
  };

  algoLabUI.onBack = () => {
    algoLabUI.close();
    if (lobbyScreen) lobbyScreen.classList.remove('hidden');
    lobbyPaths.start();
    backToLobbyMenu();
  };

  // "Improve strategy & play again": the page reloads (as Back to menu
  // always has), then reopens the Algo Lab on the saved draft.
  if (btnEditStrategy) {
    btnEditStrategy.addEventListener('click', () => {
      try {
        sessionStorage.setItem(REOPEN_LAB_KEY, JSON.stringify({ handle: currentUserId }));
      } catch (err) { /* storage blocked: it just returns to the menu */ }
      window.location.reload();
    });
  }

  let reopen = null;
  try {
    reopen = JSON.parse(sessionStorage.getItem(REOPEN_LAB_KEY) || 'null');
    sessionStorage.removeItem(REOPEN_LAB_KEY);
  } catch (err) { /* storage blocked */ }
  if (reopen) {
    const nameInput = $('trader-name-input');
    if (nameInput && reopen.handle) nameInput.value = reopen.handle;
    sessionMode = 'algorithmic';
    pendingLaunch = { kind: 'solo', run: startSinglePlayer };
    openAlgoLab('Your last strategy is loaded. Test & enter starts a new single-player day; Back lets you host or join a room instead.');
  }

  if (btnStartGame) {
    btnStartGame.addEventListener('click', () => {
      if (role !== 'host' || marketOpen || gameLoop.finished) return;
      btnStartGame.disabled = true;
      aiReady.then(() => {
        peerNetwork.broadcast({ type: 'START_GAME' });
        beginMarket();
      });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

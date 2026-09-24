import { PeerNetwork } from './net/PeerNetwork.js';

// ===================================================================
// 0. SESSION CONSTANTS & SHARED HELPERS
// ===================================================================
const SESSION_OPEN_SECS = 9 * 3600 + 30 * 60; // 09:30:00 AM
const SESSION_CLOSE_SECS = 18 * 3600;         // 06:00:00 PM
const SIM_SECS_PER_TICK = 15;
const GAME_DURATION_MINUTES = 10;             // real-world length of the whole trading day
const TOTAL_TICKS = (SESSION_CLOSE_SECS - SESSION_OPEN_SECS) / SIM_SECS_PER_TICK; // 2040
const STARTING_CASH = 10000;
const BOOK_DEPTH = 16;              // resting orders per side sent to the UI and to clients (UI shows what fits)
const MAX_BACKLOG_TICKS = 40;       // a stall longer than this pauses the day instead of fast-forwarding it
const NOISE_ORDER_TTL_TICKS = 40;   // noise-bot limit orders expire after 10 sim-minutes (keeps the book small)

const HUMAN_ACTIONS = new Set(['SUBMIT_ORDER', 'CANCEL_ORDER', 'MODIFY_ORDER', 'MODIFY_BRACKET', 'CANCEL_BRACKET']);

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
// 3. ORDER BOOK MATCHING ENGINE
// ===================================================================
class OrderBook {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.bids = []; // best (highest) first
    this.asks = []; // best (lowest) first
    this.lastPrice = 100.0;
    this.currentTick = 0;
    this.seq = 0;
  }

  nextId(prefix = 'o') {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  getMidPrice() {
    if (this.bids.length > 0 && this.asks.length > 0) return (this.bids[0].price + this.asks[0].price) / 2;
    if (this.bids.length > 0) return this.bids[0].price;
    if (this.asks.length > 0) return this.asks[0].price;
    return this.lastPrice || 100.0;
  }

  // Binary insert keeps price-time priority without re-sorting the whole book.
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
  }

  clearPlayerOrders(playerId) {
    this.bids = this.bids.filter((b) => b.playerId !== playerId);
    this.asks = this.asks.filter((a) => a.playerId !== playerId);
  }

  expireOrders(tick) {
    const alive = (o) => o.expiresAt == null || o.expiresAt > tick;
    this.bids = this.bids.filter(alive);
    this.asks = this.asks.filter(alive);
  }

  findOrder(orderId) {
    let order = this.bids.find((o) => o.id === orderId);
    if (order) return { order, side: 'BUY' };
    order = this.asks.find((o) => o.id === orderId);
    return order ? { order, side: 'SELL' } : null;
  }

  removeOrder(orderId, playerId) {
    for (const [book, side] of [[this.bids, 'BUY'], [this.asks, 'SELL']]) {
      const idx = book.findIndex((o) => o.id === orderId && o.playerId === playerId);
      if (idx !== -1) return { order: book.splice(idx, 1)[0], side };
    }
    return null;
  }

  cancelOrder(orderId, playerId) {
    return this.removeOrder(orderId, playerId) !== null;
  }

  getPlayerOpenOrders(playerId) {
    return [
      ...this.bids.filter((b) => b.playerId === playerId).map((b) => ({ ...b, side: 'BUY' })),
      ...this.asks.filter((a) => a.playerId === playerId).map((a) => ({ ...a, side: 'SELL' }))
    ];
  }

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
      if (top.qty <= 0) book.shift();
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
// 5. BOT ECOSYSTEM
// Bot ids contain a colon, which player handles can never contain.
// ===================================================================
class MarketMakerBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.spread = 0.05 + Math.random() * 0.05;
    this.baseQty = Math.floor(Math.random() * 20) + 15;
  }

  onTick() {
    this.orderBook.clearPlayerOrders(this.id);
    const mid = this.orderBook.getMidPrice();

    for (let level = 1; level <= 4; level++) {
      const bidPrice = parseFloat((mid - this.spread * level).toFixed(2));
      const askPrice = parseFloat((mid + this.spread * level).toFixed(2));
      if (bidPrice > 0) {
        this.orderBook.processOrder({ playerId: this.id, side: 'BUY', price: bidPrice, qty: this.baseQty * level, type: 'LIMIT' });
      }
      this.orderBook.processOrder({ playerId: this.id, side: 'SELL', price: askPrice, qty: this.baseQty * level, type: 'LIMIT' });
    }
  }
}

class NoiseBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.actProbability = 0.15;
  }

  onTick() {
    if (Math.random() > this.actProbability) return;
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const isMarket = Math.random() > 0.4;
    const qty = Math.floor(Math.random() * 10) + 1;
    const mid = this.orderBook.getMidPrice();

    if (isMarket) {
      this.orderBook.processOrder({ playerId: this.id, side, price: 0, qty, type: 'MARKET' });
    } else {
      const offset = (Math.random() - 0.5) * 0.3;
      const price = parseFloat((mid + offset).toFixed(2));
      if (price > 0) {
        this.orderBook.processOrder({
          playerId: this.id, side, price, qty, type: 'LIMIT',
          expiresAt: this.orderBook.currentTick + NOISE_ORDER_TTL_TICKS
        });
      }
    }
  }
}

class TrendBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.lookback = Math.floor(Math.random() * 5) + 4;
  }

  onTick(history) {
    if (!history || history.length < this.lookback) return;
    const recent = history.slice(-this.lookback);
    const diff = recent[recent.length - 1].price - recent[0].price;
    if (Math.abs(diff) >= 0.15) {
      const side = diff > 0 ? 'BUY' : 'SELL';
      const qty = Math.floor(Math.random() * 12) + 4;
      this.orderBook.processOrder({ playerId: this.id, side, price: 0, qty, type: 'MARKET' });
    }
  }
}

class MeanReversionBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.period = 10;
  }

  onTick(history) {
    if (!history || history.length < this.period) return;
    const recent = history.slice(-this.period);
    const sma = recent.reduce((acc, p) => acc + p.price, 0) / this.period;
    const dev = this.orderBook.getMidPrice() - sma;
    if (dev > 0.25) {
      this.orderBook.processOrder({ playerId: this.id, side: 'SELL', price: 0, qty: 10, type: 'MARKET' });
    } else if (dev < -0.25) {
      this.orderBook.processOrder({ playerId: this.id, side: 'BUY', price: 0, qty: 10, type: 'MARKET' });
    }
  }
}

class WhaleBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.triggerThreshold = 0.02;
  }

  onTick() {
    if (Math.random() > this.triggerThreshold) return;
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const blockQty = Math.floor(Math.random() * 60) + 30;
    this.orderBook.processOrder({ playerId: this.id, side, price: 0, qty: blockQty, type: 'MARKET' });
  }
}

class BotFleet {
  constructor(orderBook) {
    this.bots = [];
    for (let i = 0; i < 90; i++) this.bots.push(new NoiseBot(`bot:noise_${i}`, orderBook));
    for (let i = 0; i < 5; i++) this.bots.push(new TrendBot(`bot:trend_${i}`, orderBook));
    for (let i = 0; i < 5; i++) this.bots.push(new MeanReversionBot(`bot:mr_${i}`, orderBook));
    for (let i = 0; i < 3; i++) this.bots.push(new MarketMakerBot(`bot:mm_${i}`, orderBook));
    for (let i = 0; i < 3; i++) this.bots.push(new WhaleBot(`bot:whale_${i}`, orderBook));
  }

  onTick(history) {
    for (let i = 0; i < this.bots.length; i++) this.bots[i].onTick(history);
  }
}

// ===================================================================
// 6. UI COMPONENTS
// ===================================================================
function createToaster(container) {
  const tones = {
    info: 'bg-slate-900 border-slate-700 text-slate-200',
    success: 'bg-emerald-950 border-emerald-700 text-emerald-200',
    warn: 'bg-amber-950 border-amber-700 text-amber-200',
    error: 'bg-red-950 border-red-800 text-red-200'
  };
  return (text, level = 'info') => {
    if (!container) {
      console.log(`[${level}] ${text}`);
      return;
    }
    while (container.children.length >= 4) container.firstChild.remove();
    const el = document.createElement('div');
    el.className = `pointer-events-auto max-w-xs px-3 py-2 rounded-lg border text-xs font-mono shadow-lg transition-opacity duration-300 ${tones[level] || tones.info}`;
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

  render(bids = [], asks = [], midPrice = 100.0) {
    if (this.midDisplay) this.midDisplay.innerText = '$' + midPrice.toFixed(2);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const spread = bestAsk && bestBid ? (bestAsk - bestBid).toFixed(2) : '0.00';
    if (this.spreadDisplay) this.spreadDisplay.innerText = '$' + spread;

    const row = (o, tone) => `
      <div class="grid grid-cols-3 text-${tone}-400 hover:bg-${tone}-500/10 px-1 py-0.5 rounded transition-colors font-mono text-xs">
        <span>$${o.price.toFixed(2)}</span>
        <span class="text-right font-bold">${o.qty}</span>
        <span class="text-right text-slate-500">${(o.price * o.qty).toFixed(0)}</span>
      </div>`;

    if (this.asksContainer) {
      const n = this.rowsThatFit(this.asksContainer);
      this.asksContainer.innerHTML = asks.slice(0, n).reverse().map((a) => row(a, 'red')).join('');
    }
    if (this.bidsContainer) {
      const n = this.rowsThatFit(this.bidsContainer);
      this.bidsContainer.innerHTML = bids.slice(0, n).map((b) => row(b, 'emerald')).join('');
    }
  }

  // Show as many levels as the column has room for, so a taller book
  // (short-window layout) fills up instead of leaving empty space.
  rowsThatFit(container) {
    const probe = container.firstElementChild;
    const probeHeight = probe ? probe.getBoundingClientRect().height : 0;
    if (probeHeight > 0) this.rowPx = probeHeight + 2; // + space-y-0.5 gap
    if (!this.rowPx || container.clientHeight === 0) return 7;
    return Math.max(1, Math.floor((container.clientHeight + 2) / this.rowPx));
  }
}

class ChartUI {
  constructor(eventBus, getCurrentUserId) {
    this.eventBus = eventBus;
    this.getCurrentUserId = getCurrentUserId;
    this.canvas = document.getElementById('priceChartCanvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.clockDisplay = document.getElementById('sim-clock');

    this.timeframeSteps = { '1M': 4, '5M': 20, '10M': 40, '1H': 240, ALL: null };
    this.activeTimeframe = '5M';
    this.history = [];
    this.levels = [];

    this.initListeners();
  }

  initListeners() {
    const buttons = document.querySelectorAll('.tf-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tf = e.target.getAttribute('data-tf');
        if (tf && tf in this.timeframeSteps) {
          this.activeTimeframe = tf;
          buttons.forEach((b) => (b.className = 'tf-btn px-2 py-0.5 rounded text-slate-400 hover:text-white transition-colors cursor-pointer'));
          e.target.className = 'tf-btn px-2 py-0.5 rounded bg-blue-600 text-white font-bold transition-colors cursor-pointer';
          this.draw();
        }
      });
    });

    this.eventBus.on('TICK', (data) => {
      if (!data || !data.priceHistory) return;
      this.history = data.priceHistory;
      if (data.simTimeStr && this.clockDisplay) this.clockDisplay.innerText = data.simTimeStr;

      const me = this.getCurrentUserId();
      const orders = (data.playerOrders && data.playerOrders[me]) || [];
      const brackets = (data.brackets && data.brackets[me]) || [];
      this.levels = [
        ...orders.map((o) => ({ price: o.price, color: '#94a3b8', label: `${o.side} ${o.qty}` })),
        ...brackets.flatMap((b) => [
          b.sl != null ? { price: b.sl, color: '#ef4444', label: 'SL' } : null,
          b.tp != null ? { price: b.tp, color: '#10b981', label: 'TP' } : null
        ].filter(Boolean))
      ];
      this.draw();
    });

    window.addEventListener('resize', () => this.draw());
    document.addEventListener('visibilitychange', () => this.draw());
  }

  draw() {
    // Hidden tabs can't see the chart anyway; skip the work and redraw on return.
    if (document.hidden || !this.canvas || !this.ctx || this.history.length === 0) return;

    const width = (this.canvas.width = this.canvas.parentElement.clientWidth || 400);
    const height = (this.canvas.height = this.canvas.parentElement.clientHeight || 200);
    this.ctx.clearRect(0, 0, width, height);

    const isAll = this.activeTimeframe === 'ALL';
    const visibleData = isAll ? this.history : this.history.slice(-this.timeframeSteps[this.activeTimeframe]);
    if (visibleData.length < 2) return;

    const prices = visibleData.map((d) => d.price);
    let min = Math.min(...prices);
    let max = Math.max(...prices);
    if (min === max) {
      min -= 0.5;
      max += 0.5;
    } else {
      const pad = (max - min) * 0.1;
      min -= pad;
      max += pad;
    }
    const range = max - min;
    const yFor = (p) => height - ((p - min) / range) * height;

    this.ctx.strokeStyle = '#1e293b';
    this.ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (height / 4) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }

    this.ctx.beginPath();
    this.ctx.strokeStyle = '#3b82f6';
    this.ctx.lineWidth = 2;
    const maxSteps = isAll ? visibleData.length : this.timeframeSteps[this.activeTimeframe];
    const stepWidth = width / (maxSteps - 1);
    const startOffsetIndex = maxSteps - visibleData.length;
    visibleData.forEach((item, index) => {
      const x = (startOffsetIndex + index) * stepWidth;
      const y = yFor(item.price);
      if (index === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });
    this.ctx.stroke();

    // Your working orders and SL/TP levels (only those inside the visible range)
    this.ctx.save();
    this.ctx.setLineDash([4, 4]);
    this.ctx.lineWidth = 1;
    this.ctx.font = '10px monospace';
    for (const lv of this.levels) {
      if (lv.price < min || lv.price > max) continue;
      const y = yFor(lv.price);
      this.ctx.strokeStyle = lv.color;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
      const text = `${lv.label} $${lv.price.toFixed(2)}`;
      this.ctx.fillStyle = lv.color;
      this.ctx.fillText(text, width - this.ctx.measureText(text).width - 6, y - 3);
    }
    this.ctx.restore();

    this.ctx.fillStyle = '#64748b';
    this.ctx.font = '10px monospace';
    this.ctx.fillText(`$${max.toFixed(2)}`, 8, 14);
    this.ctx.fillText(`$${min.toFixed(2)}`, 8, height - 6);
  }
}

const BTN_TONES = {
  neutral: 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700',
  danger: 'bg-red-950/80 hover:bg-red-900 text-red-300 hover:text-white border-red-800',
  primary: 'bg-blue-600 hover:bg-blue-500 text-white border-blue-500'
};

function actionBtn(action, id, label, tone = 'neutral') {
  return `<button type="button" data-action="${action}" data-id="${escapeHtml(id)}" class="text-[10px] ${BTN_TONES[tone]} border px-1.5 py-0.5 rounded transition-colors cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-blue-400">${label}</button>`;
}

function levelTags(sl, tp) {
  const tags = [];
  if (sl != null) tags.push(`<span class="text-red-400">SL $${sl.toFixed(2)}</span>`);
  if (tp != null) tags.push(`<span class="text-emerald-400">TP $${tp.toFixed(2)}</span>`);
  return tags.length ? `<div class="mt-0.5 flex gap-3 text-[10px]">${tags.join('')}</div>` : '';
}

function editFields(fields) {
  return `<div class="grid grid-cols-2 gap-1.5 mt-1.5">${fields.map((f) => `
    <label class="block">
      <span class="block text-[9px] text-slate-500 uppercase mb-0.5">${f.label}</span>
      <input data-field="${f.name}" type="number" inputmode="decimal" step="${f.step || '0.01'}" min="0" value="${f.value ?? ''}" placeholder="${f.placeholder || ''}"
        class="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-white font-mono text-[11px] focus:outline-none focus:border-blue-500 placeholder:text-slate-600" />
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
      if (!btn) continue;
      btn.disabled = !open;
      btn.classList.toggle('opacity-40', !open);
      btn.classList.toggle('cursor-not-allowed', !open);
    }
    if (!open) {
      this.editing = null;
      this.renderAll(true);
    }
  }

  setOrderType(type) {
    this.orderType = type;
    const on = 'py-1 text-center rounded bg-blue-600 text-white font-bold transition-colors cursor-pointer';
    const off = 'py-1 text-center rounded text-slate-400 hover:text-white transition-colors cursor-pointer';
    if (this.typeMarketBtn) this.typeMarketBtn.className = type === 'MARKET' ? on : off;
    if (this.typeLimitBtn) this.typeLimitBtn.className = type === 'MARKET' ? off : on;
    if (this.priceContainer) this.priceContainer.classList.toggle('opacity-30', type === 'MARKET');
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
      ? `<div class="text-[10px] text-slate-600 italic py-1">No active open orders</div>`
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
      ? `<div class="text-[10px] text-slate-600 italic py-1">No stop loss or take profit on open positions</div>`
      : this.myBrackets.map((b) => this.bracketRow(b)).join('');
    this.replaceHtml(this.bracketsList, html);
  }

  orderRow(o) {
    const isBuy = o.side === 'BUY';
    const sideColor = isBuy ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : 'text-red-400 bg-red-500/10 border-red-500/20';
    const editing = this.editing && this.editing.kind === 'order' && this.editing.id === o.id;

    const header = `
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-2">
          <span class="text-[9px] font-bold px-1 rounded border ${sideColor}">${o.side}</span>
          <span class="text-white font-bold">${o.qty}</span>
          <span class="text-slate-400">@</span>
          <span class="text-slate-200">$${o.price.toFixed(2)}</span>
        </div>
        ${editing ? '' : `<div class="flex gap-1">${actionBtn('edit-order', o.id, 'Edit')}${actionBtn('cancel-order', o.id, 'Delete', 'danger')}</div>`}
      </div>`;

    const body = editing
      ? editFields([
          { name: 'price', label: 'Limit price', value: o.price.toFixed(2) },
          { name: 'qty', label: 'Quantity', value: o.qty, step: '1' },
          { name: 'sl', label: 'Stop loss', value: o.sl != null ? o.sl.toFixed(2) : '', placeholder: 'None' },
          { name: 'tp', label: 'Take profit', value: o.tp != null ? o.tp.toFixed(2) : '', placeholder: 'None' }
        ]) + `<div class="flex justify-end gap-1 mt-1.5">${actionBtn('close-edit', o.id, 'Close')}${actionBtn('save-order', o.id, 'Save', 'primary')}</div>`
      : levelTags(o.sl, o.tp);

    return `<div data-row="${escapeHtml(o.id)}" ${editing ? `data-editing="order:${escapeHtml(o.id)}"` : ''}
      class="bg-slate-950 border ${editing ? 'border-blue-600/60' : 'border-slate-800/80'} rounded px-2 py-1 text-[11px] font-mono">${header}${body}</div>`;
  }

  bracketRow(b) {
    const isLong = b.exitSide === 'SELL';
    const badge = isLong ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : 'text-red-400 bg-red-500/10 border-red-500/20';
    const editing = this.editing && this.editing.kind === 'bracket' && this.editing.id === b.id;

    const header = `
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-2">
          <span class="text-[9px] font-bold px-1 rounded border ${badge}">${isLong ? 'LONG' : 'SHORT'}</span>
          <span class="text-white font-bold">${b.qty}</span>
          <span class="text-slate-500">shares</span>
        </div>
        ${editing ? '' : `<div class="flex gap-1">${actionBtn('edit-bracket', b.id, 'Edit')}${actionBtn('remove-bracket', b.id, 'Remove', 'danger')}</div>`}
      </div>`;

    const body = editing
      ? editFields([
          { name: 'sl', label: 'Stop loss', value: b.sl != null ? b.sl.toFixed(2) : '', placeholder: 'None' },
          { name: 'tp', label: 'Take profit', value: b.tp != null ? b.tp.toFixed(2) : '', placeholder: 'None' }
        ]) + `<div class="flex justify-end gap-1 mt-1.5">${actionBtn('close-edit', b.id, 'Close')}${actionBtn('save-bracket', b.id, 'Save', 'primary')}</div>`
      : levelTags(b.sl, b.tp);

    return `<div data-row="${escapeHtml(b.id)}" ${editing ? `data-editing="bracket:${escapeHtml(b.id)}"` : ''}
      class="bg-slate-950 border ${editing ? 'border-blue-600/60' : 'border-slate-800/80'} rounded px-2 py-1 text-[11px] font-mono">${header}${body}</div>`;
  }

  // ---- Account panel -----------------------------------------------------

  renderAccount(acc) {
    if (!acc) return;
    if (this.portCash) this.portCash.innerText = fmtMoney(acc.cash);
    if (this.portShares) {
      this.portShares.innerText = acc.shares;
      this.portShares.className = `font-bold ${acc.shares < 0 ? 'text-red-400' : acc.shares > 0 ? 'text-emerald-400' : 'text-slate-300'}`;
    }
    if (this.portAvgPrice) this.portAvgPrice.innerText = fmtMoney(acc.avgEntry);
    if (this.portRealized) {
      const r = acc.realizedPnL || 0;
      this.portRealized.innerText = fmtSigned(r);
      this.portRealized.className = `font-bold ${round2(r) >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
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
      this.portUnrealized.className = `font-bold ${round2(unrealized) >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
    }
  }
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
    this.backBtn = $('btn-back-to-menu');
    if (this.backBtn) this.backBtn.addEventListener('click', () => window.location.reload());
  }

  show(results, me, fallbackAccount) {
    if (!this.root || !results) return;
    const standings = results.standings || [];
    let mine = standings.find((s) => s.id === me);
    if (!mine && fallbackAccount) {
      mine = {
        id: me,
        realized: fallbackAccount.realizedPnL,
        unrealized: fallbackAccount.unrealized(results.finalPrice),
        total: fallbackAccount.totalPnL(results.finalPrice),
        shares: fallbackAccount.shares
      };
    }
    mine = mine || { total: 0, realized: 0, unrealized: 0, shares: 0 };

    const rank = standings.findIndex((s) => s.id === me) + 1;
    const isMulti = standings.length > 1;
    const tone = (v) => (round2(v) >= 0 ? 'text-emerald-400' : 'text-red-400');

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
      this.pnl.className = `text-4xl font-extrabold font-mono-num ${tone(mine.total)}`;
    }
    if (this.ret) this.ret.innerText = `${fmtPct((mine.total / STARTING_CASH) * 100)} on ${fmtMoney(STARTING_CASH)} starting cash`;
    if (this.realized) {
      this.realized.innerText = fmtSigned(mine.realized);
      this.realized.className = `font-bold ${tone(mine.realized)}`;
    }
    if (this.unrealized) {
      this.unrealized.innerText = fmtSigned(mine.unrealized);
      this.unrealized.className = `font-bold ${tone(mine.unrealized)}`;
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
          <div class="flex items-center justify-between bg-slate-950 border ${isMe ? 'border-blue-600/60' : 'border-slate-800/80'} rounded px-3 py-2 text-xs font-mono">
            <span class="flex items-center gap-3 min-w-0">
              <span class="w-5 ${i === 0 ? 'text-amber-400 font-bold' : 'text-slate-500'}">${i + 1}</span>
              <span class="text-white truncate">${escapeHtml(s.id)}${isMe ? ' <span class="text-slate-500">(You)</span>' : ''}</span>
            </span>
            <span class="flex items-center gap-3 shrink-0">
              <span class="font-bold ${tone(s.total)}">${fmtSigned(s.total)}</span>
              <span class="w-16 text-right text-slate-500">${fmtPct((s.total / STARTING_CASH) * 100)}</span>
            </span>
          </div>`;
      }).join('');
    }

    this.root.classList.remove('hidden');
    if (this.backBtn) this.backBtn.focus();
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
  constructor(orderBook, { durationMinutes = GAME_DURATION_MINUTES, afterStep, onPulse, onFinish } = {}) {
    this.orderBook = orderBook;
    this.botFleet = new BotFleet(orderBook);
    this.afterStep = afterStep;
    this.onPulse = onPulse;
    this.onFinish = onFinish;

    this.totalTicks = TOTAL_TICKS;
    this.tickIntervalMs = (durationMinutes * 60 * 1000) / this.totalTicks; // ≈294 ms for 10 minutes

    this.ticksDone = 0;
    this.simulatedSeconds = SESSION_OPEN_SECS;
    this.priceHistory = [];
    this.running = false;
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
    this.priceHistory = [this.makePoint()];
    this.startedAt = performance.now();
    this.running = true;
    this.clock.start();
    if (this.onPulse) this.onPulse([this.priceHistory[0]]);
  }

  stop() {
    this.running = false;
    this.clock.stop();
  }

  // Runs however many ticks the wall clock says are due, so the day always
  // lasts GAME_DURATION_MINUTES even if pulses arrive late or bunched up.
  pump() {
    if (!this.running) return;
    let due = Math.min(this.totalTicks, Math.floor((performance.now() - this.startedAt) / this.tickIntervalMs));
    const backlog = due - this.ticksDone;
    if (backlog > MAX_BACKLOG_TICKS) {
      // Host was frozen (sleeping laptop, suspended tab). Pause instead of fast-forwarding.
      const skip = backlog - MAX_BACKLOG_TICKS;
      this.startedAt += skip * this.tickIntervalMs;
      due -= skip;
    }

    const points = [];
    while (this.ticksDone < due) points.push(this.step());
    if (points.length && this.onPulse) this.onPulse(points);

    if (this.ticksDone >= this.totalTicks) {
      this.finished = true;
      this.stop();
      if (this.onFinish) this.onFinish();
    }
  }

  step() {
    this.ticksDone += 1;
    this.simulatedSeconds = SESSION_OPEN_SECS + this.ticksDone * SIM_SECS_PER_TICK;
    this.orderBook.currentTick = this.ticksDone;
    this.orderBook.expireOrders(this.ticksDone);
    this.botFleet.onTick(this.priceHistory);
    if (this.afterStep) this.afterStep();
    const point = this.makePoint();
    this.priceHistory.push(point);
    return point;
  }

  makePoint() {
    return { price: this.orderBook.getMidPrice(), simTimeStr: formatSimTime(this.simulatedSeconds), simSecs: this.simulatedSeconds };
  }
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

  const gameLoop = new GameLoop(orderBook, {
    durationMinutes: GAME_DURATION_MINUTES,
    afterStep: () => brackets.evaluate(),
    onPulse: (points) => publishState(points),
    onFinish: () => closeMarket()
  });

  new BookUI(eventBus);
  new ChartUI(eventBus, getCurrentUserId);
  new ControlsUI(eventBus, accountManager, getCurrentUserId, toast);
  const gameOverUI = new GameOverUI();

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
  const displayRoomCode = $('display-room-code');
  const playerList = $('player-list');
  const playerCount = $('player-count');
  const hostControls = $('host-controls');
  const clientStatus = $('client-status');
  const roomBadge = $('room-badge');
  const roomCodeDisplay = $('room-code-display');
  const sessionProgress = $('session-progress');

  eventBus.on('TICK', (data) => {
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
      <div class="flex items-center justify-between bg-slate-950 border border-slate-800/80 rounded px-3 py-2 text-xs">
        <span class="font-mono text-white flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
          ${escapeHtml(p.id)}${p.id === currentUserId ? ' <span class="text-slate-500">(You)</span>' : ''}
        </span>
        <span class="text-[10px] font-mono px-1.5 py-0.5 rounded ${p.isHost ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-slate-800 text-slate-400'}">
          ${p.isHost ? 'HOST' : 'CLIENT'}
        </span>
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

  function launchTradingScreen() {
    if (lobbyScreen) lobbyScreen.classList.add('hidden');
    if (tradingScreen) tradingScreen.classList.remove('hidden');
  }

  function seedInitialLiquidity() {
    orderBook.processOrder({ playerId: 'bot:mm_0', side: 'BUY', price: 99.8, qty: 50, type: 'LIMIT' });
    orderBook.processOrder({ playerId: 'bot:mm_0', side: 'BUY', price: 99.5, qty: 100, type: 'LIMIT' });
    orderBook.processOrder({ playerId: 'bot:mm_0', side: 'SELL', price: 100.2, qty: 50, type: 'LIMIT' });
    orderBook.processOrder({ playerId: 'bot:mm_0', side: 'SELL', price: 100.5, qty: 100, type: 'LIMIT' });
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
      bids: orderBook.bids.slice(0, BOOK_DEPTH).map((o) => ({ price: o.price, qty: o.qty })),
      asks: orderBook.asks.slice(0, BOOK_DEPTH).map((o) => ({ price: o.price, qty: o.qty })),
      playerOrders: collectHumanOrders(),
      brackets: brackets.byPlayer()
    };
    eventBus.emit('TICK', { ...payload, priceHistory: gameLoop.priceHistory });
    if (role === 'host') peerNetwork.broadcast({ type: 'SYNC_TICK', payload });
  }

  // Only trades involving a human matter to clients (bot-vs-bot trades were
  // previously broadcast one message each).
  eventBus.on('TRADE', (t) => {
    if (role !== 'host') return;
    if (ledger.has(t.buyerId) || ledger.has(t.sellerId)) {
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
    seedInitialLiquidity();
    marketOpen = true;
    eventBus.emit('MARKET_STATE', { open: true });
    accountManager.broadcastState();
    launchTradingScreen();
    gameLoop.start();
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
      standings: ledger.standings(finalPrice)
    };
    if (role === 'host') peerNetwork.broadcast({ type: 'GAME_OVER', results });
    endGame(results);
  }

  function endGame(results) {
    marketOpen = false;
    eventBus.emit('MARKET_STATE', { open: false });
    gameOverUI.show(results, currentUserId, accountManager);
  }

  // ---- Networking -----------------------------------------------------------

  eventBus.on('NET_HOST_CONNECTED', () => {
    peerNetwork.broadcast({ type: 'JOIN_LOBBY', handle: currentUserId, token: joinToken });
  });

  function onHostMessage(data) {
    if (data.type === 'JOIN_LOBBY') {
      if (marketOpen || gameLoop.finished) {
        peerNetwork.broadcast({ type: 'JOIN_REJECTED', token: data.token, reason: 'This game has already started.' });
        return;
      }
      let id = data.token ? tokenToId.get(data.token) : null;
      if (!id) {
        id = uniquePlayerId(sanitizeHandle(data.handle));
        if (data.token) tokenToId.set(data.token, id);
        connectedPlayers.push({ id, isHost: false });
        ledger.register(id);
      }
      peerNetwork.broadcast({ type: 'WELCOME', token: data.token, playerId: id });
      peerNetwork.broadcast({ type: 'LOBBY_UPDATE', players: connectedPlayers });
      renderPlayerList();
    } else if (HUMAN_ACTIONS.has(data.type)) {
      handleAction(data, data.playerId);
      if (marketOpen) publishState();
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
        role = 'lobby';
        if (lobbyMenu) lobbyMenu.classList.remove('hidden');
        if (waitingRoom) waitingRoom.classList.add('hidden');
        break;
      case 'START_GAME':
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
      case 'NOTICE':
        if (data.playerId === currentUserId) toast(data.text, data.level);
        break;
      case 'GAME_OVER':
        endGame(data.results);
        break;
      default:
        break;
    }
  }

  eventBus.on('NET_DATA_RECEIVED', ({ data } = {}) => {
    if (!data || typeof data !== 'object') return;
    if (role === 'host') onHostMessage(data);
    else if (role === 'client') onClientMessage(data);
  });

  // ---- Lobby buttons --------------------------------------------------------

  if (btnSinglePlayer) {
    btnSinglePlayer.addEventListener('click', () => {
      if (role !== 'lobby') return;
      role = 'solo';
      currentUserId = getTraderName();
      ledger.register(currentUserId);
      accountManager.setPlayerId(currentUserId);
      beginMarket();
    });
  }

  if (btnHostMultiplayer) {
    btnHostMultiplayer.addEventListener('click', () => {
      if (role !== 'lobby') return;
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
    });
  }

  if (btnStartGame) {
    btnStartGame.addEventListener('click', () => {
      if (role !== 'host' || marketOpen || gameLoop.finished) return;
      btnStartGame.disabled = true;
      peerNetwork.broadcast({ type: 'START_GAME' });
      beginMarket();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// src/engine/bots.js
// Every trading strategy in the market. Bots read a shared MarketState `m`
// (built once per tick by BotFleet) and trade through BaseBot helpers.
// Positions are tracked from actual fills, so exit rules (stop/target,
// "close when flat", "sell 10 steps later") act on what really executed.

import { random, gauss } from './random.js';

const round2 = (n) => Math.round(n * 100) / 100;
const floor2 = (n) => Math.floor(n * 100 + 1e-9) / 100;
const ceil2 = (n) => Math.ceil(n * 100 - 1e-9) / 100;
export const rand = (a, b) => a + random() * (b - a);
export const randInt = (a, b) => Math.floor(a + random() * (b - a + 1));
export const chance = (p) => random() < p;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (arr) => arr[Math.floor(random() * arr.length)];

// Order size the way people pick them: mostly small, now and then large
// (log-normal around `median`), and bigger orders often rounded to 5/10/25/50/100.
function humanSize(median, max = 1000) {
  const q = clamp(Math.round(median * Math.exp(0.9 * gauss())), 1, max);
  if (q < 20 || chance(0.4)) return q;
  const step = q >= 200 ? 100 : q >= 100 ? 50 : q >= 50 ? 25 : 10;
  return Math.max(step, Math.round(q / step) * step);
}

// ===================================================================
// TUNING: the handful of numbers that set how the market behaves.
// Prices are fractions of the current price (0.001 = 0.1%).
// ===================================================================
export const TUNING = {
  noiseSigmaFloor: 0.0008,   // noise limits sit 1–3σ away; σ never below this…
  noiseSigmaCap: 0.003,      // …or above this, so liquidity can't flee in a panic
  noiseTtl: [6, 30],         // noise limit orders rest 1.5–7.5 sim minutes
  noiseActivity: [0.02, 0.05],
  makerSize: [6, 15],        // shares per level unit (levels are 1×, 2×, 3×)
  makerHalfSpread: [0.0001, 0.0003], // base half-spread
  makerMaxHalfSpread: 0.0008,        // half-spread never wider than this
  makerMaxInventory: [300, 800],     // hard inventory limit (stops quoting that side)
  makerPickoff: 0.5,                 // makers take orders this many half-spreads through fair value
  makerLean: 4,                      // at the limit, quotes shift this many half-spreads
                                     //   against the inventory (0 = no leaning)
  valueVol: 0.0003,                  // per-step volatility of the hidden fair value ("news"):
                                     //   the main dial for how much the price moves
  newsVolOfVol: 0.6,                 // how much news intensity swings between quiet and busy
                                     //   stretches (0 = constant; drives volatility clustering)
  newsRegimeMinutes: 45,             // how long a quiet or busy stretch typically lasts
  newsMaxScale: 3,                   // news is never more than this many times normal
  valuePull: 0.02,                   // fair value drifts this much toward where the market trades
  makerValueWeight: [0.8, 1.0],      // how closely each maker centres its quotes on fair value
  valueEventDrift: 0.0002,           // per-step fair-value drift at full event strength (US open)
  trend2Activity: [0.01, 0.03],      // how often trend bot 2 checks the book
  heatPower: 0.5,                    // attention: noise-type traders act heat^this times as
                                     //   often (heat = recent volatility vs the last hour)
  randomLimitActivity: [0.03, 0.08], // random limit givers: chance of a new order per step
  randomLimitTail: 1.2,              // power-law tail of their distance from the best price
                                     //   (lower = more orders far from the price)
  randomBuyerActivity: [0.002, 0.006], // random buyers: chance of a buy per step (× attention)
  reverterSize: [40, 200]            // aggressive reverters: shares per reaction
};

// ===================================================================
// BASE BOT
// ===================================================================
export class BaseBot {
  constructor(id, fleet, opts = {}) {
    this.id = id;
    this.fleet = fleet;
    this.book = fleet.book;
    this.cohort = opts.cohort || 'base';
    this.biasFn = opts.biasFn || null; // event cohorts lean one way: returns -1..1
    this.shares = 0;
    this.avgEntry = 0;
    this.realized = 0;
    this.orders = new Set(); // resting order ids
    this.pending = null;     // delayed reaction { action, at }
    this.maxPosition = Infinity; // risk limit for bots that only ever add
  }

  // Shares this bot may still add on `side` without breaching its position limit
  capped(side, qty) {
    const room = side === 'BUY' ? this.maxPosition - this.shares : this.maxPosition + this.shares;
    return Math.max(0, Math.min(qty, room));
  }

  get type() { return this.constructor.TYPE; }

  // Directional tilt from an event (0 for ordinary traders)
  get tilt() { return this.biasFn ? this.biasFn() : 0; }

  // Random side, nudged toward the event direction if there is one
  pickSide() { return random() < 0.5 + this.tilt / 2 ? 'BUY' : 'SELL'; }

  // Event cohorts mostly skip trades that go against their direction
  allows(side) {
    const b = this.tilt;
    if (!b) return true;
    return (side === 'BUY') === (b > 0) || random() > Math.abs(b);
  }

  market(side, qty) {
    qty = Math.floor(qty);
    if (qty <= 0) return null;
    return this.book.processOrder({ id: this.book.nextId('b'), playerId: this.id, side, type: 'MARKET', qty });
  }

  limit(side, price, qty, ttlTicks = null) {
    price = round2(price);
    qty = Math.floor(qty);
    if (!(price > 0) || qty <= 0) return null;
    const res = this.book.processOrder({
      id: this.book.nextId('b'), playerId: this.id, side, type: 'LIMIT', price, qty,
      expiresAt: ttlTicks ? this.fleet.tick + ttlTicks : null
    });
    if (res && res.restingQty > 0) {
      this.orders.add(res.id);
      if (this.orders.size > 24) this.pruneOrders();
    }
    return res;
  }

  pruneOrders() {
    for (const id of this.orders) if (!this.book.has(id)) this.orders.delete(id);
  }

  cancelAll() {
    for (const id of this.orders) this.book.removeOrder(id, this.id);
    this.orders.clear();
  }

  flatten() {
    if (this.shares > 0) this.market('SELL', this.shares);
    else if (this.shares < 0) this.market('BUY', -this.shares);
  }

  // Return on the current holding, e.g. -0.01 = down 1%
  pnlPct(mid) {
    if (this.shares === 0 || !this.avgEntry) return 0;
    return this.shares > 0 ? (mid - this.avgEntry) / this.avgEntry : (this.avgEntry - mid) / this.avgEntry;
  }

  onFill(side, price, qty) {
    if (side === 'BUY') {
      if (this.shares < 0) {
        const c = Math.min(qty, -this.shares);
        this.realized += (this.avgEntry - price) * c;
        this.shares += c;
        qty -= c;
        if (this.shares === 0) this.avgEntry = 0;
      }
      if (qty > 0) {
        this.avgEntry = (this.shares * this.avgEntry + qty * price) / (this.shares + qty);
        this.shares += qty;
      }
    } else {
      if (this.shares > 0) {
        const c = Math.min(qty, this.shares);
        this.realized += (price - this.avgEntry) * c;
        this.shares -= c;
        qty -= c;
        if (this.shares === 0) this.avgEntry = 0;
      }
      if (qty > 0) {
        const s = -this.shares;
        this.avgEntry = (s * this.avgEntry + qty * price) / (s + qty);
        this.shares -= qty;
      }
    }
  }

  // People don't all react on the same tick: act `delay` ticks from now.
  later(delay, action) {
    this.pending = { action, at: this.fleet.tick + delay };
  }

  tick(m) {
    if (this.pending && this.fleet.tick >= this.pending.at) {
      const { action } = this.pending;
      this.pending = null;
      action(m);
    }
    this.onTick(m);
  }

  onTick() {}

  onLeave() {
    this.cancelAll();
    this.pending = null;
  }
}

// ===================================================================
// 1. NOISE: random side, random market/limit; limits 1–3σ from price.
// Buy limits rest below the price and sell limits above, so noise traders
// also build the deeper book. In an event cohort, orders in the event's
// direction are placed through the price instead (above it in an up move).
// Like everyone who isn't paid to watch the screen, they trade more when
// the market is moving (attention, see MarketState.attention).
// ===================================================================
export class NoiseBot extends BaseBot {
  static TYPE = 'noise';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.activity = opts.activity ?? rand(...TUNING.noiseActivity);
  }

  onTick(m) {
    if (!chance(this.activity * m.attention)) return;
    const side = this.pickSide();
    const qty = randInt(1, 50);
    if (chance(0.5)) {
      this.market(side, qty);
      return;
    }
    const k = rand(1, 3) * m.sigma;
    const b = this.tilt;
    const aggressive = b !== 0 && (side === 'BUY') === (b > 0) && chance(Math.abs(b));
    const price = (side === 'BUY') !== aggressive ? m.mid - k : m.mid + k;
    this.limit(side, price, qty, randInt(...TUNING.noiseTtl));
  }

  // Before the first trade: rest one order so the day opens on a real book
  openingOrder(m) {
    const side = chance(0.5) ? 'BUY' : 'SELL';
    const k = rand(1, 3) * m.sigma;
    this.limit(side, side === 'BUY' ? m.mid - k : m.mid + k, randInt(1, 50), randInt(...TUNING.noiseTtl));
  }
}

// ===================================================================
// 2. MARKET MAKER: quotes both sides on 3 levels around its estimate of
// fair value (the market price blended with a hidden "news" random walk).
// Spread widens a little when the market is jumpy; quotes lean against
// inventory so makers work back toward flat.
// ===================================================================
export class MarketMakerBot extends BaseBot {
  static TYPE = 'marketMaker';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.levels = 3;
    this.size = randInt(...TUNING.makerSize);
    this.baseHalf = rand(...TUNING.makerHalfSpread);
    this.maxInventory = randInt(...TUNING.makerMaxInventory);
    this.valueWeight = rand(...TUNING.makerValueWeight);
  }

  onTick(m) {
    // Read the market as it stands (including our own quotes) before replacing
    // them. Reading it after cancelling would re-centre on older orders further
    // out and pull the price back to where it was.
    const mid = this.book.getMidPrice();
    this.cancelAll(); // re-quote every step

    // Spread: a base width plus a little extra when the market is jumpy, capped
    const half = clamp(this.baseHalf * mid + 0.5 * m.tickSigma, 0.01, TUNING.makerMaxHalfSpread * mid);
    // Quotes centre between the market and the maker's view of fair value, so
    // prices follow news (a random walk) instead of their own momentum. Makers
    // that arrive with the US open lean with their cohort while the event lasts.
    // Inventory: a long maker shades both quotes down (short: up), so it sells
    // a little more than it buys and drifts back toward flat. Without this each
    // maker's inventory is a random walk; on some days they all reach their
    // limit on the same side, stop quoting it, and the book empties (a 2%+ gap
    // in one step). Too strong a lean turns every imbalance into a slow,
    // self-feeding trend. The hard limit stays as a backstop.
    const lean = -TUNING.makerLean * clamp(this.shares / this.maxInventory, -1, 1) * half;
    const centre = mid + this.valueWeight * (m.value - mid) + this.tilt * half * 4 + lean;
    const full = Math.abs(this.shares) >= this.maxInventory;

    // Stale orders: an offer below the maker's fair price (or a bid above it)
    // is free money, so it takes it. This is what keeps a real market
    // efficient. Without it, orders left behind at old prices hold the price
    // back, and it catches up with the news over several minutes: a trend
    // anyone could farm. Picking off never takes a maker past half its limit.
    const edge = TUNING.makerPickoff * half;
    this.pickOff('BUY', centre - edge, this.maxInventory / 2 - this.shares);
    this.pickOff('SELL', centre + edge, this.maxInventory / 2 + this.shares);

    const bestBid = this.book.bestBid();
    const bestAsk = this.book.bestAsk();
    for (let i = 0; i < this.levels; i++) {
      const off = half * (1 + i);
      let bid = floor2(centre - off);
      let ask = ceil2(centre + off);
      if (bestAsk != null) bid = Math.min(bid, round2(bestAsk - 0.01));
      if (bestBid != null) ask = Math.max(ask, round2(bestBid + 0.01));
      const q = this.size * (i + 1);
      if (!(full && this.shares > 0)) this.limit('BUY', bid, q);
      if (!(full && this.shares < 0)) this.limit('SELL', ask, q);
    }
  }

  // Take whatever rests at or better than `price` on the other side, up to
  // three quote sizes and the room left under the inventory limit
  pickOff(side, price, room) {
    let qty = 0;
    for (const l of this.book.levels(side === 'BUY' ? 'SELL' : 'BUY', 5)) {
      if (side === 'BUY' ? l.price > price : l.price < price) break;
      qty += l.qty;
    }
    qty = Math.min(qty, this.size * 3, room);
    if (qty > 0) this.market(side, qty);
  }
}

// ===================================================================
// 3. WHALE: shows up at random and moves 100–1000 shares in one go, as a
// market order or as a limit at the opposite best price (takes the touch,
// the rest rests there).
// ===================================================================
export class WhaleBot extends BaseBot {
  static TYPE = 'whale';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.activity = opts.activity ?? rand(0.002, 0.005);
  }

  onTick() {
    const b = this.tilt;
    if (!chance(this.activity + Math.abs(b) * 0.04)) return;
    const side = b ? (b > 0 ? 'BUY' : 'SELL') : this.pickSide();
    const qty = randInt(100, 1000);
    const touch = side === 'BUY' ? this.book.bestAsk() : this.book.bestBid();
    if (chance(0.5) || touch == null) this.market(side, qty);
    else this.limit(side, touch, qty, 20);
  }
}

// ===================================================================
// 4. THE BUYER: buys 100 every 2 hours from activation. Sells everything
// at -1% or +1.5% on the holding.
// ===================================================================
export class BuyerBot extends BaseBot {
  static TYPE = 'buyer';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.nextTrade = fleet.tick + (opts.delay ?? 0);
    this.interval = fleet.ticksFor(120);
  }

  onTick(m) {
    if (this.shares > 0) {
      const r = this.pnlPct(m.mid);
      if (r <= -0.01 || r >= 0.015) this.flatten();
    }
    if (this.fleet.tick >= this.nextTrade) {
      this.market('BUY', 100);
      this.nextTrade = this.fleet.tick + this.interval;
    }
  }
}

// ===================================================================
// 5. THE SELLER: sells (shorts) 100 every 2 hours; mirror of the buyer,
// covering at -1% or +1.5% on the short.
// ===================================================================
export class SellerBot extends BaseBot {
  static TYPE = 'seller';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.nextTrade = fleet.tick + (opts.delay ?? 0);
    this.interval = fleet.ticksFor(120);
  }

  onTick(m) {
    if (this.shares < 0) {
      const r = this.pnlPct(m.mid);
      if (r <= -0.01 || r >= 0.015) this.flatten();
    }
    if (this.fleet.tick >= this.nextTrade) {
      this.market('SELL', 100);
      this.nextTrade = this.fleet.tick + this.interval;
    }
  }
}

// ===================================================================
// 6. THE LIMIT PLAYER: a ladder around the price when it starts:
// buys at -1/-2/-3/-4% (10/20/30/50), sells at 0/+1/+2/+3% (10/20/30/50).
// With the day opening at $100 that is exactly 99/98/97/96 and 100/101/
// 102/103. Closes out at -1.5% or +1.5% on the position, then re-ladders
// around the new price after a short break.
// ===================================================================
const LADDER_BUYS = [[0.99, 10], [0.98, 20], [0.97, 30], [0.96, 50]];
const LADDER_SELLS = [[1.00, 10], [1.01, 20], [1.02, 30], [1.03, 50]];

export class LimitLadderBot extends BaseBot {
  static TYPE = 'limitLadder';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.deployed = false;
    this.resumeAt = fleet.tick + (opts.delay ?? 0);
  }

  onTick(m) {
    if (this.fleet.tick < this.resumeAt) return;
    if (!this.deployed) {
      const anchor = m.mid;
      for (const [f, q] of LADDER_BUYS) this.limit('BUY', floor2(anchor * f), q);
      for (const [f, q] of LADDER_SELLS) this.limit('SELL', ceil2(anchor * f), q);
      this.deployed = true;
      return;
    }
    if (this.shares !== 0) {
      const r = this.pnlPct(m.mid);
      if (r <= -0.015 || r >= 0.015) {
        this.cancelAll();
        this.flatten();
        this.deployed = false;
        this.resumeAt = this.fleet.tick + this.fleet.ticksFor(10);
      }
    }
  }
}

// ===================================================================
// 7. STD BOT: price 2–3σ below its 30-step mean -> buy; as far above ->
// sell (and always at least 0.1–0.2% away). Takes profit when price is
// back at the mean. Measuring in σ instead of a fixed 0.5% keeps it
// trading on calm days, where 0.5% almost never happens.
// ===================================================================
export class StdBot extends BaseBot {
  static TYPE = 'std';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.size = randInt(10, 60);
    this.activity = rand(0.15, 0.4);
    this.z = rand(2, 3);
    this.minDev = rand(0.001, 0.002);
  }

  onTick(m) {
    if (m.length < 30 || !chance(this.activity)) return;
    const z = m.devZ(30);
    const far = Math.abs(z) >= this.z && Math.abs(m.mid / m.sma(30) - 1) >= this.minDev;
    if (far && z < 0 && this.shares <= 0 && this.allows('BUY')) this.market('BUY', this.size - this.shares);
    else if (far && z > 0 && this.shares >= 0 && this.allows('SELL')) this.market('SELL', this.size + this.shares);
    else if (this.shares !== 0 && Math.abs(z) < 0.3) this.flatten();
  }
}

// ===================================================================
// 8. TREND BOT 1: last 10 minutes of returns mostly positive -> long,
// mostly negative -> short; closes when returns turn mostly flat.
// ===================================================================
export class TrendBot1 extends BaseBot {
  static TYPE = 'trend1';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.window = fleet.ticksFor(10);
    this.enter = rand(0.2, 0.35);   // (ups - downs) / n needed to call it a trend
    this.flat = rand(0.04, 0.1);    // below this it's "mostly flat"
    this.size = randInt(10, 80);
    this.activity = rand(0.15, 0.4);
  }

  onTick(m) {
    if (m.length <= this.window || !chance(this.activity)) return;
    const score = m.upDownScore(this.window);
    if (this.shares === 0) {
      if (score >= this.enter && this.allows('BUY')) this.market('BUY', this.size);
      else if (score <= -this.enter && this.allows('SELL')) this.market('SELL', this.size);
    } else if (
      Math.abs(score) <= this.flat ||
      (this.shares > 0 && score <= -this.enter) ||
      (this.shares < 0 && score >= this.enter)
    ) {
      this.flatten();
    }
  }
}

// ===================================================================
// 9. TREND BOT 2: more buyers than sellers resting in the book -> buy
// limit at the 10th ask level (sweeps up to it); more sellers -> sell
// limit at the 10th bid level. 10–200 shares.
// ===================================================================
export class TrendBot2 extends BaseBot {
  static TYPE = 'trend2';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.threshold = rand(0.15, 0.35); // book imbalance needed
    this.activity = rand(...TUNING.trend2Activity);
    this.maxPosition = 150;
  }

  onTick(m) {
    if (!chance(this.activity)) return;
    const imb = m.imbalance;
    const qty = randInt(10, 200);
    if (imb > this.threshold && this.allows('BUY')) {
      const lv = m.askLevels;
      if (lv.length) this.limit('BUY', lv[lv.length - 1].price, this.capped('BUY', qty), 8);
    } else if (imb < -this.threshold && this.allows('SELL')) {
      const lv = m.bidLevels;
      if (lv.length) this.limit('SELL', lv[lv.length - 1].price, this.capped('SELL', qty), 8);
    }
  }
}

// ===================================================================
// 10. TREND BOT 3 (the original): price moved 2–3σ over its 3–8 step
// lookback (and at least 0.08%) -> market order with the move. Short
// cooldown after trading.
// ===================================================================
export class TrendBot3 extends BaseBot {
  static TYPE = 'trend3';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.lookback = randInt(3, 8);
    this.z = rand(2, 3);
    this.cooldownUntil = 0;
    this.maxPosition = 50;
  }

  onTick(m) {
    if (m.length <= this.lookback || this.fleet.tick < this.cooldownUntil) return;
    const move = m.ret(this.lookback);
    if (Math.abs(m.moveZ(this.lookback)) < this.z || Math.abs(move) < 0.0008) return;
    const side = move > 0 ? 'BUY' : 'SELL';
    if (!this.allows(side)) return;
    this.market(side, this.capped(side, randInt(4, 15)));
    this.cooldownUntil = this.fleet.tick + this.lookback;
  }
}

// ===================================================================
// 11. MR BOT 1: 20/60/120-step moving averages. When they line up
// downward (20 < 60 < 120) it buys, expecting a bounce; when they line
// up upward (20 > 60 > 120) it sells. Holds until the opposite signal.
// ===================================================================
export class MRBot1 extends BaseBot {
  static TYPE = 'mr1';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.size = randInt(10, 60);
    this.state = null;
  }

  onTick(m) {
    if (m.length < 120) return;
    const s20 = m.sma(20);
    const s60 = m.sma(60);
    const s120 = m.sma(120);
    const state = s20 < s60 && s60 < s120 ? 'down' : s20 > s60 && s60 > s120 ? 'up' : 'mixed';
    if (state === this.state) return;
    const prev = this.state;
    this.state = state;
    if (prev === null) return; // no trade on the first reading
    const delay = randInt(0, 8);
    if (state === 'down') {
      this.later(delay, () => {
        if (this.shares <= 0 && this.allows('BUY')) this.market('BUY', this.size - this.shares);
      });
    } else if (state === 'up') {
      this.later(delay, () => {
        if (this.shares >= 0 && this.allows('SELL')) this.market('SELL', this.size + this.shares);
      });
    }
  }
}

// ===================================================================
// 12. MR BOT 2: order-book imbalance. Sellers outweigh buyers -> short;
// buyers outweigh sellers -> buy. Closes (market) once the book is back
// in balance.
// ===================================================================
export class MRBot2 extends BaseBot {
  static TYPE = 'mr2';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.enter = rand(0.25, 0.45);
    this.exit = rand(0.03, 0.08);
    this.size = randInt(10, 100);
    this.activity = rand(0.15, 0.4);
  }

  onTick(m) {
    if (!chance(this.activity)) return;
    const imb = m.imbalance;
    if (this.shares === 0) {
      if (imb <= -this.enter && this.allows('SELL')) this.market('SELL', this.size);
      else if (imb >= this.enter && this.allows('BUY')) this.market('BUY', this.size);
    } else if (Math.abs(imb) <= this.exit) {
      this.flatten();
    }
  }
}

// ===================================================================
// 13. MR BOT 3 (the original): price 2–3σ away from its 10-step mean
// (and at least 0.08%) -> market order back toward it. Short cooldown
// after trading.
// ===================================================================
export class MRBot3 extends BaseBot {
  static TYPE = 'mr3';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.z = rand(2, 3);
    this.cooldownUntil = 0;
    this.maxPosition = 150;
  }

  onTick(m) {
    if (m.length < 10 || this.fleet.tick < this.cooldownUntil) return;
    const z = m.devZ(10);
    if (Math.abs(z) < this.z || Math.abs(m.mid / m.sma(10) - 1) < 0.0008) return;
    if (z > 0 && this.allows('SELL')) this.market('SELL', this.capped('SELL', 10));
    else if (z < 0 && this.allows('BUY')) this.market('BUY', this.capped('BUY', 10));
    else return;
    this.cooldownUntil = this.fleet.tick + randInt(2, 6);
  }
}

// ===================================================================
// 14. JUMP TRADER: a jump down -> buy, sell 10 steps later; a jump up
// -> sell, buy back 10 steps later. Random lot size.
// ===================================================================
export class JumpTrader extends BaseBot {
  static TYPE = 'jump';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.threshold = rand(2.5, 3.5); // jump = this many σ of 1-step returns (and at least 0.05%)
    this.exitAt = null;
  }

  onTick(m) {
    if (this.exitAt != null && this.fleet.tick >= this.exitAt) {
      this.flatten();
      this.exitAt = null;
    }
    if (this.exitAt != null || this.shares !== 0 || m.length < 30) return;
    const r = m.ret(1);
    if (Math.abs(r) < Math.max(this.threshold * m.retStd(60), 0.0005)) return;
    const side = r < 0 ? 'BUY' : 'SELL';
    if (!this.allows(side)) return;
    this.market(side, randInt(10, 150));
    this.exitAt = this.fleet.tick + 10;
  }
}

// ===================================================================
// 15. VOLATILITY TRADER: when recent volatility ranks high against the
// last hour or so, it sells at random; when it ranks low, it buys at
// random. Ranking (not a fixed multiple) keeps "high" and "low" equally
// common, so the bot doesn't drift one way all day.
// ===================================================================
export class VolatilityTrader extends BaseBot {
  static TYPE = 'volatility';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.activity = rand(0.02, 0.05);
    this.high = rand(0.7, 0.85); // percentile that counts as "high"
    this.low = rand(0.15, 0.3);  // percentile that counts as "low"
    this.maxPosition = 200;
  }

  onTick(m) {
    if (m.volRank == null || !chance(this.activity)) return;
    const qty = randInt(10, 80);
    if (m.volRank >= this.high && this.allows('SELL')) this.market('SELL', this.capped('SELL', qty));
    else if (m.volRank <= this.low && this.allows('BUY')) this.market('BUY', this.capped('BUY', qty));
  }
}

// ===================================================================
// 16. RANDOM LIMIT GIVER: drops limit orders at random prices and forgets
// about them. Most rest a few cents behind the best price on their side,
// some far back (the distance has a power-law tail, as in real order
// books), about one in eight improves on the best price inside the spread,
// and the odd one is priced through the market and trades at once. Sizes
// are mostly small with the occasional big one. Orders rest 2–60 minutes;
// some get pulled early. Busier when the market moves.
// ===================================================================
export class RandomLimitBot extends BaseBot {
  static TYPE = 'randomLimit';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.activity = opts.activity ?? rand(...TUNING.randomLimitActivity);
    this.cancelRate = rand(0.005, 0.02); // chance per step of pulling one resting order
    this.ttl = [fleet.ticksFor(2), fleet.ticksFor(60)];
  }

  onTick(m) {
    if (this.orders.size && chance(this.cancelRate)) this.cancelOne();
    if (chance(this.activity * m.attention)) this.placeOrder(m);
  }

  openingOrder(m) { this.placeOrder(m); }

  placeOrder(m) {
    const side = this.pickSide();
    const own = side === 'BUY' ? this.book.bestBid() : this.book.bestAsk();
    const other = side === 'BUY' ? this.book.bestAsk() : this.book.bestBid();
    const back = side === 'BUY' ? -1 : 1; // direction away from the market
    let price;
    const u = random();
    if (own == null || other == null) {
      price = m.mid + back * rand(1, 3) * m.sigma;
    } else if (u < 0.03) {
      price = other - back * 0.01 * randInt(0, 3); // through the market
    } else if (u < 0.15 && Math.abs(other - own) > 0.015) {
      const inside = Math.round(Math.abs(other - own) * 100) - 1;
      price = own - back * 0.01 * randInt(1, inside); // improves the best price
    } else {
      // Power law: most orders a few cents back, a long tail far away
      const d0 = Math.max(0.01, 0.2 * m.sigma);
      const dist = Math.min(0.05 * m.mid, d0 * (random() ** (-1 / TUNING.randomLimitTail) - 1));
      price = own + back * dist;
    }
    this.limit(side, price, humanSize(15, 500), randInt(...this.ttl));
  }

  cancelOne() {
    let i = randInt(0, this.orders.size - 1);
    for (const id of this.orders) {
      if (i-- > 0) continue;
      this.book.removeOrder(id, this.id);
      this.orders.delete(id);
      return;
    }
  }
}

// ===================================================================
// 17. RANDOM BUYER: an everyday investor. Buys a round lot at random
// moments with a market order, more often when the stock is moving (it's
// in the news), and sells the way people really do (the disposition
// effect): quick to bank a small win, slow to accept a loss, until the
// loss hurts enough to panic out. Now and then one sells for no reason at
// all (needs the money). Half of them start the day already holding, mostly
// at a loss: yesterday they sold their winners and kept their losers.
// ===================================================================
const ROUND_LOTS = [5, 10, 10, 20, 25, 25, 50, 50, 100, 100, 200];

export class RandomBuyer extends BaseBot {
  static TYPE = 'randomBuyer';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.activity = opts.activity ?? rand(...TUNING.randomBuyerActivity);
    this.lot = pick(ROUND_LOTS);
    this.maxLots = randInt(1, 4);
    this.takeProfit = rand(0.003, 0.012);
    this.panicAt = rand(0.012, 0.03);
    this.boredom = 1 / fleet.ticksFor(rand(60, 240)); // no-reason sale: about once per 1–4 hours held
    if (opts.cohort === 'base' && chance(0.5)) {
      this.shares = this.lot * randInt(1, this.maxLots);
      this.avgEntry = fleet.book.getMidPrice() * (1 + rand(-0.8 * this.takeProfit, 0.8 * this.panicAt));
    }
  }

  onTick(m) {
    if (this.shares > 0) {
      const r = this.pnlPct(m.mid);
      if ((r >= this.takeProfit && chance(0.2)) || r <= -this.panicAt || chance(this.boredom)) {
        this.market('SELL', this.shares);
        return;
      }
    }
    if (this.shares < this.lot * this.maxLots && chance(this.activity * m.attention) && this.allows('BUY')) {
      this.market('BUY', this.lot);
    }
  }
}

// ===================================================================
// 18. AGGRESSIVE REVERTER: watches how far the price has run over its
// window (5–30 minutes). When the run is big (2–3σ for that window, and at
// least 0.15–0.4%), it reacts hard. How depends on its temper and on how
// stretched the move is:
//   push   – piles in with the move (FOMO); likelier on moderate moves
//   revert – slams it back toward where it came from; likelier the more
//            stretched the move is
//   hold   – defends the new level: stacks bids just under it and offers
//            just over it, refilling them, so the price stalls there. If
//            the level breaks anyway, it dumps everything and walks away.
// Push and revert go in as market orders over a few steps. Each reaction
// ends at its target (half the move again, in its favour), its stop (half
// the move against it) or after 10–30 minutes.
// ===================================================================
const REVERTER_WINDOWS = [5, 10, 15, 20, 30]; // minutes

export class AggressiveReverter extends BaseBot {
  static TYPE = 'reverter';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.window = fleet.ticksFor(pick(REVERTER_WINDOWS));
    this.trigger = rand(2, 3);
    this.minMove = rand(0.0015, 0.004);
    this.temper = { push: rand(0.2, 1), revert: rand(0.2, 1), hold: rand(0.2, 1) };
    this.size = randInt(...TUNING.reverterSize);
    this.play = null;
    this.readyAt = fleet.tick + randInt(0, this.window);
  }

  onTick(m) {
    if (this.play) {
      this.manage(m);
      return;
    }
    if (this.fleet.tick < this.readyAt || m.length <= this.window) return;
    const move = m.ret(this.window);
    const z = m.moveZ(this.window);
    if (Math.abs(z) >= this.trigger && Math.abs(move) >= this.minMove) this.react(m, move, Math.abs(z) / this.trigger);
  }

  react(m, move, stretch) {
    const w = { push: this.temper.push / stretch, revert: this.temper.revert * stretch, hold: this.temper.hold };
    let r = random() * (w.push + w.revert + w.hold);
    const mode = (r -= w.push) < 0 ? 'push' : (r -= w.revert) < 0 ? 'revert' : 'hold';
    const dir = move > 0 ? 1 : -1;
    const side = (dir > 0) === (mode !== 'revert') ? 'BUY' : 'SELL';
    if (mode !== 'hold' && !this.allows(side)) return;
    this.play = {
      mode,
      dir,
      side,
      level: m.mid,
      dist: Math.abs(m.mid - m.mid / (1 + move)), // size of the run, $
      toTrade: mode === 'hold' ? 0 : this.size,
      refillAt: 0,
      until: this.fleet.tick + this.fleet.ticksFor(randInt(10, 30))
    };
  }

  manage(m) {
    const p = this.play;
    const t = this.fleet.tick;
    const x = (p.dir * (m.mid - p.level)) / p.dist; // progress past the level, in runs
    if (p.mode === 'hold') {
      if (Math.abs(x) > 0.5 || t >= p.until) this.endPlay(); // level broke, or done
      else if (t >= p.refillAt) this.defend(m);
      return;
    }
    if (p.toTrade > 0) {
      const q = Math.min(p.toTrade, Math.ceil(this.size / randInt(2, 4)));
      this.market(p.side, q);
      p.toTrade -= q;
    }
    const gain = p.mode === 'push' ? x : -x;
    if (t >= p.until || Math.abs(gain) >= 0.5) this.endPlay();
  }

  defend(m) {
    const p = this.play;
    this.cancelAll();
    const gap = Math.max(0.01, m.tickSigma);
    const q = Math.ceil(this.size / 4);
    for (let i = 1; i <= 2; i++) {
      if (this.shares < this.size) this.limit('BUY', floor2(p.level - gap * i), q);
      if (this.shares > -this.size) this.limit('SELL', ceil2(p.level + gap * i), q);
    }
    p.refillAt = this.fleet.tick + randInt(2, 4);
  }

  endPlay() {
    this.cancelAll();
    this.flatten();
    this.play = null;
    this.readyAt = this.fleet.tick + this.window; // don't react to the same run twice
  }

  onLeave() {
    super.onLeave();
    this.play = null;
  }
}

export const BOT_TYPES = {
  noise: NoiseBot,
  marketMaker: MarketMakerBot,
  whale: WhaleBot,
  buyer: BuyerBot,
  seller: SellerBot,
  limitLadder: LimitLadderBot,
  std: StdBot,
  trend1: TrendBot1,
  trend2: TrendBot2,
  trend3: TrendBot3,
  mr1: MRBot1,
  mr2: MRBot2,
  mr3: MRBot3,
  jump: JumpTrader,
  volatility: VolatilityTrader,
  randomLimit: RandomLimitBot,
  randomBuyer: RandomBuyer,
  reverter: AggressiveReverter
};

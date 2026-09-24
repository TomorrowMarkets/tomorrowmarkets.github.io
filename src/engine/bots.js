// src/engine/bots.js
// Every trading strategy in the market. Bots read a shared MarketState `m`
// (built once per tick by BotFleet) and trade through BaseBot helpers.
// Positions are tracked from actual fills, so exit rules (stop/target,
// "close when flat", "sell 10 steps later") act on what really executed.

const round2 = (n) => Math.round(n * 100) / 100;
const floor2 = (n) => Math.floor(n * 100 + 1e-9) / 100;
const ceil2 = (n) => Math.ceil(n * 100 - 1e-9) / 100;
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const chance = (p) => Math.random() < p;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  valueVol: 0.0003,                  // per-step volatility of the hidden fair value ("news"):
                                     //   the main dial for how much the price moves
  valuePull: 0.02,                   // fair value drifts this much toward where the market trades
  makerValueWeight: [0.8, 1.0],      // how closely each maker centres its quotes on fair value
  valueEventDrift: 0.0002,           // per-step fair-value drift at full event strength (US open)
  trend2Activity: [0.01, 0.03]       // how often trend bot 2 checks the book
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
  pickSide() { return Math.random() < 0.5 + this.tilt / 2 ? 'BUY' : 'SELL'; }

  // Event cohorts mostly skip trades that go against their direction
  allows(side) {
    const b = this.tilt;
    if (!b) return true;
    return (side === 'BUY') === (b > 0) || Math.random() > Math.abs(b);
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
// ===================================================================
export class NoiseBot extends BaseBot {
  static TYPE = 'noise';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.activity = opts.activity ?? rand(...TUNING.noiseActivity);
  }

  onTick(m) {
    if (!chance(this.activity)) return;
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
}

// ===================================================================
// 2. MARKET MAKER: quotes both sides on 3 levels around its estimate of
// fair value (the market price blended with a hidden "news" random walk).
// Spread widens a little when the market is jumpy.
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

    // No inventory leaning: shifting quote prices or sizes against inventory
    // (or dumping it on the other makers) turns every imbalance into a slow,
    // self-feeding trend. Makers just stop quoting a side at their limit.

    const bestBid = this.book.bestBid();
    const bestAsk = this.book.bestAsk();
    // Spread: a base width plus a little extra when the market is jumpy, capped
    const half = clamp(this.baseHalf * mid + 0.5 * m.tickSigma, 0.01, TUNING.makerMaxHalfSpread * mid);
    // Quotes centre between the market and the maker's view of fair value, so
    // prices follow news (a random walk) instead of their own momentum. Makers
    // that arrive with the US open lean with their cohort while the event lasts.
    const centre = mid + this.valueWeight * (m.value - mid) + this.tilt * half * 4;
    const full = Math.abs(this.shares) >= this.maxInventory;

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
// 7. STD BOT: price more than 0.5% below its 30-step mean -> buy; more
// than 0.5% above -> sell. Takes profit when price is back at the mean.
// ===================================================================
export class StdBot extends BaseBot {
  static TYPE = 'std';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.size = randInt(10, 60);
    this.activity = rand(0.15, 0.4);
  }

  onTick(m) {
    if (m.length < 30 || !chance(this.activity)) return;
    const mean = m.sma(30);
    const dev = (m.mid - mean) / mean;
    if (dev <= -0.005 && this.shares <= 0 && this.allows('BUY')) this.market('BUY', this.size - this.shares);
    else if (dev >= 0.005 && this.shares >= 0 && this.allows('SELL')) this.market('SELL', this.size + this.shares);
    else if (this.shares !== 0 && Math.abs(dev) < 0.001) this.flatten();
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
// 10. TREND BOT 3 (the original): price moved 0.15%+ over its 3–8 step
// lookback -> market order with the move. Short cooldown after trading.
// ===================================================================
export class TrendBot3 extends BaseBot {
  static TYPE = 'trend3';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.lookback = randInt(3, 8);
    this.cooldownUntil = 0;
    this.maxPosition = 50;
  }

  onTick(m) {
    if (m.length <= this.lookback || this.fleet.tick < this.cooldownUntil) return;
    const move = m.ret(this.lookback);
    if (Math.abs(move) < 0.0015) return;
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
// 13. MR BOT 3 (the original): price 0.25%+ away from its 10-step mean
// -> market order back toward it. Short cooldown after trading.
// ===================================================================
export class MRBot3 extends BaseBot {
  static TYPE = 'mr3';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.cooldownUntil = 0;
    this.maxPosition = 150;
  }

  onTick(m) {
    if (m.length < 10 || this.fleet.tick < this.cooldownUntil) return;
    const mean = m.sma(10);
    const dev = (m.mid - mean) / mean;
    if (dev > 0.0025 && this.allows('SELL')) this.market('SELL', this.capped('SELL', 10));
    else if (dev < -0.0025 && this.allows('BUY')) this.market('BUY', this.capped('BUY', 10));
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
  volatility: VolatilityTrader
};

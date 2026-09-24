// src/engine/BotFleet.js
// The trading population and its daily schedule.
//
//   09:30–10:30  opening crowd: +100 (3 whales, 97 noise), then they leave
//   every hour   10:00 … 17:00: 10–100 traders join or leave (random types)
//   14:30        US open: +200 (1 whale, 2 market makers, 197 noise / trend
//                / MR) leaning up or down, with a small or big push that
//                fades over roughly an hour
//   17:00–18:00  the opening crowd comes back for the close

import { BOT_TYPES, TUNING, rand, randInt } from './bots.js';

// ---- Tuning ----------------------------------------------------------------
// Base population (1,000 agents). Churn joiners are drawn with these weights.
export const BASE_MIX = {
  noise: 520,
  marketMaker: 30,
  whale: 5,
  buyer: 10,
  seller: 10,
  limitLadder: 10,
  std: 40,
  trend1: 40,
  trend2: 40,
  trend3: 60,
  mr1: 40,
  mr2: 40,
  mr3: 60,
  jump: 40,
  volatility: 55
};
const MIN_MARKET_MAKERS = 12;   // hourly churn never removes makers below this
const OPENING_CROWD = { whale: 3, noise: 97 };
const US_OPEN_SIZE = 200;
const US_OPEN_FADE_MINUTES = 60; // the push decays with this time constant
const US_OPEN_SMALL = [0.18, 0.28]; // lean of a small event (0 = none, 1 = one-sided)
const US_OPEN_BIG = [0.34, 0.46];   // lean of a big event
const TREND_TYPES = ['trend1', 'trend2', 'trend3'];
const MR_TYPES = ['mr1', 'mr2', 'mr3'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function weightedPick(mix) {
  const entries = Object.entries(mix);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [type, w] of entries) {
    r -= w;
    if (r < 0) return type;
  }
  return entries[entries.length - 1][0];
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===================================================================
// MARKET STATE: one snapshot per tick, shared by every bot. Indicators
// are computed on first use and cached, so a thousand bots asking for
// the 30-step mean cost one calculation.
// ===================================================================
export class MarketState {
  constructor(book, history, tick) {
    this.book = book;
    this.history = history;
    this.tick = tick;
    this.length = history.length;
    this.mid = book.getMidPrice();
    this.volRank = null; // 0..1, set by the fleet once there is enough history
    this.cache = new Map();
  }

  memo(key, fn) {
    let v = this.cache.get(key);
    if (v === undefined) {
      v = fn();
      this.cache.set(key, v);
    }
    return v;
  }

  // Simple moving average of the last n recorded prices
  sma(n) {
    return this.memo(`sma${n}`, () => {
      const h = this.history;
      const k = Math.min(n, h.length);
      if (!k) return this.mid;
      let s = 0;
      for (let i = h.length - k; i < h.length; i++) s += h[i].price;
      return s / k;
    });
  }

  // Standard deviation of the last n prices ($)
  std(n) {
    return this.memo(`std${n}`, () => {
      const h = this.history;
      const k = Math.min(n, h.length);
      if (k < 2) return 0;
      const mean = this.sma(k);
      let s = 0;
      for (let i = h.length - k; i < h.length; i++) s += (h[i].price - mean) ** 2;
      return Math.sqrt(s / (k - 1));
    });
  }

  // Return over the last k steps (0.01 = +1%)
  ret(k) {
    const h = this.history;
    if (h.length <= k) return 0;
    return h[h.length - 1].price / h[h.length - 1 - k].price - 1;
  }

  // Standard deviation of the last n one-step returns
  retStd(n) {
    return this.memo(`rstd${n}`, () => {
      const h = this.history;
      const k = Math.min(n, h.length - 1);
      if (k < 2) return 0;
      let s = 0;
      let s2 = 0;
      for (let i = h.length - k; i < h.length; i++) {
        const r = h[i].price / h[i - 1].price - 1;
        s += r;
        s2 += r * r;
      }
      const mean = s / k;
      return Math.sqrt(Math.max(0, s2 / k - mean * mean));
    });
  }

  // (ups - downs) / n over the last n one-step returns: +1 all up, -1 all down
  upDownScore(n) {
    return this.memo(`ud${n}`, () => {
      const h = this.history;
      const k = Math.min(n, h.length - 1);
      if (k < 1) return 0;
      let score = 0;
      for (let i = h.length - k; i < h.length; i++) {
        const d = h[i].price - h[i - 1].price;
        if (d > 1e-9) score += 1;
        else if (d < -1e-9) score -= 1;
      }
      return score / k;
    });
  }

  // Price scale for noise-trader limits: std of the last 30 prices,
  // kept between TUNING.noiseSigmaFloor and TUNING.noiseSigmaCap of the price
  get sigma() {
    return this.memo('sigma', () => {
      const s = this.length >= 5 ? this.std(30) : 0;
      return Math.min(TUNING.noiseSigmaCap * this.mid, Math.max(TUNING.noiseSigmaFloor * this.mid, s));
    });
  }

  // Typical one-step price change ($): at least one cent, at most 0.3% of the price
  get tickSigma() {
    return this.memo('tickSigma', () => Math.min(0.003 * this.mid, Math.max(0.01, this.retStd(30) * this.mid)));
  }

  get bidLevels() { return this.memo('bidLv', () => this.book.levels('BUY', 10)); }
  get askLevels() { return this.memo('askLv', () => this.book.levels('SELL', 10)); }

  // Resting buy vs sell quantity over the top 10 levels: +1 all buyers, -1 all sellers
  get imbalance() {
    return this.memo('imb', () => {
      const b = this.bidLevels.reduce((s, l) => s + l.qty, 0);
      const a = this.askLevels.reduce((s, l) => s + l.qty, 0);
      return b + a > 0 ? (b - a) / (b + a) : 0;
    });
  }
}

// ===================================================================
// BOT FLEET
// ===================================================================
export class BotFleet {
  constructor(book, eventBus, { simSecsPerTick = 15, openSecs = 34200, closeSecs = 64800, onNews = null } = {}) {
    this.book = book;
    this.eventBus = eventBus;
    this.ticksPerMinute = 60 / simSecsPerTick;
    this.openSecs = openSecs;
    this.closeSecs = closeSecs;
    this.onNews = onNews;

    this.tick = 0;
    this.simSeconds = openSecs;
    this.active = new Map(); // id -> bot
    this.roster = [];
    this.rosterDirty = true;
    this.seq = 0;
    this.events = [];
    this.openingCrowd = [];
    this.lastUsOpen = null; // { direction, strength, big } for debugging / tests
    this.volSeries = [];    // recent-volatility readings, for percentile ranks

    // Route fills to the bots involved so they know their positions
    eventBus.on('TRADE', (t) => {
      const buyer = this.active.get(t.buyerId);
      if (buyer) buyer.onFill('BUY', t.price, t.qty);
      const seller = this.active.get(t.sellerId);
      if (seller) seller.onFill('SELL', t.price, t.qty);
    });
  }

  get size() { return this.active.size; }

  ticksFor(minutes) { return Math.round(minutes * this.ticksPerMinute); }

  countByType() {
    const out = {};
    for (const bot of this.active.values()) out[bot.type] = (out[bot.type] || 0) + 1;
    return out;
  }

  news(text) {
    if (this.onNews) this.onNews(text);
  }

  // ---- population -----------------------------------------------------

  spawn(type, opts = {}) {
    const Cls = BOT_TYPES[type];
    this.seq += 1;
    const bot = new Cls(`bot:${type}_${this.seq}`, this, opts);
    this.active.set(bot.id, bot);
    this.rosterDirty = true;
    return bot;
  }

  retire(bot) {
    bot.onLeave();
    this.active.delete(bot.id);
    this.rosterDirty = true;
  }

  readmit(bot) {
    this.active.set(bot.id, bot);
    this.rosterDirty = true;
  }

  // ---- the day ----------------------------------------------------------

  start(history) {
    // Base population. Buyers, sellers and ladders start at staggered times
    // in the first two hours so their 2-hour cycles don't all line up.
    const stagger = this.ticksFor(120);
    for (const [type, n] of Object.entries(BASE_MIX)) {
      for (let i = 0; i < n; i++) this.spawn(type, { cohort: 'base', delay: randInt(0, stagger) });
    }

    const at = (h, m = 0) => h * 3600 + m * 60;
    this.events = [
      { at: this.openSecs, run: () => this.openingCrowdArrives(true) },
      { at: this.openSecs + 3600, run: () => this.openingCrowdLeaves() },
      { at: at(14, 30), run: () => this.usOpen() },
      { at: this.closeSecs - 3600, run: () => this.openingCrowdArrives(false) }
    ];
    for (let h = Math.ceil(this.openSecs / 3600); h * 3600 < this.closeSecs; h++) {
      if (h * 3600 > this.openSecs) this.events.push({ at: at(h), run: () => this.hourlyChurn() });
    }
    this.events.sort((a, b) => a.at - b.at);

    // Opening book: market makers quote and some noise traders rest orders
    // before the first trade, so the day doesn't open on an empty book.
    const m = new MarketState(this.book, history, 0);
    for (const bot of this.active.values()) {
      if (bot.type === 'marketMaker') bot.onTick(m);
    }
    for (const bot of this.active.values()) {
      if (bot.type === 'noise' && Math.random() < 0.5) {
        const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
        const k = rand(1, 3) * m.sigma;
        bot.limit(side, side === 'BUY' ? m.mid - k : m.mid + k, randInt(1, 50), randInt(...TUNING.noiseTtl));
      }
    }
  }

  onTick({ tick, simSeconds, history }) {
    this.tick = tick;
    this.simSeconds = simSeconds;
    while (this.events.length && this.events[0].at <= simSeconds) this.events.shift().run();

    const m = new MarketState(this.book, history, tick);
    // Where does current volatility rank against the last ~hour of readings?
    if (history.length > 21) {
      const v = m.retStd(20);
      this.volSeries.push(v);
      if (this.volSeries.length > this.ticksFor(60)) this.volSeries.shift();
      if (this.volSeries.length >= 40) {
        let below = 0;
        for (const x of this.volSeries) if (x < v) below += 1;
        m.volRank = below / this.volSeries.length;
      }
    }
    if (this.rosterDirty) {
      this.roster = [...this.active.values()];
      this.rosterDirty = false;
    }
    shuffle(this.roster); // nobody gets to act first every tick
    for (let i = 0; i < this.roster.length; i++) this.roster[i].tick(m);
  }

  // ---- scheduled events ---------------------------------------------------

  openingCrowdArrives(firstTime) {
    if (firstTime) {
      for (const [type, n] of Object.entries(OPENING_CROWD)) {
        for (let i = 0; i < n; i++) {
          this.openingCrowd.push(this.spawn(type, {
            cohort: 'open',
            activity: type === 'noise' ? rand(0.12, 0.25) : rand(0.008, 0.015)
          }));
        }
      }
      this.news('Opening hour: 100 extra traders are in the market until 10:30.');
    } else {
      for (const bot of this.openingCrowd) this.readmit(bot);
      this.news('Final hour: the opening crowd is back for the close.');
    }
  }

  openingCrowdLeaves() {
    for (const bot of this.openingCrowd) if (this.active.has(bot.id)) this.retire(bot);
    this.news('The opening rush is over: 100 traders left the market.');
  }

  hourlyChurn() {
    const n = randInt(10, 100);
    if (Math.random() < 0.5) {
      for (let i = 0; i < n; i++) this.spawn(weightedPick(BASE_MIX), { cohort: 'churn' });
      this.news(`${n} new traders joined the market.`);
      return;
    }
    let makers = [...this.active.values()].filter((b) => b.type === 'marketMaker').length;
    const candidates = shuffle([...this.active.values()].filter((b) => b.cohort === 'base' || b.cohort === 'churn'));
    let removed = 0;
    for (const bot of candidates) {
      if (removed >= n) break;
      if (bot.type === 'marketMaker') {
        if (makers <= MIN_MARKET_MAKERS) continue;
        makers -= 1;
      }
      this.retire(bot);
      removed += 1;
    }
    this.news(`${removed} traders left the market.`);
  }

  usOpen() {
    const direction = Math.random() < 0.5 ? 1 : -1;
    const big = Math.random() < 0.5;
    const strength = big ? rand(US_OPEN_BIG[0], US_OPEN_BIG[1]) : rand(US_OPEN_SMALL[0], US_OPEN_SMALL[1]);
    const start = this.tick;
    const fade = this.ticksFor(US_OPEN_FADE_MINUTES);
    const biasFn = () => direction * strength * Math.exp(-(this.tick - start) / fade);
    this.lastUsOpen = { direction, strength, big, startTick: start };

    const opts = { cohort: 'us', biasFn };
    this.spawn('whale', opts);
    this.spawn('marketMaker', opts);
    this.spawn('marketMaker', opts);
    for (let i = 3; i < US_OPEN_SIZE; i++) {
      const category = pick(['noise', 'trend', 'mr']);
      const type = category === 'noise' ? 'noise' : category === 'trend' ? pick(TREND_TYPES) : pick(MR_TYPES);
      // The US open is a volume surge: arriving noise traders are busier than usual
      this.spawn(type, type === 'noise' ? { ...opts, activity: rand(0.08, 0.15) } : opts);
    }
    this.news('14:30 US markets are open: 200 new traders joined.');
  }
}

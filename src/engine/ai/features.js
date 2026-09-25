// src/engine/ai/features.js
// What the AI sees. Only information a human trader could see or calculate:
// prices, the order book, trade flow, the clock, the crowd and its own
// account. Nothing hidden (no fair value, no event direction).
//
// Each decision produces one raw "step" vector (STEP_FEATURES). The network's
// input (the observation) is that step, normalised, plus a rolling memory of
// the last HISTORY_STEPS steps' key features. Because the observation is
// rebuilt from step vectors alone, a whole game can be uploaded as just its
// sequence of step vectors and replayed exactly by the nightly trainer.

export const STEP_FEATURES = [
  // price moves (%) over 15 s, 1 min, 5 min, 15 min, 1 h, 2 h
  'ret_1', 'ret_4', 'ret_20', 'ret_60', 'ret_240', 'ret_480',
  // volatility and how unusual it is
  'vol_20', 'vol_60', 'vol_240', 'vol_rank',
  // order book shape
  'spread_bps', 'imbalance_top1', 'imbalance_top3', 'imbalance_top10',
  'depth_bid10_log', 'depth_ask10_log', 'bid_ladder_bps', 'ask_ladder_bps',
  // aggressive order flow
  'flow_last', 'flow_ema', 'volume_last_log', 'volume_vs_normal',
  // trend and mean-reversion context
  'dev_sma20', 'dev_sma60', 'dev_sma120', 'dev_sma480', 'updown_40', 'updown_120',
  // the day so far
  'vs_open', 'vs_vwap', 'range_position', 'day_range',
  // clock and scheduled events
  'time_of_day', 'tod_sin', 'tod_cos', 'opening_hour', 'us_open_elapsed', 'final_hour', 'to_close',
  // the crowd
  'traders', 'traders_change_1h',
  // own account
  'position', 'unrealized', 'day_pnl', 'last_fill_ratio', 'resting_orders', 'time_in_position', 'entry_vs_price'
];
export const STEP_COUNT = STEP_FEATURES.length;

// Features kept in the rolling memory (indices into STEP_FEATURES)
const MEMORY_FEATURES = [
  'ret_1', 'ret_4', 'flow_last', 'imbalance_top1', 'imbalance_top10', 'spread_bps',
  'vol_20', 'dev_sma20', 'volume_vs_normal', 'vs_vwap', 'position', 'unrealized'
];
const MEMORY_IDX = MEMORY_FEATURES.map((f) => STEP_FEATURES.indexOf(f));
export const HISTORY_STEPS = 16; // 16 decisions = 16 simulated minutes
export const OBS_SIZE = STEP_COUNT + HISTORY_STEPS * MEMORY_IDX.length;

const US_OPEN_SECS = 14.5 * 3600;
const sumQty = (levels, n) => levels.slice(0, n).reduce((s, l) => s + l.qty, 0);
const imb = (b, a) => (b + a > 0 ? (b - a) / (b + a) : 0);

// One raw step vector from the market snapshot and the trader's account
export function stepFeatures(m, trader, equity) {
  const mid = m.mid;
  const fleet = m.fleet;
  const bid = m.bidLevels;
  const ask = m.askLevels;
  const spread = bid.length && ask.length ? ask[0].price - bid[0].price : 0;
  const ladder = (lv) => (lv.length >= 5 ? (Math.abs(lv[4].price - lv[0].price) / mid) * 1e4 : 0);
  const day = (m.simSeconds - fleet.openSecs) / (fleet.closeSecs - fleet.openSecs);
  const sinceUs = m.simSeconds - US_OPEN_SECS;
  const range = m.dayHigh - m.dayLow;
  const maxShares = Math.max(1, Math.floor(equity / mid));

  return Float32Array.from([
    m.ret(1) * 100, m.ret(4) * 100, m.ret(20) * 100, m.ret(60) * 100, m.ret(240) * 100, m.ret(480) * 100,
    m.retStd(20) * 100, m.retStd(60) * 100, m.retStd(240) * 100, m.volRank ?? 0.5,
    (spread / mid) * 1e4,
    bid.length && ask.length ? imb(bid[0].qty, ask[0].qty) : 0,
    imb(sumQty(bid, 3), sumQty(ask, 3)),
    m.imbalance,
    Math.log1p(sumQty(bid, 10)), Math.log1p(sumQty(ask, 10)), ladder(bid), ladder(ask),
    m.flow, m.flowEma, Math.log1p(m.lastVolume), m.volumeEma > 0 ? m.lastVolume / m.volumeEma : 1,
    (mid / m.sma(20) - 1) * 100, (mid / m.sma(60) - 1) * 100, (mid / m.sma(120) - 1) * 100, (mid / m.sma(480) - 1) * 100,
    m.upDownScore(40), m.upDownScore(120),
    (mid / m.dayOpen - 1) * 100, (mid / m.vwap - 1) * 100, range > 0 ? (mid - m.dayLow) / range : 0.5, (range / mid) * 100,
    day, Math.sin(2 * Math.PI * day), Math.cos(2 * Math.PI * day),
    m.simSeconds < fleet.openSecs + 3600 ? 1 : 0,
    sinceUs >= 0 ? Math.min(1, sinceUs / 7200) : 0,
    m.simSeconds >= fleet.closeSecs - 3600 ? 1 : 0,
    1 - day,
    m.traders / 1000, m.tradersChange / 100,
    trader.shares / maxShares,
    trader.unrealizedAt(mid) / 100,
    (equity - trader.startEquity) / 100,
    trader.lastFillRatio,
    trader.orders.size,
    trader.timeInPosition / 60,
    trader.shares !== 0 && trader.avgEntry ? (mid / trader.avgEntry - 1) * 100 * Math.sign(trader.shares) : 0
  ]);
}

// Turns raw step vectors into network inputs: normalised current step plus
// the normalised memory of the previous HISTORY_STEPS steps (newest first).
export class ObservationBuilder {
  constructor(norm) {
    this.norm = norm;
    this.memory = [];
  }

  reset() {
    this.memory = [];
  }

  build(rawStep, learnStats = true) {
    if (learnStats) this.norm.update(rawStep);
    const z = this.norm.apply(rawStep);
    const obs = new Float32Array(OBS_SIZE);
    obs.set(z, 0);
    let off = STEP_COUNT;
    for (let h = 0; h < HISTORY_STEPS; h++) {
      const past = this.memory[this.memory.length - 1 - h];
      if (past) obs.set(past, off);
      off += MEMORY_IDX.length;
    }
    this.memory.push(Float32Array.from(MEMORY_IDX, (i) => z[i]));
    if (this.memory.length > HISTORY_STEPS) this.memory.shift();
    return obs;
  }
}

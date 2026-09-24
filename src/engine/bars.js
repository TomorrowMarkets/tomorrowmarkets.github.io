// src/engine/bars.js
// Price bars. The game loop records one bar per tick (15 sim-seconds):
//
//   { price, open, high, low, volume, value, simSecs, simTimeStr }
//
// `price` is the closing mid price (what the bots and the old line chart
// use). open is the previous close, so bars join up without gaps; high and
// low also include every trade printed during the tick, so wicks show how
// far orders actually reached. volume is shares traded, value is the cash
// that changed hands (volume × price), which VWAP needs.

const round2 = (n) => Math.round(n * 100) / 100;

// Collects the trades printed between two ticks.
export class TickAccumulator {
  constructor() {
    this.reset();
  }

  reset() {
    this.high = -Infinity;
    this.low = Infinity;
    this.volume = 0;
    this.value = 0;
  }

  addTrade(price, qty) {
    if (price > this.high) this.high = price;
    if (price < this.low) this.low = price;
    this.volume += qty;
    this.value += price * qty;
  }

  // Close the tick at `close` (the mid price) and start the next one.
  take(open, close) {
    const bar = {
      price: close,
      open,
      high: round2(Math.max(open, close, this.high)),
      low: round2(Math.min(open, close, this.low)),
      volume: this.volume,
      value: round2(this.value)
    };
    this.reset();
    return bar;
  }
}

// Merge per-tick points into candles of `perBar` ticks, aligned to the
// session open so a 1-minute candle always covers :00 to :59 seconds.
// Returns [{ bucket, t, open, high, low, close, volume, value }], where t is
// the candle's start in sim-seconds. Points recorded before bars existed
// (no open/high/low) are treated as flat bars at their price.
export function resample(points, perBar, { originSecs, secsPerTick }) {
  const out = [];
  const span = perBar * secsPerTick;
  let cur = null;
  let prevClose = null;
  for (const p of points) {
    const close = p.price;
    const open = p.open ?? prevClose ?? close;
    const high = p.high ?? Math.max(open, close);
    const low = p.low ?? Math.min(open, close);
    const tick = Math.round((p.simSecs - originSecs) / secsPerTick);
    const bucket = Math.max(0, Math.floor((tick - 1) / perBar));
    if (!cur || cur.bucket !== bucket) {
      cur = { bucket, t: originSecs + bucket * span, open, high, low, close, volume: 0, value: 0 };
      out.push(cur);
    } else {
      if (high > cur.high) cur.high = high;
      if (low < cur.low) cur.low = low;
      cur.close = close;
    }
    cur.volume += p.volume || 0;
    cur.value += p.value || 0;
    prevClose = close;
  }
  return out;
}

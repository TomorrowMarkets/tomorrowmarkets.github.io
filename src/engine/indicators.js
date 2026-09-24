// src/engine/indicators.js
// Technical indicators as plain functions: arrays in, arrays out. Output
// arrays line up index-for-index with the input; bars without enough
// history yet are NaN. Nothing here touches the DOM, so the same code can
// serve the chart today and strategy scripts later.

const isNum = Number.isFinite;

// Simple moving average
export function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isNum(v)) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count += 1;
    if (count > period) sum -= values[i - period];
    if (count >= period) out[i] = sum / period;
  }
  return out;
}

// Exponential moving average, seeded with the SMA of the first `period`
// values. Leading NaNs (e.g. the start of a MACD line) are skipped.
export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let seedSum = 0;
  let seedCount = 0;
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isNum(v)) continue;
    if (!isNum(prev)) {
      seedSum += v;
      seedCount += 1;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Rolling (population) standard deviation
export function stdev(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    let s2 = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (!isNum(v)) {
        ok = false;
        break;
      }
      s += v;
      s2 += v * v;
    }
    if (!ok) continue;
    const mean = s / period;
    out[i] = Math.sqrt(Math.max(0, s2 / period - mean * mean));
  }
  return out;
}

// Bollinger Bands: SMA ± mult standard deviations
export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const sd = stdev(values, period);
  const upper = mid.map((m, i) => m + mult * sd[i]);
  const lower = mid.map((m, i) => m - mult * sd[i]);
  return { mid, upper, lower };
}

// Relative Strength Index with Wilder's smoothing (0..100)
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

// MACD: fast EMA − slow EMA, its signal EMA, and the histogram between them
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = f.map((v, i) => v - s[i]);
  const sig = ema(line, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { macd: line, signal: sig, hist };
}

// Session VWAP: cumulative traded value / cumulative volume. Before the
// first trade it falls back to the bar's close.
export function vwap(bars) {
  const out = new Array(bars.length);
  let value = 0;
  let volume = 0;
  for (let i = 0; i < bars.length; i++) {
    value += bars[i].value || 0;
    volume += bars[i].volume || 0;
    out[i] = volume > 0 ? value / volume : bars[i].close;
  }
  return out;
}

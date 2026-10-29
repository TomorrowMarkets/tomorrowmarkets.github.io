// Pure host-side portfolio accounting. Weights are FRACTIONS, not percentages.
// Fractional shares, no shorting/leverage/fees, cash earns 0%. The last saved
// target weights rebalance automatically at each round boundary.
const DAY_MS = 86400000;
import { PORTFOLIO_ROUND_OPTIONS } from './session.js';
export const PORTFOLIO_STARTING_CAPITAL = 10000;

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function anniversary(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  if (d.getUTCMonth() !== month) d.setUTCDate(0); // Feb 29 -> Feb 28
  return d.toISOString().slice(0, 10);
}

export function validatePortfolioDataset(raw) {
  if (!raw || raw.version !== 1 || raw.kind !== 'portfolio' || raw.currency !== 'USD'
    || raw.adjusted !== true || !['Yahoo Finance', 'Synthetic demo'].includes(raw.source)) {
    throw new Error('Portfolio data needs version 1, kind "portfolio", USD, adjusted: true, and a Yahoo Finance or Synthetic demo source.');
  }
  if (raw.source === 'Synthetic demo' && raw.demo !== true) throw new Error('Synthetic portfolio prices must be marked demo: true.');
  if (!Array.isArray(raw.assets) || raw.assets.length !== 30) throw new Error('A portfolio challenge needs exactly 30 assets.');
  const symbols = new Set();
  const assets = raw.assets.map((asset) => {
    if (!asset || typeof asset.symbol !== 'string' || !/^[A-Z0-9.^=_-]{1,20}$/.test(asset.symbol) || symbols.has(asset.symbol)) {
      throw new Error('Portfolio symbols must be unique ticker symbols.');
    }
    symbols.add(asset.symbol);
    return { symbol: asset.symbol, name: String(asset.name || asset.symbol).slice(0, 120) };
  });
  if (!Array.isArray(raw.dates) || raw.dates.length < 201) throw new Error('Provide at least one complete year of daily prices.');
  const dates = raw.dates.map((date, i) => {
    if (!validDate(date) || (i && date <= raw.dates[i - 1])) throw new Error('Portfolio dates must be unique and sorted YYYY-MM-DD dates.');
    if (i && Date.parse(date) - Date.parse(raw.dates[i - 1]) > 7 * DAY_MS) throw new Error('Portfolio data has a gap longer than seven days.');
    return date;
  });
  if (!Array.isArray(raw.prices) || raw.prices.length !== dates.length) throw new Error('Prices must have one row per date.');
  const prices = raw.prices.map((row) => {
    if (!Array.isArray(row) || row.length !== 30 || row.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      throw new Error('Every daily price row must contain 30 finite positive adjusted closes. Missing values cannot be filled from the future.');
    }
    return row.slice();
  });
  return { version: 1, kind: 'portfolio', source: raw.source, adjusted: true, currency: 'USD',
    demo: raw.demo === true, assets, dates, prices };
}

export function annualWindows(dataset) {
  const index = new Map(dataset.dates.map((date, i) => [date, i]));
  const windows = [];
  dataset.dates.forEach((date, start) => {
    const end = index.get(anniversary(date));
    if (end != null && end - start >= 200 && end - start <= 270) windows.push({ start, end });
  });
  return windows;
}

export function chooseAnnualWindow(dataset, rng = Math.random) {
  const windows = annualWindows(dataset);
  if (!windows.length) throw new Error('No complete one-calendar-year window is available for all 30 assets. Add more daily history.');
  const r = rng();
  if (!(r >= 0 && r < 1)) throw new Error('Random generator must return a number in [0, 1).');
  return windows[Math.floor(r * windows.length)];
}

export function validateWeights(weights, count = 30) {
  if (!Array.isArray(weights) || weights.length !== count
    || weights.some((w) => typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1)) {
    throw new Error('Enter 30 allocations between 0% and 100%.');
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum > 1 + 1e-10) throw new Error('Total allocation cannot exceed 100%.');
  // Remove harmless floating point overflow around 100% only.
  return sum > 1 ? weights.map((w) => w / sum) : weights.slice();
}

function growth(prices, from, to, weights) {
  return 1 + weights.reduce((sum, w, i) => sum + w * (prices[to][i] / prices[from][i] - 1), 0);
}

export class PortfolioChallenge {
  constructor(raw, { roundSeconds = 30, stride = 5, rng = Math.random } = {}) {
    if (!PORTFOLIO_ROUND_OPTIONS.includes(roundSeconds)) throw new Error('Portfolio rounds must allow 30, 45, 60 or 90 seconds.');
    if (![1, 5].includes(stride)) throw new Error('Portfolio rounds must span one or five trading days.');
    this.data = validatePortfolioDataset(raw);
    this.window = chooseAnnualWindow(this.data, rng);
    this.endpoints = [this.window.start];
    for (let i = this.window.start + stride; i < this.window.end; i += stride) this.endpoints.push(i);
    this.endpoints.push(this.window.end);
    this.roundMs = roundSeconds * 1000;
    this.durationMinutes = this.roundMs * (this.endpoints.length - 1) / 60000;
    this.players = new Map();
    this.round = 0;
    this.started = false;
    this.finished = false;
    this.deadline = 0;
  }

  register(id) {
    if (this.started) throw new Error('Players must join before the portfolio challenge starts.');
    if (!this.players.has(id)) this.players.set(id, {
      capital: PORTFOLIO_STARTING_CAPITAL, weights: Array(30).fill(0),
      pending: null, peak: PORTFOLIO_STARTING_CAPITAL, maxDrawdown: 0, history: []
    });
  }

  start(now = Date.now()) {
    if (this.started) throw new Error('This portfolio challenge has already started.');
    if (!this.players.size) throw new Error('At least one portfolio player is required.');
    this.started = true;
    this.deadline = now + this.roundMs;
    for (const player of this.players.values()) player.history.push(PORTFOLIO_STARTING_CAPITAL);
  }

  submit(id, weights, round, now = Date.now()) {
    if (!this.started || this.finished || now >= this.deadline || round !== this.round) {
      throw new Error('That round is closed. Save your allocation for the current round.');
    }
    const player = this.players.get(id);
    if (!player) throw new Error('You are not a player in this challenge.');
    player.pending = validateWeights(weights);
  }

  // One deadline per call: a suspended host never burns through unseen rounds.
  advance(now = Date.now()) {
    if (!this.started || this.finished || now < this.deadline) return false;
    const from = this.endpoints[this.round];
    const to = this.endpoints[this.round + 1];
    for (const player of this.players.values()) {
      if (player.pending) player.weights = player.pending;
      player.pending = null;
      const openingCapital = player.capital;
      for (let day = from + 1; day <= to; day++) {
        const nav = openingCapital * growth(this.data.prices, from, day, player.weights);
        player.peak = Math.max(player.peak, nav);
        player.maxDrawdown = Math.max(player.maxDrawdown, (player.peak - nav) / player.peak);
        player.history.push(nav);
      }
      player.capital = openingCapital * growth(this.data.prices, from, to, player.weights);
    }
    this.round += 1;
    this.finished = this.round === this.endpoints.length - 1;
    this.deadline = this.finished ? 0 : now + this.roundMs;
    return true;
  }

  standings() {
    return [...this.players.entries()].map(([id, player]) => ({
      id, capital: player.capital, total: player.capital - PORTFOLIO_STARTING_CAPITAL,
      returnPct: (player.capital / PORTFOLIO_STARTING_CAPITAL - 1) * 100,
      maxDrawdown: player.maxDrawdown * 100
    })).sort((a, b) => b.capital - a.capital || a.id.localeCompare(b.id));
  }

  snapshot(id) {
    const player = this.players.get(id);
    if (!player) throw new Error('Unknown portfolio player.');
    const row = this.endpoints[this.round];
    const previous = this.endpoints[Math.max(0, this.round - 1)];
    const first = this.window.start;
    const equal = Array(30).fill(1 / 30);
    // Benchmark is a 30-asset equal-weight BUY-AND-HOLD portfolio over the year.
    const benchmark = (growth(this.data.prices, first, row, equal) - 1) * 100;
    return {
      round: this.round, totalRounds: this.endpoints.length - 1, finished: this.finished,
      date: this.data.dates[row], startDate: this.data.dates[first], endDate: this.data.dates[this.window.end],
      nextDate: this.finished ? null : this.data.dates[this.endpoints[this.round + 1]],
      deadline: this.deadline, roundMs: this.roundMs, durationMinutes: this.durationMinutes, serverNow: Date.now(),
      source: this.data.source, demo: this.data.demo, benchmark,
      assets: this.data.assets.map((asset, i) => ({ ...asset, price: this.data.prices[row][i],
        periodReturn: (this.data.prices[row][i] / this.data.prices[previous][i] - 1) * 100,
        totalReturn: (this.data.prices[row][i] / this.data.prices[first][i] - 1) * 100 })),
      account: { capital: player.capital, weights: player.weights.slice(), pending: player.pending?.slice() || null,
        maxDrawdown: player.maxDrawdown * 100, history: player.history.slice() },
      standings: this.standings()
    };
  }
}

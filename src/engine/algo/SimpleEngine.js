import { rsi } from '../indicators.js';

const METRICS = new Set(['price', 'mean', 'std', 'rsi', 'volume', 'return', 'cash', 'position']);
const OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'around', 'crossAbove', 'crossBelow']);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function defaultSimpleStrategy() {
  const feature = (metric) => ({ metric, window: 'rolling', period: 20 });
  const condition = (operator) => ({ left: feature('price'), operator,
    right: { kind: 'metric', ...feature('mean') }, tolerance: 1,
    persistence: { mode: 'consecutive', count: 1, window: 5 } });
  const block = (operator) => ({ enabled: true, join: 'all', conditions: [condition(operator)],
    amount: 10, amountType: 'shares', orderType: 'MARKET', limitOffsetBps: 0,
    cooldown: 1, cancelWorking: true });
  return { version: 1, buy: block('lt'), sell: block('gt') };
}

function operand(value, constantAllowed = false) {
  if (constantAllowed && value?.kind === 'number') {
    if (!finite(value.value)) throw new Error('Comparison values must be finite numbers.');
    return { kind: 'number', value: value.value };
  }
  if (!value || !METRICS.has(value.metric) || !['rolling', 'accumulating'].includes(value.window)
    || !Number.isInteger(value.period) || value.period < 1 || value.period > 200) {
    throw new Error('Choose a valid indicator and a rolling period between 1 and 200 bars.');
  }
  return { ...(constantAllowed ? { kind: 'metric' } : {}), metric: value.metric, window: value.window, period: value.period };
}

export function validateSimpleStrategy(raw) {
  if (!raw || raw.version !== 1) throw new Error('Unsupported Simple strategy format.');
  const result = { version: 1 };
  for (const side of ['buy', 'sell']) {
    const b = raw[side];
    if (!b || typeof b.enabled !== 'boolean' || !['all', 'any'].includes(b.join)
      || !Array.isArray(b.conditions) || b.conditions.length < 1 || b.conditions.length > 20
      || !['shares', 'cashPct', 'positionPct'].includes(b.amountType)
      || !finite(b.amount) || b.amount <= 0 || b.amount > (b.amountType === 'shares' ? 1000000 : 100)
      || !['MARKET', 'LIMIT'].includes(b.orderType)
      || !finite(b.limitOffsetBps) || Math.abs(b.limitOffsetBps) > 1000
      || !Number.isInteger(b.cooldown) || b.cooldown < 1 || b.cooldown > 1000) {
      throw new Error(`Invalid ${side} settings. Use a positive amount, a market/limit order, and a cooldown of 1–1000 rounds.`);
    }
    result[side] = { ...b, cancelWorking: b.cancelWorking === true, conditions: b.conditions.map((c) => {
      const p = c.persistence;
      if (!OPERATORS.has(c.operator) || !finite(c.tolerance) || c.tolerance < 0 || c.tolerance > 100
        || !p || !['consecutive', 'rollingHits', 'accumulatingHits'].includes(p.mode)
        || !Number.isInteger(p.count) || p.count < 1 || p.count > 1000
        || !Number.isInteger(p.window) || p.window < 1 || p.window > 1000
        || (p.mode === 'rollingHits' && p.count > p.window)) {
        throw new Error('Check each comparison, tolerance and condition-persistence setting.');
      }
      return { left: operand(c.left), operator: c.operator, right: operand(c.right, true), tolerance: c.tolerance,
        persistence: { mode: p.mode, count: p.count, window: p.window } };
    }) };
  }
  return result;
}

export function featureValue(spec, snapshot) {
  if (spec.kind === 'number') return spec.value;
  if (spec.metric === 'volume' && snapshot.volume_available === false) return null;
  if (spec.metric === 'cash') return snapshot.account?.cash;
  if (spec.metric === 'position') return snapshot.account?.shares;
  const closes = snapshot.close || [];
  const last = closes.at(-1);
  if (spec.metric === 'price') return finite(last) ? last : null;
  if (spec.window === 'accumulating') {
    const c = snapshot.cumulative;
    if (!c || !c.count) return null;
    if (spec.metric === 'mean') return c.mean;
    if (spec.metric === 'std') return c.std;
    if (spec.metric === 'volume') return c.volume;
    if (spec.metric === 'return') return c.firstPrice > 0 ? (last / c.firstPrice - 1) * 100 : null;
    if (spec.metric === 'rsi') return c.gain + c.loss > 0 ? 100 * c.gain / (c.gain + c.loss) : 50;
  }
  const period = spec.period;
  if (spec.metric === 'rsi') {
    if (closes.length <= period) return null;
    const value = rsi(closes, period).at(-1);
    return finite(value) ? value : null;
  }
  if (spec.metric === 'return') return closes.length > period && closes.at(-1 - period) > 0 ? (last / closes.at(-1 - period) - 1) * 100 : null;
  const values = (spec.metric === 'volume' ? snapshot.volume : closes)?.slice(-period) || [];
  if (values.length < period || !values.every(finite)) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  if (spec.metric === 'volume') return sum;
  const mean = sum / values.length;
  if (spec.metric === 'mean') return mean;
  if (spec.metric === 'std') return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return null;
}

export function compare(operator, a, b, previous, tolerance = 1) {
  if (!finite(a) || !finite(b)) return false;
  switch (operator) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'around': return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * tolerance / 100);
    case 'crossAbove': return !!previous && finite(previous.a) && finite(previous.b) && previous.a <= previous.b && a > b;
    case 'crossBelow': return !!previous && finite(previous.a) && finite(previous.b) && previous.a >= previous.b && a < b;
    default: return false;
  }
}

export class SimpleEngine {
  async init(code) {
    this.strategy = validateSimpleStrategy(typeof code === 'string' ? JSON.parse(code) : code);
    this.memory = new Map(); this.lastAction = { buy: -Infinity, sell: -Infinity };
    this.sequence = 0; this.lastKey = null;
  }
  condition(condition, key, snapshot) {
    const memory = this.memory.get(key) || { consecutive: 0, hits: 0, recent: [], previous: null };
    const a = featureValue(condition.left, snapshot), b = featureValue(condition.right, snapshot);
    const hit = compare(condition.operator, a, b, memory.previous, condition.tolerance);
    memory.previous = { a, b }; memory.consecutive = hit ? memory.consecutive + 1 : 0;
    memory.hits += hit ? 1 : 0; memory.recent.push(hit ? 1 : 0);
    if (memory.recent.length > condition.persistence.window) memory.recent.shift();
    this.memory.set(key, memory);
    const p = condition.persistence;
    return (p.mode === 'accumulatingHits' ? memory.hits : p.mode === 'rollingHits'
      ? memory.recent.reduce((x, y) => x + y, 0) : memory.consecutive) >= p.count;
  }
  async step(snapshot) {
    const key = snapshot.bar_index ?? snapshot.round;
    if (key != null && key === this.lastKey) return { actions: [], logs: [] };
    this.lastKey = key; this.sequence += 1;
    const signals = {};
    for (const side of ['buy', 'sell']) {
      const block = this.strategy[side];
      // Evaluate every condition: short-circuiting would corrupt hit counters.
      const results = block.conditions.map((c, i) => this.condition(c, `${side}:${i}`, snapshot));
      signals[side] = block.enabled && (block.join === 'all' ? results.every(Boolean) : results.some(Boolean))
        && this.sequence - this.lastAction[side] >= block.cooldown;
    }
    if (signals.buy && signals.sell) return { actions: [], logs: ['Both buy and sell rules matched; skipped this round.'] };
    const side = signals.buy ? 'buy' : signals.sell ? 'sell' : null;
    if (!side) return { actions: [], logs: [] };
    const block = this.strategy[side];
    const mid = snapshot.book?.mid;
    if (!finite(mid) || mid <= 0) return { actions: [], logs: [] };
    const price = Math.round(mid * (1 + block.limitOffsetBps / 10000) * 100) / 100;
    if (!(price > 0)) return { actions: [], logs: [] };
    const qty = Math.floor(block.amountType === 'shares' ? block.amount : block.amountType === 'cashPct'
      ? Math.max(0, snapshot.account?.cash || 0) * block.amount / 100 / (block.orderType === 'LIMIT' ? price : mid)
      : Math.max(0, snapshot.account?.shares || 0) * block.amount / 100);
    if (!Number.isSafeInteger(qty) || qty < 1) return { actions: [], logs: [] };
    this.lastAction[side] = this.sequence;
    return { actions: [...(block.cancelWorking ? [{ kind: 'CANCEL_ALL' }] : []),
      { kind: block.orderType, side: side.toUpperCase(), qty, ...(block.orderType === 'LIMIT' ? { price } : {}) }], logs: [] };
  }
  terminate() { this.memory?.clear(); }
}

// tools/ai-lib.mjs
// Shared helpers for practising, evaluating and publishing Tomorrow AI.

import fs from 'node:fs';
import { OrderBook } from '../src/engine/OrderBook.js';
import * as marketRandom from '../src/engine/random.js';
import { BotFleet } from '../src/engine/BotFleet.js';
import { BranchingDQN } from '../src/engine/ai/brain.js';
import { createAgent, PRICE_STYLES, QUOTE_STYLES, SIZE_LEVELS } from '../src/engine/ai/RLTrader.js';

export const BRAIN_PATH = new URL('../assets/ai-brain.json', import.meta.url);
const OPEN = 9 * 3600 + 30 * 60;
const CLOSE = 18 * 3600;
const STEP = 15;
const TICKS = (CLOSE - OPEN) / STEP;

class EventBus {
  constructor() { this.l = {}; }
  on(e, f) { (this.l[e] ||= []).push(f); }
  emit(e, d) { (this.l[e] || []).forEach((f) => f(d)); }
}

// Seeded random numbers, so two brains can be tested on identical days
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The market draws its randomness from src/engine/random.js. If that module
// offers a seeding function (under any of these names) it is used; the bots
// that still call Math.random are seeded too.
const seedMarket = ['seed', 'setSeed', 'seedRandom', 'reseed', 'useSeed']
  .map((name) => marketRandom[name])
  .find((f) => typeof f === 'function') || null;

export function withSeed(seed, fn) {
  const original = Math.random;
  Math.random = mulberry32(seed);
  if (seedMarket) seedMarket(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
    if (seedMarket) seedMarket(Math.floor(original() * 2 ** 31)); // back to unpredictable
  }
}

// Do identical seeds really give identical market days? If not, brain
// comparisons still work but on different days, so they are noisier.
export function seedingWorks() {
  if (typeof marketRandom.random !== 'function') return true;
  const draw = () => withSeed(12345, () => [marketRandom.random(), marketRandom.random(), Math.random()]);
  const a = draw();
  const b = draw();
  return a.every((x, i) => x === b[i]);
}

export const SEEDING_WARNING =
  'Note: src/engine/random.js has no seeding function this tool recognises, so brains are compared on different random days (noisier). ' +
  'Export one named seed(n) from random.js to fix this.';

// One full trading day against the bot market. Returns the AI's day.
export function playDay(agent, aiOptions = {}) {
  const bus = new EventBus();
  const book = new OrderBook(bus);
  const fleet = new BotFleet(book, bus, { simSecsPerTick: STEP, openSecs: OPEN, closeSecs: CLOSE, ai: agent, aiOptions });
  const history = [{ price: book.getMidPrice(), simSecs: OPEN }];
  fleet.start(history);
  let exposure = 0;
  for (let tick = 1; tick <= TICKS; tick++) {
    book.currentTick = tick;
    book.expireOrders(tick);
    fleet.onTick({ tick, simSeconds: OPEN + tick * STEP, history });
    history.push({ price: book.getMidPrice(), simSecs: OPEN + tick * STEP });
    if (fleet.ai) exposure += Math.abs(fleet.ai.shares);
  }
  fleet.endDay(history);
  const ai = fleet.ai;
  const mid = book.getMidPrice();
  return {
    pnl: ai ? ai.equity(mid) - 10000 : 0,
    avgExposure: exposure / TICKS,
    stats: ai ? ai.stats : null,
    actions: ai ? ai.log.actions : [],
    experience: ai ? ai.experience() : null,
    marketMove: (mid / history[0].price - 1) * 100
  };
}

export function loadBrain(path = BRAIN_PATH) {
  if (!fs.existsSync(path)) return null;
  return BranchingDQN.fromJSON(JSON.parse(fs.readFileSync(path, 'utf8')));
}

export function saveBrain(agent, path = BRAIN_PATH) {
  fs.mkdirSync(new URL('./', path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(agent.toJSON()));
}

export function newBrain() {
  return createAgent();
}

// Practise for up to `days` days or `minutes` minutes, whichever comes first.
export function practise(agent, { days = Infinity, minutes = Infinity, log = console.log, saveEvery = 10, save = null } = {}) {
  const t0 = Date.now();
  const recent = [];
  let played = 0;
  while (played < days && (Date.now() - t0) / 60000 < minutes) {
    const r = playDay(agent);
    played += 1;
    recent.push(r.pnl);
    if (played % 10 === 0) {
      const avg = recent.reduce((s, x) => s + x, 0) / recent.length;
      log(`  day ${String(agent.episodes).padStart(5)} | last ${recent.length} days avg ${fmt(avg).padStart(9)} | exploring ${(agent.epsilon * 100).toFixed(0).padStart(3)}% | ${((Date.now() - t0) / 1000 / played).toFixed(1)} s/day`);
      recent.length = 0;
    }
    if (save && played % saveEvery === 0) save(agent);
  }
  if (save) save(agent);
  return played;
}

export const fmt = (x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));

// Greedy play (no exploration, no learning) on seeded days.
export function scoreOnDays(agent, seeds) {
  return seeds.map((seed) => withSeed(seed, () => playDay(agent, { greedy: true, learning: false, record: true })));
}

// How a brain behaves: which order styles and sizes it chooses.
export function describeBehaviour(results) {
  const counts = { size: new Array(SIZE_LEVELS.length).fill(0), price: new Array(PRICE_STYLES.length).fill(0), quote: new Array(QUOTE_STYLES.length).fill(0) };
  for (const r of results) {
    for (let i = 0; i < r.actions.length; i += 3) {
      counts.size[r.actions[i]] += 1;
      counts.price[r.actions[i + 1]] += 1;
      counts.quote[r.actions[i + 2]] += 1;
    }
  }
  const pct = (arr, names) => {
    const tot = arr.reduce((s, x) => s + x, 0) || 1;
    return names.map((n, i) => `${n} ${Math.round((arr[i] / tot) * 100)}%`).filter((s) => !s.endsWith(' 0%')).join(', ');
  };
  return {
    sizes: pct(counts.size, SIZE_LEVELS.map((s) => `${s > 0 ? '+' : ''}${s * 100}%`)),
    prices: pct(counts.price, PRICE_STYLES),
    quotes: pct(counts.quote, QUOTE_STYLES),
    avgExposure: mean(results.map((r) => r.avgExposure))
  };
}

// Paired comparison of two brains on the same seeded days.
export function compare(candidate, incumbent, seeds) {
  const a = scoreOnDays(candidate, seeds).map((r) => r.pnl);
  const b = incumbent ? scoreOnDays(incumbent, seeds).map((r) => r.pnl) : seeds.map(() => 0);
  const diff = a.map((x, i) => x - b[i]);
  return { candidate: mean(a), incumbent: mean(b), diff: mean(diff), se: sd(diff) / Math.sqrt(diff.length), candidatePnls: a };
}

export { mean, sd };

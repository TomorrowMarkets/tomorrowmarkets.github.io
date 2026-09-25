// src/engine/ai/RLTrader.js
// "Tomorrow AI": one reinforcement-learning trader in every game.
//
// Every simulated minute it makes three decisions at once:
//   size   - target position, from full short to full long (9 levels)
//   price  - how to get there: market, sweep 2c through, take the touch,
//            improve the book by 1c, join the book, or sit 2c / 5c back
//   quotes - optionally also quote both sides (none / tight / wide)
// Unfilled orders are cancelled at the next decision, so it has to learn the
// trade-off between a better price and the risk of not getting filled.
//
// It learns from the change in its marked-to-market equity, starts out
// completely random, and records each game compactly so the nightly trainer
// can replay it and fold it into the long-term brain.

import { BaseBot } from '../bots.js';
import { BranchingDQN, toB64, b64Bytes, fromB64 } from './brain.js';
import { stepFeatures, ObservationBuilder, OBS_SIZE, STEP_COUNT } from './features.js';

export const AI_ID = 'bot:ai';
export const AI_NAME = 'Tomorrow AI';

export const SIZE_LEVELS = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
export const PRICE_STYLES = ['market', 'sweep', 'take', 'improve', 'join', 'back2', 'back5'];
export const QUOTE_STYLES = ['none', 'tight', 'wide'];
export const BRANCHES = [SIZE_LEVELS.length, PRICE_STYLES.length, QUOTE_STYLES.length];

const START_CASH = 10000;   // same as a player
const REWARD_SCALE = 10;    // $10 of profit = reward 1
const RISK_PENALTY = 0.02;  // per decision at full size: a nudge against idle risk
const round2 = (n) => Math.round(n * 100) / 100;

export function createAgent(config = {}) {
  return new BranchingDQN(OBS_SIZE, BRANCHES, { normSize: STEP_COUNT, ...config });
}

export class RLTraderBot extends BaseBot {
  static TYPE = 'ai';

  constructor(id, fleet, opts = {}) {
    super(id, fleet, opts);
    this.agent = opts.agent;
    this.learning = opts.learning !== false; // update the brain while playing
    this.greedy = !!opts.greedy;             // no exploration and no learning (for tests)
    this.record = opts.record !== false;     // keep a log of the game for the nightly trainer
    this.every = opts.every ?? 4;            // decide every 4 steps = 1 simulated minute
    this.obs = new ObservationBuilder(this.agent.norm);
    this.startEquity = START_CASH;
    this.last = null;
    this.intent = null;
    this.lastFillRatio = 1;
    this.timeInPosition = 0;
    this.sinceLearn = 0;
    this.log = { steps: [], actions: [], rewards: [] };
    this.stats = { decisions: 0, orders: 0, marketOrders: 0 };
  }

  unrealizedAt(mid) {
    if (this.shares > 0) return this.shares * (mid - this.avgEntry);
    if (this.shares < 0) return -this.shares * (this.avgEntry - mid);
    return 0;
  }

  equity(mid) {
    return START_CASH + this.realized + this.unrealizedAt(mid);
  }

  onTick(m) {
    if (this.fleet.tick % this.every === 0) this.step(m, false);
  }

  // Closing bell: final reward, the day is over.
  finish(m) {
    this.step(m, true);
  }

  step(m, done) {
    const eq = this.equity(m.mid);
    const maxShares = Math.max(1, Math.floor(eq / m.mid));

    // How much of what it tried to trade last minute actually filled?
    if (this.intent) {
      const want = Math.abs(this.intent.qty);
      this.lastFillRatio = want > 0 ? Math.min(1, Math.abs(this.shares - this.intent.from) / want) : 1;
    }
    this.timeInPosition = this.last && Math.sign(this.shares) === this.last.sign ? this.timeInPosition + 1 : 0;

    const raw = stepFeatures(m, this, eq);
    const obs = this.obs.build(raw, !this.greedy);

    if (this.last) {
      const exposure = Math.abs(this.shares) / maxShares;
      const reward = (eq - this.last.equity) / REWARD_SCALE - RISK_PENALTY * exposure * exposure;
      if (!this.greedy) {
        this.agent.remember(this.last.obs, this.last.actions, reward, obs, done);
        this.sinceLearn += 1;
        if (this.learning && this.sinceLearn >= this.agent.config.learnEvery) {
          this.sinceLearn = 0;
          this.agent.learn();
        }
      }
      if (this.record) this.log.rewards.push(reward);
    }
    if (this.record) this.log.steps.push(raw);

    if (done) {
      this.cancelAll();
      this.last = null;
      return;
    }

    const actions = this.agent.act(obs, this.greedy);
    if (this.record) this.log.actions.push(...actions);
    this.cancelAll(); // last minute's unfilled orders
    this.execute(actions, eq, maxShares, m.mid);
    this.stats.decisions += 1;
    this.last = { obs, actions, equity: eq, sign: Math.sign(this.shares) };
  }

  execute(actions, eq, maxShares, mid) {
    const bb = this.book.bestBid();
    const ba = this.book.bestAsk();
    const target = Math.round(SIZE_LEVELS[actions[0]] * maxShares);
    const delta = target - this.shares;
    this.intent = { from: this.shares, qty: delta };
    const ttl = this.every + 1;

    if (delta !== 0) {
      const side = delta > 0 ? 'BUY' : 'SELL';
      const qty = Math.abs(delta);
      const style = PRICE_STYLES[actions[1]];
      this.stats.orders += 1;
      if (style === 'market' || bb == null || ba == null) {
        this.market(side, qty);
        this.stats.marketOrders += 1;
      } else {
        const buy = side === 'BUY';
        const own = buy ? bb : ba;
        const opp = buy ? ba : bb;
        const dir = buy ? 1 : -1;
        let price;
        switch (style) {
          case 'sweep': price = opp + dir * 0.02; break;
          case 'take': price = opp; break;
          case 'improve': price = buy ? Math.min(own + 0.01, opp - 0.01) : Math.max(own - 0.01, opp + 0.01); break;
          case 'join': price = own; break;
          case 'back2': price = own - dir * 0.02; break;
          default: price = own - dir * 0.05; break; // back5
        }
        this.limit(side, round2(price), qty, ttl);
      }
    }

    // Optional market making on top: small quotes on both sides
    const quote = QUOTE_STYLES[actions[2]];
    if (quote !== 'none' && bb != null && ba != null) {
      const off = quote === 'tight' ? 0 : 0.03;
      const size = Math.max(1, Math.round(0.1 * maxShares));
      if (target + size <= maxShares) this.limit('BUY', round2(bb - off), size, ttl);
      if (target - size >= -maxShares) this.limit('SELL', round2(ba + off), size, ttl);
    }
  }

  // Compact record of this game (about 100 KB) for the nightly trainer
  experience() {
    const { steps, actions, rewards } = this.log;
    const flat = new Float32Array(steps.length * STEP_COUNT);
    steps.forEach((s, i) => flat.set(s, i * STEP_COUNT));
    return {
      format: 2,
      stepCount: STEP_COUNT,
      branches: BRANCHES,
      decisions: rewards.length,
      steps: toB64(flat),
      actions: toB64(Uint8Array.from(actions)),
      rewards: toB64(Float32Array.from(rewards)),
      generation: this.agent.generation,
      pnl: Math.round((this.equity(this.fleet.book.getMidPrice()) - START_CASH) * 100) / 100
    };
  }
}

// Replay a recorded game into an agent's memory (used by the nightly trainer).
// Observations are rebuilt from the raw steps with the agent's own normaliser.
export function replayGame(agent, exp) {
  if (exp.format !== 2 || exp.stepCount !== STEP_COUNT || String(exp.branches) !== String(BRANCHES)) return 0;
  const steps = fromB64(exp.steps);
  const actions = b64Bytes(exp.actions);
  const rewards = fromB64(exp.rewards);
  const T = rewards.length;
  if (steps.length !== (T + 1) * STEP_COUNT || actions.length !== T * BRANCHES.length) return 0;
  // Validate everything first: a bad upload must not leave half a game behind
  if (!steps.every(Number.isFinite) || !rewards.every((r) => Number.isFinite(r) && Math.abs(r) <= 1000)) return 0;
  for (let i = 0; i < actions.length; i++) if (actions[i] >= BRANCHES[i % BRANCHES.length]) return 0;

  const builder = new ObservationBuilder(agent.norm);
  let prev = null;
  for (let t = 0; t <= T; t++) {
    const obs = builder.build(steps.subarray(t * STEP_COUNT, (t + 1) * STEP_COUNT), true);
    if (prev) {
      const a = Uint8Array.from(actions.subarray((t - 1) * BRANCHES.length, t * BRANCHES.length));
      agent.remember(prev, a, rewards[t - 1], obs, t === T);
    }
    prev = obs;
  }
  return T;
}

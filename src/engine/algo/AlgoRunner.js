// src/engine/algo/AlgoRunner.js
// Owns one player's strategy (Python via PyEngine, R via REngine), gives each
// decision a wall-clock budget, and turns what the strategy asked for into
// the same actions a human's order ticket sends (SUBMIT_ORDER, CANCEL_ALL).
// An algorithmic trader therefore goes through exactly the same validation,
// matching and multiplayer path as a discretionary one.
import { PyEngine } from './PyEngine.js';
import { REngine } from './REngine.js';

export const DECISION_BUDGET_MS = 60000; // up to a minute per decision
const MAX_ERROR_STREAK = 5;              // stop a script that errors this many rounds in a row
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class AlgoRunner {
  constructor(language) {
    this.language = language === 'r' ? 'r' : 'python';
    this.budgetMs = DECISION_BUDGET_MS;
    this.engine = this._newEngine();
    this.code = null;
    this.status = 'idle'; // idle | loading | ready | running | error
    this.busy = false;
    this.errorStreak = 0;
    this.decisions = 0;

    this.onStatus = null; // (status, detail) => void
    this.onLog = null;    // ({ level, text }) => void; level: buy | sell | error | warn | log | debug
    this.onAction = null; // (action) => void, action shaped like a USER_ACTION
  }

  get label() {
    return this.language === 'r' ? 'R' : 'Python';
  }

  _newEngine() {
    return this.language === 'r' ? new REngine() : new PyEngine();
  }

  async init(code) {
    this.code = code;
    this._setStatus('loading');
    try {
      await this._withBudget(this.engine.init(code));
      this._setStatus('ready');
    } catch (err) {
      this._setStatus('error', err.message);
      throw err;
    }
  }

  // Algo Lab check: load the script, call on_tick once on a sample market,
  // then reload the source so the test run leaves no state behind. Nothing
  // it asks for is traded. Resolves with { actions, logs } from the test run.
  async validate(code, sample) {
    await this.init(code);
    let res;
    try {
      res = await this._withBudget(this.engine.step(sample));
    } catch (err) {
      this._setStatus('error', err.message);
      throw new Error(`on_tick(data) failed on a test market:\n${err.message}`);
    }
    await this.init(code);
    return res;
  }

  // One decision round. Always resolves (never rejects) once the strategy
  // has finished, failed, or run out of time, so the game can move on.
  async decide(snapshot) {
    if (this.busy || this.status === 'error' || this.status === 'loading') return false;
    this.busy = true;
    this._setStatus('running');
    const t0 = now();
    try {
      const res = await this._withBudget(this.engine.step(snapshot));
      this.decisions += 1;
      this.errorStreak = 0;
      this._setStatus('ready');
      for (const line of res.logs || []) this._log(line, 'log');
      for (const raw of res.actions || []) this._submit(raw);
      this._log(`Decided in ${Math.round(now() - t0)} ms.`, 'debug');
      return true;
    } catch (err) {
      await this._onStepFailed(err);
      return false;
    } finally {
      this.busy = false;
    }
  }

  async _onStepFailed(err) {
    const timedOut = /timed out/i.test(err.message || '');
    this._log(err.message, 'error');

    if (timedOut) {
      // A stuck computation can't be interrupted safely, so start a fresh
      // runtime from the same source (variables kept between rounds reset).
      // The restart runs in the background so this round still answers on
      // time; the strategy sits out rounds until it's loaded again.
      this._log(`Restarting the ${this.label} runtime after that timeout. Variables kept between rounds were reset.`, 'warn');
      try { this.engine.terminate(); } catch (e) { /* best effort */ }
      this.engine = this._newEngine();
      this.init(this.code).catch((err2) => this._log(`Could not restart the strategy: ${err2.message}`, 'error'));
      return;
    }

    this.errorStreak += 1;
    if (this.errorStreak >= MAX_ERROR_STREAK) {
      this._setStatus('error', `stopped after ${MAX_ERROR_STREAK} errors in a row`);
      this._log(`Strategy stopped after ${MAX_ERROR_STREAK} errors in a row. Fix it in the Algo Lab and run it again next game.`, 'error');
    } else {
      this._setStatus('ready'); // one bad round doesn't end the day
    }
  }

  _submit(raw) {
    const kind = String(raw.kind || '').toUpperCase();
    if (kind === 'CANCEL_ALL') {
      this._log('Cancel all working orders', 'warn');
      if (this.onAction) this.onAction({ type: 'CANCEL_ALL', source: 'algo' });
      return;
    }

    const sideStr = String(raw.side || '').toUpperCase();
    const side = sideStr === 'BUY' ? 'BUY' : sideStr === 'SELL' ? 'SELL' : null;
    const qty = Math.floor(Number(raw.qty));
    if (!side) return this._log(`Ignored an order with side "${raw.side}". Use "buy" or "sell".`, 'error');
    if (!(qty >= 1)) return this._log(`Ignored an order for ${raw.qty} shares. Quantity must be at least 1.`, 'error');

    const isLimit = kind === 'LIMIT';
    const price = isLimit ? Math.round(Number(raw.price) * 100) / 100 : 0;
    if (isLimit && !(price > 0)) return this._log(`Ignored a limit order at price ${raw.price}.`, 'error');

    this._log(`${side === 'BUY' ? 'Buy' : 'Sell'} ${qty} ${isLimit ? `limit @ $${price.toFixed(2)}` : 'at market'}`, side === 'BUY' ? 'buy' : 'sell');
    if (this.onAction) {
      this.onAction({ type: 'SUBMIT_ORDER', source: 'algo', order: { side, type: isLimit ? 'LIMIT' : 'MARKET', price, qty, sl: null, tp: null } });
    }
  }

  _withBudget(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(this.budgetMs / 1000)} s.`)), this.budgetMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  _setStatus(status, detail = null) {
    this.status = status;
    if (this.onStatus) this.onStatus(status, detail);
  }

  _log(text, level) {
    if (this.onLog) this.onLog({ level, text: String(text) });
  }

  dispose() {
    try { this.engine.terminate(); } catch (err) { /* best effort */ }
  }
}

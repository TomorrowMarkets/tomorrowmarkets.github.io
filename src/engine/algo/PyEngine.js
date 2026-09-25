// src/engine/algo/PyEngine.js
// Main-thread handle to one player's Python strategy, running in its own
// pyWorker.js Web Worker (see that file for why). This class only knows how
// to start the worker and exchange messages with it; timing out a slow
// tick and deciding what to do about it is AlgoRunner's job, not this one's.
const WORKER_URL = new URL('./pyWorker.js', import.meta.url);

export class PyEngine {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map(); // request id -> { resolve, reject }
  }

  _spawn() {
    this.worker = new Worker(WORKER_URL, { type: 'module' });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => this._failAll(e.message || 'The Python worker crashed.');
  }

  _onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || 'Python error.'));
  }

  _failAll(reason) {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  _send(type, extra) {
    if (!this.worker) this._spawn();
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...extra });
    });
  }

  // Loads Pyodide (first call only — cached by the browser after that) and
  // runs the strategy source once. Rejects with a readable message if the
  // source doesn't parse, throws on import, or never defines on_tick(data).
  init(code) {
    return this._send('init', { code });
  }

  // Runs on_tick(data) once more. Resolves with { actions, logs }.
  step(data) {
    return this._send('step', { data });
  }

  terminate() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this._failAll('The Python runtime was restarted.');
  }
}

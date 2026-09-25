// src/engine/ai/brain.js
// The AI's brain: a neural network plus a Branching Dueling Double DQN
// (Tavakoli et al., 2018) with n-step returns and experience replay.
//
// "Branching" means one decision per step is really several at once (how big
// a position, what price to trade at, whether to quote both sides), each with
// its own output head on a shared network, so adding options stays cheap.
// Plain JavaScript with no dependencies: the same code practises in Node and
// keeps learning live inside the browser game.

function gauss() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// ---- typed arrays <-> base64 (Node and browsers) ----------------------------
export function toB64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64Bytes(str) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
export function fromB64(str) {
  const bytes = b64Bytes(str);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

// ===================================================================
// MLP: fully connected, leaky-ReLU hidden layers, linear output. Works on
// whole batches at once (rows of a flat Float32Array) for speed.
// Weights are row-major per output unit: W[l][j * nIn + i].
// ===================================================================
export class MLP {
  constructor(sizes) {
    this.sizes = sizes;
    this.W = [];
    this.b = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const w = new Float32Array(sizes[l] * sizes[l + 1]);
      const scale = Math.sqrt(2 / sizes[l]); // He initialisation
      for (let i = 0; i < w.length; i++) w[i] = gauss() * scale;
      this.W.push(w);
      this.b.push(new Float32Array(sizes[l + 1]));
    }
  }

  get layers() { return this.sizes.length - 1; }

  get paramCount() {
    return this.W.reduce((s, w) => s + w.length, 0) + this.b.reduce((s, b) => s + b.length, 0);
  }

  // X: B rows of sizes[0]. Returns every layer's activations (input first).
  forward(X, B = 1) {
    const acts = [X];
    let h = X;
    for (let l = 0; l < this.layers; l++) {
      const nIn = this.sizes[l];
      const nOut = this.sizes[l + 1];
      const W = this.W[l];
      const bias = this.b[l];
      const out = new Float32Array(B * nOut);
      const hidden = l < this.layers - 1;
      for (let j = 0; j < nOut; j++) {
        const wOff = j * nIn;
        for (let r = 0; r < B; r++) {
          const hOff = r * nIn;
          // 4-way unrolled dot product (a cheap ~1.5x speed-up in JS engines)
          let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
          let i = 0;
          for (; i + 3 < nIn; i += 4) {
            s0 += W[wOff + i] * h[hOff + i];
            s1 += W[wOff + i + 1] * h[hOff + i + 1];
            s2 += W[wOff + i + 2] * h[hOff + i + 2];
            s3 += W[wOff + i + 3] * h[hOff + i + 3];
          }
          for (; i < nIn; i++) s0 += W[wOff + i] * h[hOff + i];
          const s = bias[j] + s0 + s1 + s2 + s3;
          out[r * nOut + j] = hidden && s < 0 ? 0.01 * s : s;
        }
      }
      acts.push(out);
      h = out;
    }
    return acts;
  }

  output(X, B = 1) {
    const acts = this.forward(X, B);
    return acts[acts.length - 1];
  }

  // dOut: B rows of d(loss)/d(output). Adds parameter gradients into grads.
  backward(acts, dOut, grads, B = 1) {
    let delta = dOut;
    for (let l = this.layers - 1; l >= 0; l--) {
      const nIn = this.sizes[l];
      const nOut = this.sizes[l + 1];
      const hIn = acts[l];
      const W = this.W[l];
      const gW = grads.gW[l];
      const gb = grads.gb[l];
      const prev = l > 0 ? new Float32Array(B * nIn) : null;
      for (let j = 0; j < nOut; j++) {
        const wOff = j * nIn;
        for (let r = 0; r < B; r++) {
          const d = delta[r * nOut + j];
          if (d === 0) continue;
          gb[j] += d;
          const hOff = r * nIn;
          if (prev) {
            for (let i = 0; i < nIn; i++) {
              gW[wOff + i] += d * hIn[hOff + i];
              prev[hOff + i] += d * W[wOff + i];
            }
          } else {
            for (let i = 0; i < nIn; i++) gW[wOff + i] += d * hIn[hOff + i];
          }
        }
      }
      if (prev) {
        for (let k = 0; k < prev.length; k++) if (hIn[k] <= 0) prev[k] *= 0.01; // leaky ReLU
        delta = prev;
      }
    }
  }

  zeroGrads() {
    return { gW: this.W.map((w) => new Float32Array(w.length)), gb: this.b.map((b) => new Float32Array(b.length)) };
  }

  copyFrom(other) {
    for (let l = 0; l < this.layers; l++) {
      this.W[l].set(other.W[l]);
      this.b[l].set(other.b[l]);
    }
  }

  toJSON() {
    return { sizes: this.sizes, W: this.W.map(toB64), b: this.b.map(toB64) };
  }

  static fromJSON(j) {
    const net = new MLP(j.sizes);
    net.W = j.W.map((s) => new Float32Array(fromB64(s)));
    net.b = j.b.map((s) => new Float32Array(fromB64(s)));
    return net;
  }
}

// ===================================================================
// ADAM with global gradient-norm clipping
// ===================================================================
export class Adam {
  constructor(net, { lr = 2e-4, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, clip = 10 } = {}) {
    Object.assign(this, { lr, beta1, beta2, eps, clip });
    this.t = 0;
    this.mW = net.W.map((w) => new Float32Array(w.length));
    this.vW = net.W.map((w) => new Float32Array(w.length));
    this.mb = net.b.map((b) => new Float32Array(b.length));
    this.vb = net.b.map((b) => new Float32Array(b.length));
  }

  step(net, { gW, gb }, scale = 1) {
    let norm2 = 0;
    for (const g of [...gW, ...gb]) for (let i = 0; i < g.length; i++) norm2 += g[i] * g[i];
    const norm = Math.sqrt(norm2) * scale;
    const k = norm > this.clip ? (scale * this.clip) / norm : scale;
    this.t += 1;
    const c1 = 1 - this.beta1 ** this.t;
    const c2 = 1 - this.beta2 ** this.t;
    const { beta1, beta2, eps, lr } = this;
    const upd = (p, g, m, v) => {
      for (let i = 0; i < p.length; i++) {
        const gi = g[i] * k;
        m[i] = beta1 * m[i] + (1 - beta1) * gi;
        v[i] = beta2 * v[i] + (1 - beta2) * gi * gi;
        p[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + eps);
      }
    };
    for (let l = 0; l < net.W.length; l++) {
      upd(net.W[l], gW[l], this.mW[l], this.vW[l]);
      upd(net.b[l], gb[l], this.mb[l], this.vb[l]);
    }
  }
}

// ===================================================================
// Running feature normaliser (Welford), clipped to ±5 standard deviations
// ===================================================================
export class Normalizer {
  constructor(n) {
    this.n = 0;
    this.mean = new Float64Array(n);
    this.m2 = new Float64Array(n);
  }

  update(x) {
    this.n += 1;
    for (let i = 0; i < x.length; i++) {
      const d = x[i] - this.mean[i];
      this.mean[i] += d / this.n;
      this.m2[i] += d * (x[i] - this.mean[i]);
    }
  }

  apply(x) {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const sd = this.n > 1 ? Math.sqrt(this.m2[i] / (this.n - 1)) : 1;
      const z = (x[i] - this.mean[i]) / (sd > 1e-9 ? sd : 1);
      out[i] = Math.max(-5, Math.min(5, z));
    }
    return out;
  }

  toJSON() { return { n: this.n, mean: Array.from(this.mean), m2: Array.from(this.m2) }; }

  load(j) {
    this.n = j.n;
    this.mean = Float64Array.from(j.mean);
    this.m2 = Float64Array.from(j.m2);
  }
}

// ===================================================================
// BRANCHING DUELING DOUBLE DQN
//   Q_d(s, a) = V(s) + A_d(s, a) - mean_a A_d(s, ·)   for each branch d
//   target  y = r_n + γ^n · mean_d Q_d^target(s', argmax_a Q_d^online(s', a))
// Exploration: epsilon-greedy per branch, starting 100% random.
// ===================================================================
const DEFAULTS = {
  hidden: [256, 256],
  gamma: 0.97,        // per decision (one simulated minute)
  nStep: 5,
  lr: 2e-4,
  batch: 64,
  bufferSize: 150000,
  warmup: 3000,       // transitions collected before learning starts
  learnEvery: 2,      // decisions per gradient step
  targetSync: 1500,   // gradient steps between target-network syncs
  epsStart: 1.0,      // born completely random…
  epsEnd: 0.05,       // …settling at 5% exploration
  epsDecay: 60000     // decisions to get there (about 120 simulated days)
};

export class BranchingDQN {
  constructor(nIn, branches, config = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.nIn = nIn;
    this.branches = branches; // e.g. [9, 7, 3]
    this.nOut = 1 + branches.reduce((s, n) => s + n, 0);
    this.offsets = [];
    let off = 1;
    for (const n of branches) {
      this.offsets.push(off);
      off += n;
    }
    const sizes = [nIn, ...this.config.hidden, this.nOut];
    this.online = new MLP(sizes);
    this.target = new MLP(sizes);
    this.target.copyFrom(this.online);
    this.opt = new Adam(this.online, { lr: this.config.lr });

    this.decisions = 0;  // lifetime experience (drives exploration)
    this.updates = 0;
    this.episodes = 0;   // trading days played
    this.generation = 0; // bumped each time a nightly-trained brain is published
    this.norm = this.config.normSize ? new Normalizer(this.config.normSize) : null; // raw-feature statistics
    this.allocBuffer(this.config.bufferSize);
    this.nq = [];
  }

  allocBuffer(size) {
    const D = this.branches.length;
    this.buf = {
      cap: size,
      s: new Float32Array(size * this.nIn),
      s2: new Float32Array(size * this.nIn),
      a: new Uint8Array(size * D),
      r: new Float32Array(size),
      g: new Float32Array(size),
      done: new Uint8Array(size),
      size: 0,
      next: 0
    };
  }

  get epsilon() {
    const { epsStart, epsEnd, epsDecay } = this.config;
    return Math.max(epsEnd, epsStart - (this.decisions / epsDecay) * (epsStart - epsEnd));
  }

  // Q-values per branch from one output row
  branchQ(raw, rowOff = 0) {
    const out = [];
    const V = raw[rowOff];
    for (let d = 0; d < this.branches.length; d++) {
      const n = this.branches[d];
      const o = rowOff + this.offsets[d];
      let mean = 0;
      for (let j = 0; j < n; j++) mean += raw[o + j];
      mean /= n;
      const q = new Float32Array(n);
      for (let j = 0; j < n; j++) q[j] = V + raw[o + j] - mean;
      out.push(q);
    }
    return out;
  }

  act(x, greedy = false) {
    if (!greedy) this.decisions += 1;
    const eps = greedy ? 0 : this.epsilon;
    const qs = this.branchQ(this.online.output(x, 1));
    return Uint8Array.from(qs, (q) => {
      if (Math.random() < eps) return Math.floor(Math.random() * q.length);
      let best = 0;
      for (let j = 1; j < q.length; j++) if (q[j] > q[best]) best = j;
      return best;
    });
  }

  // Store one decision's outcome; n-step returns are assembled here.
  remember(s, actions, r, s2, done) {
    this.nq.push({ s, a: actions, r });
    if (this.nq.length >= this.config.nStep) this.flushOne(s2, false);
    if (done) {
      while (this.nq.length) this.flushOne(s2, true);
      this.episodes += 1;
    }
  }

  flushOne(sNext, done) {
    let R = 0;
    let g = 1;
    for (const t of this.nq) {
      R += g * t.r;
      g *= this.config.gamma;
    }
    const first = this.nq.shift();
    const B = this.buf;
    const i = B.next;
    B.s.set(first.s, i * this.nIn);
    B.s2.set(sNext, i * this.nIn);
    B.a.set(first.a, i * this.branches.length);
    B.r[i] = R;
    B.g[i] = g;
    B.done[i] = done ? 1 : 0;
    B.next = (i + 1) % B.cap;
    B.size = Math.min(B.size + 1, B.cap);
  }

  // One gradient step on a random minibatch. Returns the mean |TD error|.
  learn() {
    const Bf = this.buf;
    const { batch } = this.config;
    if (Bf.size < Math.max(this.config.warmup, batch)) return null;
    const nIn = this.nIn;
    const D = this.branches.length;
    const S = new Float32Array(batch * nIn);
    const S2 = new Float32Array(batch * nIn);
    const idx = new Int32Array(batch);
    for (let k = 0; k < batch; k++) {
      const i = Math.floor(Math.random() * Bf.size);
      idx[k] = i;
      S.set(Bf.s.subarray(i * nIn, (i + 1) * nIn), k * nIn);
      S2.set(Bf.s2.subarray(i * nIn, (i + 1) * nIn), k * nIn);
    }

    // Double-DQN targets, averaged across branches
    const onNext = this.online.output(S2, batch);
    const tgNext = this.target.output(S2, batch);
    const y = new Float32Array(batch);
    for (let k = 0; k < batch; k++) {
      const i = idx[k];
      y[k] = Bf.r[i];
      if (Bf.done[i]) continue;
      const qOn = this.branchQ(onNext, k * this.nOut);
      const qTg = this.branchQ(tgNext, k * this.nOut);
      let sum = 0;
      for (let d = 0; d < D; d++) {
        let best = 0;
        for (let j = 1; j < qOn[d].length; j++) if (qOn[d][j] > qOn[d][best]) best = j;
        sum += qTg[d][best];
      }
      y[k] += Bf.g[i] * (sum / D);
    }

    const acts = this.online.forward(S, batch);
    const raw = acts[acts.length - 1];
    const dOut = new Float32Array(batch * this.nOut);
    let tdSum = 0;
    for (let k = 0; k < batch; k++) {
      const row = k * this.nOut;
      const qs = this.branchQ(raw, row);
      for (let d = 0; d < D; d++) {
        const n = this.branches[d];
        const a = Bf.a[idx[k] * D + d];
        const td = qs[d][a] - y[k];
        tdSum += Math.abs(td);
        const g = Math.max(-1, Math.min(1, td)) / D; // Huber, averaged over branches
        dOut[row] += g; // dQ/dV
        const o = row + this.offsets[d];
        for (let j = 0; j < n; j++) dOut[o + j] += g * ((j === a ? 1 : 0) - 1 / n);
      }
    }
    const grads = this.online.zeroGrads();
    this.online.backward(acts, dOut, grads, batch);
    this.opt.step(this.online, grads, 1 / batch);
    this.updates += 1;
    if (this.updates % this.config.targetSync === 0) this.target.copyFrom(this.online);
    return tdSum / (batch * D);
  }

  // ---- saving / loading ------------------------------------------------------
  toJSON() {
    return {
      kind: 'tomorrow-markets-bdq',
      version: 2,
      nIn: this.nIn,
      branches: this.branches,
      config: this.config,
      decisions: this.decisions,
      updates: this.updates,
      episodes: this.episodes,
      generation: this.generation,
      online: this.online.toJSON(),
      norm: this.norm ? this.norm.toJSON() : null
    };
  }

  static fromJSON(j, overrides = {}) {
    const agent = new BranchingDQN(j.nIn, j.branches, { ...j.config, ...overrides });
    agent.online = MLP.fromJSON(j.online);
    agent.target.copyFrom(agent.online);
    agent.opt = new Adam(agent.online, { lr: agent.config.lr });
    agent.decisions = j.decisions;
    agent.updates = j.updates;
    agent.episodes = j.episodes;
    agent.generation = j.generation || 0;
    if (j.norm && agent.norm) agent.norm.load(j.norm);
    return agent;
  }
}

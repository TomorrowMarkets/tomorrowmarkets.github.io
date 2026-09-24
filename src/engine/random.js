// src/engine/random.js
// The one random source for the whole engine (bots and fleet). Unseeded it
// starts from Math.random, so every game is a new day. Seed it to replay a
// day exactly: the same seed gives the same market as long as the same
// orders go in, which is what a fair shared challenge or a backtest needs.

let a = 0;
let b = 0;
let c = 0;
let d = 0;

// sfc32: small, fast, and good enough for a market simulation
export function random() {
  a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
  const t = (a + b) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  d = (d + 1) | 0;
  const r = (t + d) | 0;
  c = (c + r) | 0;
  return (r >>> 0) / 4294967296;
}

// Seed from a number or any string (e.g. 'blind-quant-2026-09-24')
export function seed(s) {
  let h = 1779033703 ^ String(s).length;
  for (const ch of String(s)) {
    h = Math.imul(h ^ ch.codePointAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const next = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
  a = next(); b = next(); c = next(); d = next();
  for (let i = 0; i < 15; i++) random(); // mix the state before first use
}

// Standard normal draw (Box–Muller)
export function gauss() {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

seed(Math.random());

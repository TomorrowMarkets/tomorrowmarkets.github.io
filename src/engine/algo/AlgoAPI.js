// src/engine/algo/AlgoAPI.js
// Builds the read-only snapshot handed to a player's strategy at every
// decision round: OHLCV history, ready-made moving averages and returns,
// the visible order book (with an imbalance figure), the player's own
// working orders and account. It's plain JSON-safe data, so it marshals the
// same way into Python (Pyodide) and R (webR).
import { sma, ema } from '../indicators.js';

const MAX_BARS = 300;   // plenty for usual lookbacks, small enough to send every round
const BOOK_DEPTH = 15;  // matches the levels shown in the order book panel

// NaN / Infinity -> null, so Python gets None and R gets NA instead of NaN.
const nz = (v) => (Number.isFinite(v) ? v : null);

function pctReturns(closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    out[i] = Number.isFinite(prev) && Number.isFinite(cur) && prev !== 0 ? (cur - prev) / prev : null;
  }
  return out;
}

// priceHistory: per-tick bars { price, open, high, low, volume, simTimeStr }
//   (`price` is the close), i.e. the game's priceHistory / a client's history.
// bids / asks: aggregated levels, best first [{ price, qty }] as carried by
//   every TICK event, so solo, host and client all build it the same way.
// openOrders: this player's working orders [{ id, side, price, qty }].
// account: { cash, shares, avgEntry, realizedPnL, unrealized(mid) }.
export function buildSnapshot({
  priceHistory = [], bids = [], asks = [], mid = null, openOrders = [],
  account, simTimeStr = null, round = 0
}) {
  const bars = priceHistory.slice(-MAX_BARS).map((p) => ({
    time: p.simTimeStr || null,
    open: nz(p.open ?? p.price),
    high: nz(p.high ?? p.price),
    low: nz(p.low ?? p.price),
    close: nz(p.price),
    volume: p.volume || 0
  }));

  const close = bars.map((b) => b.close);
  const numeric = close.map((c) => (c == null ? NaN : c));

  const bidLevels = bids.slice(0, BOOK_DEPTH).map((l) => ({ price: l.price, qty: l.qty }));
  const askLevels = asks.slice(0, BOOK_DEPTH).map((l) => ({ price: l.price, qty: l.qty }));
  const bidVol = bidLevels.reduce((s, l) => s + l.qty, 0);
  const askVol = askLevels.reduce((s, l) => s + l.qty, 0);
  const bestBid = bidLevels[0] ? bidLevels[0].price : null;
  const bestAsk = askLevels[0] ? askLevels[0].price : null;
  const midPx = Number.isFinite(mid) ? mid
    : (bestBid != null && bestAsk != null) ? (bestBid + bestAsk) / 2
    : (close.length ? close[close.length - 1] : null);

  return {
    round,
    time: simTimeStr,
    bars,
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close,
    volume: bars.map((b) => b.volume),
    returns: pctReturns(close),
    sma20: sma(numeric, 20).map(nz),
    sma50: sma(numeric, 50).map(nz),
    ema12: ema(numeric, 12).map(nz),
    ema26: ema(numeric, 26).map(nz),
    book: {
      bids: bidLevels,
      asks: askLevels,
      mid: nz(midPx),
      best_bid: nz(bestBid),
      best_ask: nz(bestAsk),
      spread: bestBid != null && bestAsk != null ? nz(Math.round((bestAsk - bestBid) * 1e4) / 1e4) : null,
      // (bid size - ask size) / (bid size + ask size) over the visible levels:
      // +1 all resting size on the bid, -1 all on the ask, 0 balanced/empty.
      imbalance: bidVol + askVol > 0 ? nz((bidVol - askVol) / (bidVol + askVol)) : 0
    },
    orders: openOrders.map((o) => ({ id: o.id, side: o.side, price: o.price, qty: o.qty })),
    account: {
      cash: nz(account.cash),
      shares: account.shares || 0,
      avg_entry: nz(account.avgEntry),
      realized_pnl: nz(account.realizedPnL),
      unrealized_pnl: nz(typeof account.unrealized === 'function' && midPx != null ? account.unrealized(midPx) : 0)
    }
  };
}

// A made-up but realistic market used to test-run a strategy in the Algo Lab
// before it's allowed into a game, so obvious bugs surface there and not
// halfway through the day.
export function sampleSnapshot(startingCash = 10000) {
  const history = [];
  let px = 100;
  for (let i = 0; i < 120; i++) {
    const open = px;
    px = Math.max(1, px + (Math.random() - 0.5) * 0.08);
    history.push({
      price: Math.round(px * 100) / 100,
      open: Math.round(open * 100) / 100,
      high: Math.round((Math.max(open, px) + Math.random() * 0.02) * 100) / 100,
      low: Math.round((Math.min(open, px) - Math.random() * 0.02) * 100) / 100,
      volume: Math.floor(Math.random() * 400),
      simTimeStr: null
    });
  }
  const last = history[history.length - 1].price;
  const lvl = (i, dir) => ({ price: Math.round((last + dir * (0.01 + i * 0.01)) * 100) / 100, qty: 50 + Math.floor(Math.random() * 500) });
  return buildSnapshot({
    priceHistory: history,
    bids: Array.from({ length: BOOK_DEPTH }, (_, i) => lvl(i, -1)),
    asks: Array.from({ length: BOOK_DEPTH }, (_, i) => lvl(i, 1)),
    account: { cash: startingCash, shares: 0, avgEntry: 0, realizedPnL: 0, unrealized: () => 0 },
    simTimeStr: 'test',
    round: 0
  });
}

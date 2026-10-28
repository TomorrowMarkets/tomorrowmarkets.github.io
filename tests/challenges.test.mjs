import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PortfolioChallenge, validatePortfolioDataset, validateWeights, chooseAnnualWindow, anniversary } from '../src/engine/PortfolioChallenge.js';
import { HistoricalMarket, validateOrderbookDataset } from '../src/engine/HistoricalMarket.js';
import { OrderBook } from '../src/engine/OrderBook.js';
import { publicSettings, loadCatalog, fetchJSON } from '../src/services/data-catalog.js';
import { donationLink } from '../src/ui/donations.js';

const raw = JSON.parse(await readFile(new URL('../data/portfolio/demo-30.json', import.meta.url)));
function fixedDataset() {
  const data = structuredClone(raw);
  data.prices = data.dates.map(() => Array(30).fill(100));
  return data;
}
function challenge(data = fixedDataset(), options = {}) {
  const game = new PortfolioChallenge(data, { rng: () => 0, ...options });
  game.register('Alice');
  game.register('Bob');
  game.start(0);
  return game;
}
const allocation = (a = 1, b = 0) => [a, b, ...Array(28).fill(0)];

test('random windows are exactly one calendar year, including leap-day handling', () => {
  const data = validatePortfolioDataset(raw);
  const first = chooseAnnualWindow(data, () => 0);
  const last = chooseAnnualWindow(data, () => 0.99999999);
  assert.equal(data.dates[first.end], anniversary(data.dates[first.start]));
  assert.equal(data.dates[last.end], anniversary(data.dates[last.start]));
  assert.notEqual(first.start, last.start);
  assert.equal(anniversary('2020-02-29'), '2021-02-28');
});

test('reject incomplete, non-adjusted, missing-price and malformed data', () => {
  for (const change of [
    (d) => { d.assets.pop(); }, (d) => { d.adjusted = false; },
    (d) => { d.prices[10][0] = null; }, (d) => { d.prices[10][0] = Infinity; },
    (d) => { d.dates[10] = d.dates[9]; }, (d) => { d.currency = 'GBP'; },
    (d) => { d.source = 'Synthetic demo'; d.demo = false; }
  ]) {
    const data = structuredClone(raw); change(data);
    assert.throws(() => validatePortfolioDataset(data));
  }
  const short = structuredClone(raw);
  short.dates = short.dates.slice(0, 201); short.prices = short.prices.slice(0, 201);
  assert.throws(() => new PortfolioChallenge(short), /one-calendar-year/);
});

test('allocations reject leverage, shorts, non-numbers and invalid totals', () => {
  for (const weights of [allocation(-0.1), allocation(0.6, 0.5), allocation(NaN), allocation(Infinity), Array(30).fill('0'), []]) {
    assert.throws(() => validateWeights(weights));
  }
  assert.equal(validateWeights(allocation(0.3, 0.2)).reduce((a, b) => a + b), 0.5);
});

test('returns compound and unchanged target percentages rebalance each round', () => {
  const data = fixedDataset();
  const game = challenge(data, { stride: 1 });
  const start = game.window.start;
  game.data.prices[start + 1][0] = 110;
  game.data.prices[start + 2][0] = 121;
  game.submit('Alice', allocation(0.5, 0.5), 0, 0);
  game.advance(game.deadline);
  assert.ok(Math.abs(game.players.get('Alice').capital - 10500) < 1e-7);
  game.advance(game.deadline);
  assert.ok(Math.abs(game.players.get('Alice').capital - 11025) < 1e-7);
  assert.equal(game.players.get('Bob').capital, 10000); // no action = cash
});

test('unallocated cash is retained and multiple saves use the last valid allocation', () => {
  const game = challenge(undefined, { stride: 1 });
  game.data.prices[game.window.start + 1][0] = 120;
  game.submit('Alice', allocation(1), 0, 0);
  game.submit('Alice', allocation(0.25), 0, 1);
  assert.throws(() => game.submit('Alice', allocation(1.1), 0, 2));
  game.advance(game.deadline);
  assert.ok(Math.abs(game.players.get('Alice').capital - 10500) < 1e-7);
});

test('drawdown includes daily losses inside a weekly round', () => {
  const game = challenge();
  const start = game.window.start;
  game.data.prices[start + 1][0] = 80;
  game.data.prices[start + 5][0] = 110;
  game.submit('Alice', allocation(), 0, 0);
  game.advance(game.deadline);
  assert.ok(Math.abs(game.players.get('Alice').capital - 11000) < 1e-7);
  assert.ok(Math.abs(game.players.get('Alice').maxDrawdown - 0.2) < 1e-7);
});

test('round cutoff is strict and stale or unknown-player submissions fail', () => {
  const game = challenge();
  assert.throws(() => game.submit('Alice', allocation(), 0, game.deadline), /closed/);
  assert.throws(() => game.submit('Eve', allocation(), 0, 0), /not a player/);
  assert.throws(() => game.register('Eve'), /before/);
  game.advance(game.deadline);
  assert.throws(() => game.submit('Alice', allocation(), 0, game.deadline - 1), /closed/);
});

test('a suspended host advances one round then gives a full fresh decision period', () => {
  const game = challenge();
  const late = game.deadline + 10000000;
  assert.equal(game.advance(late), true);
  assert.equal(game.round, 1);
  assert.equal(game.deadline, late + game.roundMs);
  assert.equal(game.advance(late), false);
});

test('snapshots expose only current/past prices and the receiving player’s weights', () => {
  const game = challenge();
  game.submit('Bob', allocation(0.8), 0, 0);
  const snapshot = game.snapshot('Alice');
  assert.equal(snapshot.assets.length, 30);
  assert.deepEqual(snapshot.account.history, [10000]);
  assert.equal(snapshot.assets[0].price, game.data.prices[game.window.start][0]);
  assert.equal('prices' in snapshot, false);
  assert.equal('data' in snapshot, false);
  assert.equal('accounts' in snapshot, false);
  assert.equal(JSON.stringify(snapshot).includes('"pending":[0.8'), false);
});

test('challenge reaches the exact final date, including a partial final weekly round', () => {
  const game = challenge();
  while (!game.finished) game.advance(game.deadline);
  assert.equal(game.snapshot('Alice').date, anniversary(game.snapshot('Alice').startDate));
  assert.equal(game.players.get('Alice').history.length, game.window.end - game.window.start + 1);
  assert.equal(game.advance(1e20), false);
  assert.throws(() => game.submit('Alice', allocation(), game.round, 1e20));
});

function replayData() {
  return { version: 1, kind: 'orderbook', currency: 'USD', symbol: 'TEST', frames: [
    { timestamp: '2024-01-02T09:30:00Z', bids: [{ price: 99, qty: 10 }], asks: [{ price: 101, qty: 5 }] },
    { timestamp: '2024-01-02T09:30:01Z', bids: [{ price: 98, qty: 10 }], asks: [{ price: 99, qty: 3 }] },
    { timestamp: '2024-01-02T09:30:02Z', bids: [{ price: 109, qty: 10 }], asks: [{ price: 111, qty: 3 }] }
  ] };
}

test('historical replay fills against finite recorded depth without replenishing a frame twice', () => {
  const trades = [];
  const book = new OrderBook({ emit: (name, trade) => trades.push(trade) });
  const market = new HistoricalMarket(book, replayData());
  market.start();
  const fill = book.processOrder({ playerId: 'Alice', side: 'BUY', type: 'MARKET', qty: 7 });
  assert.equal(fill.filledQty, 5);
  market.advance(0);
  assert.equal(book.asks.length, 0);
  assert.equal(trades.length, 1);
});

test('player orders survive refresh, fill when crossed, and cannot change the historical mark', () => {
  const trades = [];
  const book = new OrderBook({ emit: (name, trade) => trades.push(trade) });
  const market = new HistoricalMarket(book, replayData());
  market.start();
  book.processOrder({ id: 'alice-limit', playerId: 'Alice', side: 'BUY', type: 'LIMIT', price: 100, qty: 4 });
  assert.equal(book.getMidPrice(), 100);
  market.advance(0.5);
  assert.equal(book.findOrder('alice-limit').order.qty, 1);
  assert.equal(trades[0].buyerId, 'Alice');
  assert.equal(trades[0].qty, 3);
  assert.equal(book.getMidPrice(), 98.5);
});

test('coarse playback visits every snapshot, including the final one', () => {
  const book = new OrderBook();
  const market = new HistoricalMarket(book, replayData());
  market.start();
  const visited = [];
  market.advance(1, () => visited.push(book.getMidPrice()));
  assert.deepEqual(visited, [98.5, 110]);
  assert.equal(market.timestamp, '2024-01-02T09:30:02Z');
});

test('invalid books and nonfinite orders are rejected', () => {
  for (const modify of [
    (d) => { d.frames[0].bids[0].price = 102; },
    (d) => { d.frames[1].timestamp = d.frames[0].timestamp; },
    (d) => { d.frames[0].asks[0].qty = Infinity; },
    (d) => { d.frames[0].timestamp = '2024-01-02T09:30:00'; },
    (d) => { d.frames[0].asks[0].price = 101.001; }
  ]) { const data = replayData(); modify(data); assert.throws(() => validateOrderbookDataset(data)); }
  const book = new OrderBook();
  assert.equal(book.processOrder({ playerId: 'x', side: 'BUY', type: 'LIMIT', price: Infinity, qty: 10 }), null);
  assert.equal(book.processOrder({ playerId: 'x', side: 'BUY', type: 'MARKET', qty: Infinity }), null);
});

test('public settings strip datasets and allocation state', () => {
  const settings = publicSettings({ durationMinutes: 15, dataSource: 'historical', datasetId: 'test', prices: [100, 200], pending: [1] });
  assert.equal(settings.durationMinutes, 15);
  assert.equal('prices' in settings, false);
  assert.equal('pending' in settings, false);
});

test('catalog paths work under a GitHub Pages repository subdirectory', async () => {
  const catalog = await loadCatalog('./data/manifest.json', 'https://example.com/markets/index.html', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: 1, orderbooks: [{ id: 'book', label: 'Test', path: 'orderbooks/test.json' }] }) })
  });
  assert.equal(catalog.orderbooks[0].url, 'https://example.com/markets/data/orderbooks/test.json');
});

test('catalog fetch errors and timeout produce actionable errors', async () => {
  await assert.rejects(fetchJSON('https://example.com/missing', { fetchImpl: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
  await assert.rejects(fetchJSON('https://example.com/slow', { timeoutMs: 1, fetchImpl: (url, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })))) }), /timed out/);
});

test('donation URL accepts an HTTPS account link and rejects executable or credential-bearing URLs', () => {
  assert.equal(donationLink({ url: '' }), null);
  assert.equal(donationLink({ url: 'javascript:alert(1)' }), null);
  assert.equal(donationLink({ url: 'https://user:secret@example.com' }), null);
  assert.equal(donationLink({ url: 'https://paypal.me/example' }), 'https://paypal.me/example');
});

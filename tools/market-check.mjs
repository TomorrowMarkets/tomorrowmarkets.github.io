
const days = [];
const byType = {};
const r1All = [];
const r30All = [];
const started = performance.now();
for (let d = 1; d <= DAYS; d++) {
  let spreadSum = 0;
  let spreadN = 0;
  let collapsed = 0;
  const { bars, trades } = simulateDay({
    seed: `${SEED}-${d}`,
    keepTrades: true,
    onStep: ({ book }) => {
      const bid = book.bestBid();
      const ask = book.bestAsk();
      if (bid == null || ask == null || ask - bid > 0.5) collapsed += 1;
      else {
        spreadSum += ask - bid;
        spreadN += 1;
      }
    }
  });
  const px = [bars[0].open, ...bars.map((b) => b.close)];
  const r = px.slice(1).map((p, i) => Math.log(p / px[i]));
  const r30 = [];
  for (let i = 30; i < px.length; i += 30) r30.push(Math.log(px[i] / px[i - 30]));
  r1All.push(...r);
  r30All.push(...r30);
  const abs = r.map(Math.abs);
  days.push({
    ret: px[px.length - 1] / px[0] - 1,
    range: (Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low))) / px[0],
    kurt: kurtosis(r),
    acf1: autocorr(r, 1),
    absAcf: [1, 5, 30].map((k) => autocorr(abs, k)),
    spread: spreadSum / spreadN,
    collapsed,
    volume: bars.reduce((s, b) => s + b.volume, 0)
  });

  // Profit and loss per trader type, marked at the close (bots start flat,
  // except random buyers holding yesterday's shares, which aren't counted)
  const close = px[px.length - 1];
  const cash = new Map();
  const pos = new Map();
  for (const t of trades) {
    for (const [id, sign] of [[t.buyerId, 1], [t.sellerId, -1]]) {
      cash.set(id, (cash.get(id) || 0) - sign * t.price * t.qty);
      pos.set(id, (pos.get(id) || 0) + sign * t.qty);
      const s = (byType[typeOf(id)] ||= { volume: 0, pnl: 0 });
      s.volume += t.qty;
    }
  }
  for (const [id, c] of cash) byType[typeOf(id)].pnl += c + pos.get(id) * close;
}

const avg = (f) => mean(days.map(f));
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const row = (label, value, real = '') => console.log(`  ${label.padEnd(34)}${String(value).padStart(10)}   ${real}`);
console.log(`\nMarket check: ${DAYS} days (seeds ${SEED}-1 … ${SEED}-${DAYS}), ${((performance.now() - started) / DAYS / 2040).toFixed(2)} ms per step\n`);
row('', 'market', 'real liquid stock, 1-minute data');
row('Daily move (average |close/open|)', pct(avg((d) => Math.abs(d.ret))));
row('Daily range (high - low)', pct(avg((d) => d.range)));
row('1-minute volatility', `${(sd(r1All) * 1e4).toFixed(2)} bp`);
row('Fat tails (excess kurtosis)', avg((d) => d.kurt).toFixed(2), 'well above 0 (Gaussian = 0)');
row('Free momentum (lag-1 autocorr)', avg((d) => d.acf1).toFixed(3), 'about 0 or slightly negative');
row('Variance ratio, 30 min', ((sd(r30All) ** 2) / (30 * sd(r1All) ** 2)).toFixed(2), 'about 1 (>1 trends, <1 mean-reverts)');
row('Vol clustering |r| autocorr, lag 1', avg((d) => d.absAcf[0]).toFixed(3), '0.2 - 0.4');
row('                     lag 5', avg((d) => d.absAcf[1]).toFixed(3), 'decays slowly…');
row('                     lag 30', avg((d) => d.absAcf[2]).toFixed(3), '…still clearly above 0');
row('Average spread', `${(avg((d) => d.spread) * 100).toFixed(2)}¢`);
row('Book collapses (steps/day)', avg((d) => d.collapsed).toFixed(2), '0 (spread > 50¢ or a side empty)');
row('Volume (shares/day)', Math.round(avg((d) => d.volume)).toLocaleString('en-US'));

console.log('\n  Trader type        volume/day   share     PnL/day');
const total = Object.values(byType).reduce((s, t) => s + t.volume, 0);
for (const [type, t] of Object.entries(byType).sort((a, b) => b[1].volume - a[1].volume)) {
  console.log(`  ${type.padEnd(16)}${Math.round(t.volume / DAYS).toLocaleString('en-US').padStart(12)} ${pct(t.volume / total).padStart(7)} ${`$${Math.round(t.pnl / DAYS).toLocaleString('en-US')}`.padStart(11)}`);
}
console.log('');

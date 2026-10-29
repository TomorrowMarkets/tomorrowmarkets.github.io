// Snapshot replay, not a reconstruction of the exchange's original queue.
// Every snapshot replaces only historical liquidity, preserving players' orders.
const HISTORICAL_ID = 'history:liquidity';
import { sourceSessions } from './session.js';

export function validateOrderbookDataset(raw) {
  if (!raw || raw.version !== 1 || raw.kind !== 'orderbook'
    || !Array.isArray(raw.frames) || raw.frames.length < 2) {
    throw new Error('An orderbook dataset needs version: 1, kind: "orderbook", and at least two frames.');
  }
  if (raw.currency !== 'USD') throw new Error('Orderbook replay currently requires USD prices.');
  let previous = -Infinity;
  const frames = raw.frames.map((frame, i) => {
    // Explicit timezone avoids differing playback on clients in other zones.
    if (typeof frame.timestamp !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(frame.timestamp)) {
      throw new Error(`Frame ${i + 1} needs an ISO timestamp with a timezone.`);
    }
    const time = Date.parse(frame.timestamp);
    if (!Number.isFinite(time) || time <= previous) throw new Error('Orderbook timestamps must increase strictly.');
    previous = time;
    const readLevels = (side) => {
      if (!Array.isArray(frame[side]) || !frame[side].length) throw new Error(`Frame ${i + 1} needs bids and asks.`);
      const seen = new Set();
      return frame[side].map((level) => {
        const price = level.price;
        const qty = level.qty;
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0
          || Math.abs(price * 100 - Math.round(price * 100)) > 1e-6
          || !Number.isSafeInteger(qty) || qty < 1 || seen.has(price)) {
          throw new Error(`Frame ${i + 1}: use unique positive cent prices and positive whole-share quantities.`);
        }
        seen.add(price);
        return { price, qty };
      }).sort((a, b) => side === 'bids' ? b.price - a.price : a.price - b.price);
    };
    const bids = readLevels('bids');
    const asks = readLevels('asks');
    if (frame.volume != null && (!Number.isSafeInteger(frame.volume) || frame.volume < 0)) throw new Error('Recorded volume must be a nonnegative whole-share quantity.');
    let trades;
    if (frame.trades != null) {
      if (!Array.isArray(frame.trades) || frame.trades.length > 10000) throw new Error('Recorded trades must be an array of at most 10,000 prints per snapshot.');
      trades = frame.trades.map(trade => {
        if (!trade || !Number.isFinite(trade.price) || trade.price <= 0 || Math.abs(trade.price*100-Math.round(trade.price*100))>1e-6
          || !Number.isSafeInteger(trade.qty) || trade.qty < 1 || !['BUY','SELL','UNKNOWN'].includes(trade.side || 'UNKNOWN')) throw new Error('Recorded prints need a positive cent price, whole-share quantity and BUY/SELL/UNKNOWN aggressor.');
        return {price:trade.price,qty:trade.qty,side:trade.side || 'UNKNOWN'};
      });
      const total = trades.reduce((sum,trade)=>sum+trade.qty,0);
      if (!Number.isSafeInteger(total) || (frame.volume != null && frame.volume !== total)) throw new Error('Snapshot volume must equal its recorded trade quantities when trades are provided.');
    }
    if (bids[0].price >= asks[0].price) throw new Error(`Frame ${i + 1} has a locked or crossed book.`);
    return { timestamp: frame.timestamp, time, bids, asks, ...(trades ? {trades,volume:trades.reduce((sum,t)=>sum+t.qty,0)} : frame.volume != null ? {volume:frame.volume} : {}),
      ...(typeof frame.sessionDate === 'string' ? {sessionDate:frame.sessionDate} : {}) };
  });
  return { version: 1, kind: 'orderbook', currency: 'USD', symbol: String(raw.symbol || 'Replay'),
    demo: raw.demo === true, frames };
}

export class HistoricalMarket {
  constructor(orderBook, dataset) {
    this.book = orderBook;
    this.dataset = validateOrderbookDataset(dataset);
    this.frames = this.dataset.frames;
    this.sessions = sourceSessions(this.dataset);
    this.hasVolume = this.frames.every(frame => Number.isFinite(frame.volume));
    this.hasTrades = this.frames.every(frame => Array.isArray(frame.trades));
    const gaps = this.sessions.flatMap(day => day.frames.slice(1).map((frame,i)=>(frame.time-day.frames[i].time)/1000)).sort((a,b)=>a-b);
    this.resolutionSeconds = gaps.length ? gaps[Math.floor(gaps.length/2)] : null;
    this.position = -1;
    this.timestamp = null;
  }

  start(onSnapshot = null) {
    this.position = -1;
    this.advance(0, onSnapshot);
  }

  advance(progress, onSnapshot = null) {
    const normalized = Math.min(1, Math.max(0, progress));
    const scaled = normalized * this.sessions.length;
    // An exact close belongs to the day just completed. Tomorrow's opening
    // quote must not leak into the preceding day's final decision bar.
    const index = Math.max(0, Math.min(this.sessions.length - 1, Math.ceil(scaled) - 1));
    const local = normalized === 0 ? 0 : scaled - index;
    const frames = this.sessions[index].frames;
    const first = frames[0].time, last = frames.at(-1).time;
    const target = first + local * (last - first);
    // Consume all crossed snapshots, even when chart updates are coarser than
    // the source. A snapshot is never replenished twice at the same timestamp.
    while (this.position + 1 < this.frames.length && this.frames[this.position + 1].time <= target) {
      this.apply(this.frames[++this.position]);
      if (onSnapshot) onSnapshot();
    }
  }

  apply(frame) {
    this.currentFrame = frame;
    this.book.clearPlayerOrders(HISTORICAL_ID);
    // Mark accounts to the recorded mid, not a player's outlying resting quote.
    this.book.referencePrice = (frame.bids[0].price + frame.asks[0].price) / 2;
    this.book.lastPrice = this.book.referencePrice;
    this.timestamp = frame.timestamp;
    for (const [levels, side] of [[frame.bids, 'BUY'], [frame.asks, 'SELL']]) {
      for (const level of levels) {
        this.book.processOrder({ playerId: HISTORICAL_ID, side, type: 'LIMIT', ...level });
      }
    }
  }
}

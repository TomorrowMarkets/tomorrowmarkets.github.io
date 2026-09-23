/**
 * 100-BOT MARKET FLEET SYSTEM
 */

// 1. MARKET MAKER BOT (10 Bots)
class MarketMakerBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.spreadWidth = 0.10 + Math.random() * 0.20; // Customized spread per MM
    this.orderSize = Math.floor(Math.random() * 30) + 10;
  }

  onTick() {
    const mid = this.orderBook.getMidPrice();

    // Cancel / clear out old orders from this MM to keep the book clean
    this.orderBook.bids = this.orderBook.bids.filter(b => b.playerId !== this.id);
    this.orderBook.asks = this.orderBook.asks.filter(a => a.playerId !== this.id);

    // Provide 3 tiers of bid/ask liquidity depth
    for (let i = 1; i <= 3; i++) {
      const bidPrice = parseFloat((mid - (this.spreadWidth * i)).toFixed(2));
      const askPrice = parseFloat((mid + (this.spreadWidth * i)).toFixed(2));

      if (bidPrice > 0) {
        this.orderBook.processOrder({
          playerId: this.id,
          side: 'BUY',
          price: bidPrice,
          qty: this.orderSize * i,
          type: 'LIMIT'
        });
      }

      this.orderBook.processOrder({
        playerId: this.id,
        side: 'SELL',
        price: askPrice,
        qty: this.orderSize * i,
        type: 'LIMIT'
      });
    }
  }
}

// 2. NOISE / RETAIL BOT (50 Bots)
class NoiseBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.actProbability = 0.15; // 15% chance to act per tick
  }

  onTick() {
    if (Math.random() > this.actProbability) return;

    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const isMarket = Math.random() > 0.4;
    const qty = Math.floor(Math.random() * 15) + 1;
    const mid = this.orderBook.getMidPrice();

    if (isMarket) {
      this.orderBook.processOrder({ playerId: this.id, side, price: 0, qty, type: 'MARKET' });
    } else {
      const offset = (Math.random() - 0.5) * 0.60;
      const price = parseFloat((mid + offset).toFixed(2));
      if (price > 0) {
        this.orderBook.processOrder({ playerId: this.id, side, price, qty, type: 'LIMIT' });
      }
    }
  }
}

// 3. MOMENTUM / TREND FOLLOWING BOT (20 Bots)
class TrendBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.lookback = Math.floor(Math.random() * 5) + 3; // Look back 3 to 8 ticks
  }

  onTick(history) {
    if (history.length < this.lookback) return;

    const recent = history.slice(-this.lookback);
    const startPrice = recent[0].price;
    const currentPrice = recent[recent.length - 1].price;
    const diff = currentPrice - startPrice;

    // Trigger directional trade if trend threshold is met
    if (Math.abs(diff) >= 0.15) {
      const side = diff > 0 ? 'BUY' : 'SELL';
      const qty = Math.floor(Math.random() * 25) + 10;
      this.orderBook.processOrder({ playerId: this.id, side, price: 0, qty, type: 'MARKET' });
    }
  }
}

// 4. MEAN REVERSION BOT (15 Bots)
class MeanReversionBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.period = 10; // 10-tick SMA
  }

  onTick(history) {
    if (history.length < this.period) return;

    const recent = history.slice(-this.period);
    const sum = recent.reduce((acc, curr) => acc + curr.price, 0);
    const sma = sum / this.period;
    const currentMid = this.orderBook.getMidPrice();
    const deviation = currentMid - sma;

    // Counter-trend order when price deviates significantly from mean
    if (deviation > 0.30) {
      // Overbought -> Sell
      this.orderBook.processOrder({ playerId: this.id, side: 'SELL', price: 0, qty: 15, type: 'MARKET' });
    } else if (deviation < -0.30) {
      // Oversold -> Buy
      this.orderBook.processOrder({ playerId: this.id, side: 'BUY', price: 0, qty: 15, type: 'MARKET' });
    }
  }
}

// 5. INSTITUTIONAL WHALE BOT (5 Bots)
class WhaleBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.triggerThreshold = 0.02; // Rare execution (2% chance per tick)
  }

  onTick() {
    if (Math.random() > this.triggerThreshold) return;

    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const blockQty = Math.floor(Math.random() * 150) + 100; // Large block order (100 - 250 units)

    this.orderBook.processOrder({
      playerId: this.id,
      side,
      price: 0,
      qty: blockQty,
      type: 'MARKET'
    });
  }
}

// 6. CENTRAL FLEET MANAGER
export class BotFleet {
  constructor(orderBook) {
    this.orderBook = orderBook;
    this.bots = [];
    this.initFleet();
  }

  initFleet() {
    // 10 Market Makers
    for (let i = 0; i < 10; i++) {
      this.bots.push(new MarketMakerBot(`mm_${i}`, this.orderBook));
    }
    // 50 Noise / Retail Bots
    for (let i = 0; i < 50; i++) {
      this.bots.push(new NoiseBot(`retail_${i}`, this.orderBook));
    }
    // 20 Momentum / Trend Bots
    for (let i = 0; i < 20; i++) {
      this.bots.push(new TrendBot(`trend_${i}`, this.orderBook));
    }
    // 15 Mean Reversion Bots
    for (let i = 0; i < 15; i++) {
      this.bots.push(new MeanReversionBot(`mr_${i}`, this.orderBook));
    }
    // 5 Institutional Whales
    for (let i = 0; i < 5; i++) {
      this.bots.push(new WhaleBot(`whale_${i}`, this.orderBook));
    }
  }

  onTick(priceHistory) {
    // Run tick updates across all 100 bots
    for (let i = 0; i < this.bots.length; i++) {
      this.bots[i].onTick(priceHistory);
    }
  }
}

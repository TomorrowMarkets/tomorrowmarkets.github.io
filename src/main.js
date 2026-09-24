import { PeerNetwork } from './net/PeerNetwork.js';

// ===================================================================
// 1. EVENT BUS
// ===================================================================
class EventBus {
  constructor() {
    this.listeners = {};
  }
  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }
  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => cb(data));
    }
  }
}

// ===================================================================
// 2. ACCOUNT MANAGER WITH SYMMETRIC CAPITAL POOL
// ===================================================================
class AccountManager {
  constructor(eventBus, playerId = 'Trader_1') {
    this.eventBus = eventBus;
    this.playerId = playerId;
    this.cash = 10000.00;
    this.shares = 0;
    this.avgEntry = 0.00;
    this.realizedPnL = 0.00;

    if (this.eventBus) {
      this.eventBus.on('TRADE', (trade) => this.onTrade(trade));
    }
  }

  setPlayerId(id) {
    this.playerId = id;
    this.broadcastState();
  }

  canPlaceOrder(side, type, price, qty, currentMidPrice = 100) {
    const execPrice = type === 'MARKET' ? currentMidPrice : price;
    const orderCost = execPrice * qty;

    if (side === 'BUY') {
      if (this.shares >= 0) {
        if (this.cash < orderCost) {
          return { allowed: false, reason: `Insufficient capital ($${this.cash.toFixed(2)}) to buy ${qty} shares (Requires $${orderCost.toFixed(2)}).` };
        }
      } else {
        const shortQtyToCover = Math.min(qty, Math.abs(this.shares));
        const flipLongQty = qty - shortQtyToCover;
        const flipCost = flipLongQty * execPrice;

        if (flipCost > 0 && this.cash < flipCost) {
          return { allowed: false, reason: `Insufficient capital ($${this.cash.toFixed(2)}) to open net long position of ${flipLongQty} shares.` };
        }
      }
    } else if (side === 'SELL') {
      if (this.shares <= 0) {
        if (this.cash < orderCost) {
          return { allowed: false, reason: `Insufficient capital ($${this.cash.toFixed(2)}) to short sell ${qty} shares (Requires $${orderCost.toFixed(2)}).` };
        }
      } else {
        const longQtyToClose = Math.min(qty, this.shares);
        const flipShortQty = qty - longQtyToClose;
        const flipCost = flipShortQty * execPrice;

        if (flipCost > 0 && this.cash < flipCost) {
          return { allowed: false, reason: `Insufficient capital ($${this.cash.toFixed(2)}) to open net short position of ${flipShortQty} shares.` };
        }
      }
    }

    return { allowed: true };
  }

  broadcastState() {
    if (this.eventBus) {
      this.eventBus.emit('ACCOUNT_UPDATE', {
        cash: this.cash,
        shares: this.shares,
        avgEntry: this.avgEntry,
        realizedPnL: this.realizedPnL
      });
    }
  }

  onTrade(trade) {
    const { buyerId, sellerId, price, qty } = trade;
    let updated = false;

    if (buyerId === this.playerId) {
      let remainingQty = qty;
      if (this.shares < 0) {
        const coverQty = Math.min(remainingQty, Math.abs(this.shares));
        const pnl = (this.avgEntry - price) * coverQty;
        this.realizedPnL += pnl;
        this.cash += (coverQty * this.avgEntry) + pnl;
        this.shares += coverQty;
        if (this.shares === 0) this.avgEntry = 0;
        remainingQty -= coverQty;
      }
      if (remainingQty > 0) {
        const cost = price * remainingQty;
        this.cash -= cost;
        const totalCost = (this.shares * this.avgEntry) + cost;
        this.shares += remainingQty;
        this.avgEntry = this.shares > 0 ? totalCost / this.shares : 0;
      }
      updated = true;
    }

    if (sellerId === this.playerId) {
      let remainingQty = qty;
      if (this.shares > 0) {
        const closeQty = Math.min(remainingQty, this.shares);
        const pnl = (price - this.avgEntry) * closeQty;
        this.realizedPnL += pnl;
        this.cash += (closeQty * this.avgEntry) + pnl;
        this.shares -= closeQty;
        if (this.shares === 0) this.avgEntry = 0;
        remainingQty -= closeQty;
      }
      if (remainingQty > 0) {
        const shortCost = price * remainingQty;
        this.cash -= shortCost;
        const currentShortQty = Math.abs(this.shares);
        const totalShortVal = (currentShortQty * this.avgEntry) + shortCost;
        this.shares -= remainingQty;
        this.avgEntry = Math.abs(this.shares) > 0 ? totalShortVal / Math.abs(this.shares) : 0;
      }
      updated = true;
    }

    if (updated) this.broadcastState();
  }
}

// ===================================================================
// 3. ORDER BOOK MATCHING ENGINE
// ===================================================================
class OrderBook {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.bids = [];
    this.asks = [];
    this.lastPrice = 100.00;
  }

  getMidPrice() {
    if (this.bids.length > 0 && this.asks.length > 0) {
      return (this.bids[0].price + this.asks[0].price) / 2;
    }
    if (this.bids.length > 0) return this.bids[0].price;
    if (this.asks.length > 0) return this.asks[0].price;
    return this.lastPrice || 100.00;
  }

  clearPlayerOrders(playerId) {
    this.bids = this.bids.filter((b) => b.playerId !== playerId);
    this.asks = this.asks.filter((a) => a.playerId !== playerId);
  }

  processOrder(order) {
    const { playerId, side, price, qty, type } = order;
    if (!qty || qty <= 0) return;

    if (type === 'MARKET') {
      this.executeMarketOrder(playerId, side, qty);
    } else {
      if (!price || price <= 0) return;
      this.executeLimitOrder(playerId, side, price, qty);
    }
  }

  executeMarketOrder(playerId, side, qty) {
    let remainingQty = qty;
    const targetBook = side === 'BUY' ? this.asks : this.bids;

    while (remainingQty > 0 && targetBook.length > 0) {
      const topOrder = targetBook[0];
      const execQty = Math.min(remainingQty, topOrder.qty);
      const execPrice = topOrder.price;

      this.lastPrice = execPrice;
      remainingQty -= execQty;
      topOrder.qty -= execQty;

      if (this.eventBus) {
        this.eventBus.emit('TRADE', {
          buyerId: side === 'BUY' ? playerId : topOrder.playerId,
          sellerId: side === 'SELL' ? playerId : topOrder.playerId,
          price: execPrice,
          qty: execQty
        });
      }

      if (topOrder.qty <= 0) targetBook.shift();
    }
  }

  executeLimitOrder(playerId, side, price, qty) {
    let remainingQty = qty;

    if (side === 'BUY') {
      while (remainingQty > 0 && this.asks.length > 0 && this.asks[0].price <= price) {
        const topAsk = this.asks[0];
        const execQty = Math.min(remainingQty, topAsk.qty);
        const execPrice = topAsk.price;

        this.lastPrice = execPrice;
        remainingQty -= execQty;
        topAsk.qty -= execQty;

        if (this.eventBus) {
          this.eventBus.emit('TRADE', {
            buyerId: playerId,
            sellerId: topAsk.playerId,
            price: execPrice,
            qty: execQty
          });
        }

        if (topAsk.qty <= 0) this.asks.shift();
      }

      if (remainingQty > 0) {
        this.bids.push({ id: Math.random().toString(), playerId, price, qty: remainingQty });
        this.bids.sort((a, b) => b.price - a.price);
      }
    } else {
      while (remainingQty > 0 && this.bids.length > 0 && this.bids[0].price >= price) {
        const topBid = this.bids[0];
        const execQty = Math.min(remainingQty, topBid.qty);
        const execPrice = topBid.price;

        this.lastPrice = execPrice;
        remainingQty -= execQty;
        topBid.qty -= execQty;

        if (this.eventBus) {
          this.eventBus.emit('TRADE', {
            buyerId: topBid.playerId,
            sellerId: playerId,
            price: execPrice,
            qty: execQty
          });
        }

        if (topBid.qty <= 0) this.bids.shift();
      }

      if (remainingQty > 0) {
        this.asks.push({ id: Math.random().toString(), playerId, price, qty: remainingQty });
        this.asks.sort((a, b) => a.price - b.price);
      }
    }
  }
}

// ===================================================================
// 4. BOT ECOSYSTEM
// ===================================================================
class MarketMakerBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.spread = 0.05 + Math.random() * 0.05;
    this.baseQty = Math.floor(Math.random() * 20) + 15;
  }

  onTick() {
    this.orderBook.clearPlayerOrders(this.id);
    const mid = this.orderBook.getMidPrice();

    for (let level = 1; level <= 4; level++) {
      const bidPrice = parseFloat((mid - this.spread * level).toFixed(2));
      const askPrice = parseFloat((mid + this.spread * level).toFixed(2));

      if (bidPrice > 0) {
        this.orderBook.processOrder({ playerId: this.id, side: 'BUY', price: bidPrice, qty: this.baseQty * level, type: 'LIMIT' });
      }
      this.orderBook.processOrder({ playerId: this.id, side: 'SELL', price: askPrice, qty: this.baseQty * level, type: 'LIMIT' });
    }
  }
}

class NoiseBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.actProbability = 0.15;
  }

  onTick() {
    if (Math.random() > this.actProbability) return;
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const isMarket = Math.random() > 0.40;
    const qty = Math.floor(Math.random() * 10) + 1;
    const mid = this.orderBook.getMidPrice();

    if (isMarket) {
      this.orderBook.processOrder({ playerId: this.id, side, price: 0, qty, type: 'MARKET' });
    } else {
      const offset = (Math.random() - 0.5) * 0.30;
      const price = parseFloat((mid + offset).toFixed(2));
      if (price > 0) {
        this.orderBook.processOrder({ playerId: this.id, side, price, qty, type: 'LIMIT' });
      }
    }
  }
}

class TrendBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.lookback = Math.floor(Math.random() * 5) + 4;
  }

  onTick(history) {
    if (!history || history.length < this.lookback) return;
    const recent = history.slice(-this.lookback);
    const startP = typeof recent[0] === 'number' ? recent[0] : recent[0].price;
    const endP = typeof recent[recent.length - 1] === 'number' ? recent[recent.length - 1] : recent[recent.length - 1].price;
    const diff = endP - startP;

    if (Math.abs(diff) >= 0.15) {
      const side = diff > 0 ? 'BUY' : 'SELL';
      const qty = Math.floor(Math.random() * 12) + 4;
      this.orderBook.processOrder({ playerId: this.id, side, price: 0, qty, type: 'MARKET' });
    }
  }
}

class MeanReversionBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.period = 10;
  }

  onTick(history) {
    if (!history || history.length < this.period) return;
    const recent = history.slice(-this.period);
    const sum = recent.reduce((acc, curr) => acc + (typeof curr === 'number' ? curr : curr.price), 0);
    const sma = sum / this.period;
    const mid = this.orderBook.getMidPrice();
    const dev = mid - sma;

    if (dev > 0.25) {
      this.orderBook.processOrder({ playerId: this.id, side: 'SELL', price: 0, qty: 10, type: 'MARKET' });
    } else if (dev < -0.25) {
      this.orderBook.processOrder({ playerId: this.id, side: 'BUY', price: 0, qty: 10, type: 'MARKET' });
    }
  }
}

class WhaleBot {
  constructor(id, orderBook) {
    this.id = id;
    this.orderBook = orderBook;
    this.triggerThreshold = 0.02;
  }

  onTick() {
    if (Math.random() > this.triggerThreshold) return;
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const blockQty = Math.floor(Math.random() * 60) + 30;

    this.orderBook.processOrder({
      playerId: this.id,
      side,
      price: 0,
      qty: blockQty,
      type: 'MARKET'
    });
  }
}

class BotFleet {
  constructor(orderBook) {
    this.orderBook = orderBook;
    this.bots = [];
    this.initFleet();
  }

  initFleet() {
    for (let i = 0; i < 90; i++) this.bots.push(new NoiseBot(`noise_${i}`, this.orderBook));
    for (let i = 0; i < 5; i++)  this.bots.push(new TrendBot(`trend_${i}`, this.orderBook));
    for (let i = 0; i < 5; i++)  this.bots.push(new MeanReversionBot(`mr_${i}`, this.orderBook));
    for (let i = 0; i < 3; i++)  this.bots.push(new MarketMakerBot(`mm_${i}`, this.orderBook));
    for (let i = 0; i < 3; i++)  this.bots.push(new WhaleBot(`whale_${i}`, this.orderBook));
  }

  onTick(history) {
    for (let i = 0; i < this.bots.length; i++) {
      this.bots[i].onTick(history);
    }
  }
}

// ===================================================================
// 5. UI COMPONENTS
// ===================================================================
class BookUI {
  constructor(eventBus) {
    this.asksContainer = document.getElementById('asks-container');
    this.bidsContainer = document.getElementById('bids-container');
    this.midDisplay = document.getElementById('mid-price-display');
    this.spreadDisplay = document.getElementById('spread-display');

    if (eventBus) {
      eventBus.on('TICK', (data) => this.render(data.bids, data.asks, data.midPrice));
    }
  }

  render(bids = [], asks = [], midPrice = 100.00) {
    if (this.midDisplay) this.midDisplay.innerText = '$' + midPrice.toFixed(2);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const spread = (bestAsk && bestBid) ? (bestAsk - bestBid).toFixed(2) : '0.00';
    if (this.spreadDisplay) this.spreadDisplay.innerText = '$' + spread;

    if (this.asksContainer) {
      const topAsks = [...asks].sort((a, b) => b.price - a.price).slice(-7);
      this.asksContainer.innerHTML = topAsks.map((a) => `
        <div class="grid grid-cols-3 text-red-400 hover:bg-red-500/10 px-1 py-0.5 rounded transition-colors font-mono text-xs">
          <span>$${a.price.toFixed(2)}</span>
          <span class="text-right font-bold">${a.qty}</span>
          <span class="text-right text-slate-500">${(a.price * a.qty).toFixed(0)}</span>
        </div>
      `).join('');
    }

    if (this.bidsContainer) {
      const topBids = [...bids].sort((a, b) => b.price - a.price).slice(0, 7);
      this.bidsContainer.innerHTML = topBids.map((b) => `
        <div class="grid grid-cols-3 text-emerald-400 hover:bg-emerald-500/10 px-1 py-0.5 rounded transition-colors font-mono text-xs">
          <span>$${b.price.toFixed(2)}</span>
          <span class="text-right font-bold">${b.qty}</span>
          <span class="text-right text-slate-500">${(b.price * b.qty).toFixed(0)}</span>
        </div>
      `).join('');
    }
  }
}

class ChartUI {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.canvas = document.getElementById('priceChartCanvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.clockDisplay = document.getElementById('sim-clock');

    this.timeframeSteps = { '1M': 4, '5M': 20, '10M': 40, '1H': 240, 'ALL': null };
    this.activeTimeframe = '5M';
    this.history = [];

    this.initListeners();
  }

  initListeners() {
    const buttons = document.querySelectorAll('.tf-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tf = e.target.getAttribute('data-tf');
        if (tf && tf in this.timeframeSteps) {
          this.activeTimeframe = tf;
          buttons.forEach((b) => b.className = 'tf-btn px-2 py-0.5 rounded text-slate-400 hover:text-white transition-colors cursor-pointer');
          e.target.className = 'tf-btn px-2 py-0.5 rounded bg-blue-600 text-white font-bold transition-colors cursor-pointer';
          this.draw();
        }
      });
    });

    if (this.eventBus) {
      this.eventBus.on('TICK', (data) => {
        if (data && data.priceHistory) {
          this.history = data.priceHistory;
          if (data.simTimeStr && this.clockDisplay) {
            this.clockDisplay.innerText = data.simTimeStr;
          }
          this.draw();
        }
      });
    }

    window.addEventListener('resize', () => this.draw());
  }

  draw() {
    if (!this.canvas || !this.ctx || this.history.length === 0) return;

    const width = (this.canvas.width = this.canvas.parentElement.clientWidth || 400);
    const height = (this.canvas.height = this.canvas.parentElement.clientHeight || 200);

    this.ctx.clearRect(0, 0, width, height);

    const isAll = this.activeTimeframe === 'ALL';
    const visibleData = isAll ? this.history : this.history.slice(-this.timeframeSteps[this.activeTimeframe]);
    if (visibleData.length < 2) return;

    const prices = visibleData.map((d) => (typeof d === 'number' ? d : d.price));
    let min = Math.min(...prices);
    let max = Math.max(...prices);

    if (min === max) {
      min -= 0.50;
      max += 0.50;
    } else {
      const pad = (max - min) * 0.1;
      min -= pad;
      max += pad;
    }
    const range = max - min;

    this.ctx.strokeStyle = '#1e293b';
    this.ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (height / 4) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }

    this.ctx.beginPath();
    this.ctx.strokeStyle = '#3b82f6';
    this.ctx.lineWidth = 2;

    const maxSteps = isAll ? visibleData.length : this.timeframeSteps[this.activeTimeframe];
    const stepWidth = width / (maxSteps - 1);
    const startOffsetIndex = maxSteps - visibleData.length;

    visibleData.forEach((item, index) => {
      const p = typeof item === 'number' ? item : item.price;
      const x = (startOffsetIndex + index) * stepWidth;
      const y = height - ((p - min) / range) * height;

      if (index === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });

    this.ctx.stroke();

    this.ctx.fillStyle = '#64748b';
    this.ctx.font = '10px monospace';
    this.ctx.fillText(`$${max.toFixed(2)}`, 8, 14);
    this.ctx.fillText(`$${min.toFixed(2)}`, 8, height - 6);
  }
}

class ControlsUI {
  constructor(eventBus, accountManager) {
    this.eventBus = eventBus;
    this.accountManager = accountManager;
    this.orderType = 'LIMIT';
    this.lastMidPrice = 100.00;

    this.typeLimitBtn = document.getElementById('type-limit-btn');
    this.typeMarketBtn = document.getElementById('type-market-btn');
    this.priceContainer = document.getElementById('price-input-container');
    this.priceInput = document.getElementById('order-price');
    this.qtyInput = document.getElementById('order-qty');
    this.btnBuy = document.getElementById('btn-buy');
    this.btnSell = document.getElementById('btn-sell');

    this.portCash = document.getElementById('port-cash');
    this.portShares = document.getElementById('port-shares');
    this.portAvgPrice = document.getElementById('port-avg-price');
    this.portPosVal = document.getElementById('port-pos-val');
    this.portUnrealized = document.getElementById('port-unrealized');
    this.portRealized = document.getElementById('port-realized');

    this.initListeners();
  }

  initListeners() {
    if (this.typeLimitBtn) this.typeLimitBtn.addEventListener('click', () => this.setOrderType('LIMIT'));
    if (this.typeMarketBtn) this.typeMarketBtn.addEventListener('click', () => this.setOrderType('MARKET'));
    if (this.btnBuy) this.btnBuy.addEventListener('click', () => this.submitOrder('BUY'));
    if (this.btnSell) this.btnSell.addEventListener('click', () => this.submitOrder('SELL'));

    if (this.eventBus) {
      this.eventBus.on('ACCOUNT_UPDATE', (acc) => this.renderAccount(acc));
      this.eventBus.on('TICK', (data) => {
        this.lastMidPrice = data.midPrice;
        this.updateUnrealizedPnL(data.midPrice);
      });
    }
  }

  setOrderType(type) {
    this.orderType = type;
    if (type === 'MARKET') {
      if (this.typeMarketBtn) this.typeMarketBtn.className = 'py-1 text-center rounded bg-blue-600 text-white font-bold transition-colors cursor-pointer';
      if (this.typeLimitBtn) this.typeLimitBtn.className = 'py-1 text-center rounded text-slate-400 hover:text-white transition-colors cursor-pointer';
      if (this.priceContainer) this.priceContainer.classList.add('opacity-30', 'pointer-events-none');
    } else {
      if (this.typeLimitBtn) this.typeLimitBtn.className = 'py-1 text-center rounded bg-blue-600 text-white font-bold transition-colors cursor-pointer';
      if (this.typeMarketBtn) this.typeMarketBtn.className = 'py-1 text-center rounded text-slate-400 hover:text-white transition-colors cursor-pointer';
      if (this.priceContainer) this.priceContainer.classList.remove('opacity-30', 'pointer-events-none');
    }
  }

  submitOrder(side) {
    const qty = parseFloat(this.qtyInput ? this.qtyInput.value : 10) || 10;
    const price = parseFloat(this.priceInput ? this.priceInput.value : 100) || 100;

    if (this.accountManager) {
      const check = this.accountManager.canPlaceOrder(side, this.orderType, price, qty, this.lastMidPrice);
      if (!check.allowed) {
        alert(`Order Rejected: ${check.reason}`);
        return;
      }
    }

    if (this.eventBus) {
      this.eventBus.emit('USER_SUBMIT_ORDER', {
        side,
        type: this.orderType,
        price: this.orderType === 'MARKET' ? 0 : price,
        qty
      });
    }
  }

  renderAccount(acc) {
    if (!acc) return;
    if (this.portCash) this.portCash.innerText = `$${acc.cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    if (this.portShares) {
      this.portShares.innerText = acc.shares;
      this.portShares.className = `font-bold ${acc.shares < 0 ? 'text-red-400' : acc.shares > 0 ? 'text-emerald-400' : 'text-slate-300'}`;
    }

    if (this.portAvgPrice) this.portAvgPrice.innerText = `$${acc.avgEntry.toFixed(2)}`;
    if (this.portRealized) {
      const rPnL = acc.realizedPnL || 0;
      this.portRealized.innerText = `${rPnL >= 0 ? '+' : ''}$${rPnL.toFixed(2)}`;
      this.portRealized.className = `font-bold ${rPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
    }
  }

  updateUnrealizedPnL(midPrice) {
    if (!this.accountManager || !midPrice) return;
    const acc = this.accountManager;

    let posVal = 0;
    let unrealized = 0;

    if (acc.shares > 0) {
      posVal = acc.shares * midPrice;
      unrealized = acc.shares * (midPrice - acc.avgEntry);
    } else if (acc.shares < 0) {
      posVal = -Math.abs(acc.shares) * midPrice;
      unrealized = Math.abs(acc.shares) * (acc.avgEntry - midPrice);
    }

    if (this.portPosVal) this.portPosVal.innerText = `$${posVal.toFixed(2)}`;
    if (this.portUnrealized) {
      this.portUnrealized.innerText = `${unrealized >= 0 ? '+' : ''}$${unrealized.toFixed(2)}`;
      this.portUnrealized.className = `font-bold ${unrealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
    }
  }
}

// ===================================================================
// 6. TIME-SCALED GAME LOOP ENGINE
// ===================================================================
class GameLoop {
  constructor(orderBook, eventBus = null, gameDurationMinutes = 10) {
    this.orderBook = orderBook;
    this.eventBus = eventBus;
    this.botFleet = new BotFleet(this.orderBook);

    this.simSecsPerTick = 15;
    this.totalSimSecs = 9 * 3600;
    this.totalTicks = this.totalSimSecs / this.simSecsPerTick;

    const realMsTotal = gameDurationMinutes * 60 * 1000;
    this.tickIntervalMs = Math.floor(realMsTotal / this.totalTicks);

    this.simulatedSeconds = 9 * 3600 + 30 * 60; // 09:30:00 AM
    this.priceHistory = [];
    this.intervalId = null;
  }

  getSimTimeFormatted() {
    const hours = Math.floor(this.simulatedSeconds / 3600);
    const mins = Math.floor((this.simulatedSeconds % 3600) / 60);
    const secs = this.simulatedSeconds % 60;

    const hStr = String(hours > 12 ? hours - 12 : hours).padStart(2, '0');
    const mStr = String(mins).padStart(2, '0');
    const sStr = String(secs).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';

    return `${hStr}:${mStr}:${sStr} ${ampm}`;
  }

  start() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => this.tick(), this.tickIntervalMs);
    this.tick();
  }

  tick() {
    this.simulatedSeconds += this.simSecsPerTick;
    this.botFleet.onTick(this.priceHistory);

    const currentMid = this.orderBook.getMidPrice();
    const timeStr = this.getSimTimeFormatted();

    this.priceHistory.push({
      price: currentMid,
      simTimeStr: timeStr,
      simSecs: this.simulatedSeconds
    });

    if (this.priceHistory.length > this.totalTicks) {
      this.priceHistory.shift();
    }

    if (this.eventBus) {
      this.eventBus.emit('TICK', {
        midPrice: currentMid,
        simTimeStr: timeStr,
        priceHistory: this.priceHistory,
        bids: this.orderBook.bids,
        asks: this.orderBook.asks
      });
    }
  }
}

// ===================================================================
// 7. APPLICATION INITIALIZATION & P2P ROUTING
// ===================================================================
function initApp() {
  const eventBus = new EventBus();
  const peerNetwork = new PeerNetwork(eventBus);
  const accountManager = new AccountManager(eventBus, 'Trader_1');
  const orderBook = new OrderBook(eventBus);

  const gameLoop = new GameLoop(orderBook, eventBus, 10);
  const bookUI = new BookUI(eventBus);
  const chartUI = new ChartUI(eventBus);
  const controlsUI = new ControlsUI(eventBus, accountManager);

  let currentUserId = 'Trader_1';
  let isMultiplayerHost = false;

  // Handle Order Submissions (Host processes locally / Client routes to Host)
  eventBus.on('USER_SUBMIT_ORDER', (order) => {
    const fullOrder = {
      playerId: currentUserId,
      side: order.side,
      price: order.price,
      qty: order.qty,
      type: order.type
    };

    if (peerNetwork.isHost || !peerNetwork.hostConn) {
      orderBook.processOrder(fullOrder);
    } else {
      peerNetwork.broadcast({ type: 'SUBMIT_ORDER', order: fullOrder });
    }
  });

  // Host broadcasts ticks and trade events to connected clients
  eventBus.on('TICK', (data) => {
    if (peerNetwork.isHost) {
      peerNetwork.broadcast({ type: 'SYNC_TICK', payload: data });
    }
  });

  eventBus.on('TRADE', (trade) => {
    if (peerNetwork.isHost) {
      peerNetwork.broadcast({ type: 'SYNC_TRADE', payload: trade });
    }
  });

  // Receive P2P Network Data
  eventBus.on('NET_DATA_RECEIVED', ({ data }) => {
    if (!data) return;

    if (peerNetwork.isHost && data.type === 'SUBMIT_ORDER') {
      orderBook.processOrder(data.order);
    } else if (!peerNetwork.isHost) {
      if (data.type === 'SYNC_TICK') {
        eventBus.emit('TICK', data.payload);
      } else if (data.type === 'SYNC_TRADE') {
        eventBus.emit('TRADE', data.payload);
      }
    }
  });

  function seedInitialLiquidity() {
    orderBook.processOrder({ playerId: 'mm_0', side: 'BUY', price: 99.80, qty: 50, type: 'LIMIT' });
    orderBook.processOrder({ playerId: 'mm_0', side: 'BUY', price: 99.50, qty: 100, type: 'LIMIT' });
    orderBook.processOrder({ playerId: 'mm_0', side: 'SELL', price: 100.20, qty: 50, type: 'LIMIT' });
    orderBook.processOrder({ playerId: 'mm_0', side: 'SELL', price: 100.50, qty: 100, type: 'LIMIT' });
  }

  const lobbyScreen = document.getElementById('lobby-screen');
  const tradingScreen = document.getElementById('trading-screen');
  const btnSinglePlayer = document.getElementById('btn-single-player');
  const btnHostMultiplayer = document.getElementById('btn-host-multiplayer');
  const btnJoinMultiplayer = document.getElementById('btn-join-multiplayer');
  const roomCodeInput = document.getElementById('room-code-input');
  const roomBadge = document.getElementById('room-badge');
  const roomCodeDisplay = document.getElementById('room-code-display');

  function getTraderName() {
    const input = document.getElementById('trader-name-input');
    return (input && input.value.trim()) ? input.value.trim() : 'Trader_1';
  }

  function startUI() {
    if (lobbyScreen) lobbyScreen.classList.add('hidden');
    if (tradingScreen) tradingScreen.classList.remove('hidden');
  }

  function updateRoomBadge(code) {
    if (roomBadge && roomCodeDisplay) {
      roomCodeDisplay.innerText = code;
      roomBadge.classList.remove('hidden');
    }
  }

  // Single Player Mode
  if (btnSinglePlayer) {
    btnSinglePlayer.addEventListener('click', () => {
      currentUserId = getTraderName();
      accountManager.setPlayerId(currentUserId);
      seedInitialLiquidity();
      accountManager.broadcastState();
      gameLoop.start();
      startUI();
    });
  }

  // Host Multiplayer Mode
  if (btnHostMultiplayer) {
    btnHostMultiplayer.addEventListener('click', () => {
      currentUserId = getTraderName();
      accountManager.setPlayerId(currentUserId);

      const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
      peerNetwork.initHost(roomCode);

      updateRoomBadge(roomCode);
      seedInitialLiquidity();
      accountManager.broadcastState();
      gameLoop.start();
      startUI();
    });
  }

  // Join Multiplayer Mode
  if (btnJoinMultiplayer) {
    btnJoinMultiplayer.addEventListener('click', () => {
      const code = roomCodeInput ? roomCodeInput.value.trim() : '';
      if (!code) {
        alert('Please enter a valid Room Code.');
        return;
      }

      currentUserId = getTraderName();
      accountManager.setPlayerId(currentUserId);

      peerNetwork.initClient(code, currentUserId);
      updateRoomBadge(code);
      accountManager.broadcastState();
      startUI();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

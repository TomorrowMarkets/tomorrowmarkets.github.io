export class ControlsUI {
  constructor(eventBus, accountManager) {
    this.eventBus = eventBus;
    this.accountManager = accountManager;
    this.orderType = 'LIMIT';

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
    if (this.typeLimitBtn) {
      this.typeLimitBtn.addEventListener('click', () => this.setOrderType('LIMIT'));
    }
    if (this.typeMarketBtn) {
      this.typeMarketBtn.addEventListener('click', () => this.setOrderType('MARKET'));
    }
    if (this.btnBuy) {
      this.btnBuy.addEventListener('click', () => this.submitOrder('BUY'));
    }
    if (this.btnSell) {
      this.btnSell.addEventListener('click', () => this.submitOrder('SELL'));
    }

    if (this.eventBus) {
      this.eventBus.on('ACCOUNT_UPDATE', (acc) => this.renderAccount(acc));
      this.eventBus.on('TICK', (data) => this.updateUnrealizedPnL(data.midPrice));
    }
  }

  setOrderType(type) {
    this.orderType = type;
    if (type === 'MARKET') {
      this.typeMarketBtn.className = 'py-1 text-center rounded bg-blue-600 text-white font-bold transition-colors cursor-pointer';
      this.typeLimitBtn.className = 'py-1 text-center rounded text-slate-400 hover:text-white transition-colors cursor-pointer';
      if (this.priceContainer) this.priceContainer.classList.add('opacity-30', 'pointer-events-none');
    } else {
      this.typeLimitBtn.className = 'py-1 text-center rounded bg-blue-600 text-white font-bold transition-colors cursor-pointer';
      this.typeMarketBtn.className = 'py-1 text-center rounded text-slate-400 hover:text-white transition-colors cursor-pointer';
      if (this.priceContainer) this.priceContainer.classList.remove('opacity-30', 'pointer-events-none');
    }
  }

  submitOrder(side) {
    const qty = parseFloat(this.qtyInput ? this.qtyInput.value : 10) || 10;
    const price = parseFloat(this.priceInput ? this.priceInput.value : 100) || 100;

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
    if (this.portShares) this.portShares.innerText = acc.shares;
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
    const posVal = acc.shares * midPrice;
    const unrealized = acc.shares > 0 ? acc.shares * (midPrice - acc.avgEntry) : 0;

    if (this.portPosVal) this.portPosVal.innerText = `$${posVal.toFixed(2)}`;
    if (this.portUnrealized) {
      this.portUnrealized.innerText = `${unrealized >= 0 ? '+' : ''}$${unrealized.toFixed(2)}`;
      this.portUnrealized.className = `font-bold ${unrealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
    }
  }
}

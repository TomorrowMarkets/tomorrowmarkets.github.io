
// src/ui/ControlsUI.js
export class ControlsUI {
  constructor(eventBus, accountManager) {
    this.eventBus = eventBus;
    this.accountManager = accountManager;
    this.orderType = 'LIMIT';

    this.bindEvents();

    if (this.eventBus) {
      this.eventBus.on('PORTFOLIO_UPDATED', (metrics) => this.renderPortfolio(metrics));
    }
  }

  bindEvents() {
    window.setOrderType = (type) => {
      this.orderType = type;
      const limitBtn = document.getElementById('type-limit-btn');
      const marketBtn = document.getElementById('type-market-btn');
      const priceContainer = document.getElementById('price-input-container');

      if (type === 'LIMIT') {
        limitBtn.className = "py-1 text-center rounded bg-blue-600 text-white font-bold transition-colors";
        marketBtn.className = "py-1 text-center rounded text-slate-400 hover:text-white transition-colors";
        priceContainer.style.display = 'block';
      } else {
        marketBtn.className = "py-1 text-center rounded bg-blue-600 text-white font-bold transition-colors";
        limitBtn.className = "py-1 text-center rounded text-slate-400 hover:text-white transition-colors";
        priceContainer.style.display = 'none';
      }
    };

    window.submitOrder = (side) => {
      const qty = parseInt(document.getElementById('order-qty').value);
      const price = parseFloat(document.getElementById('order-price').value);

      if (this.eventBus) {
        this.eventBus.emit('USER_SUBMIT_ORDER', {
          side,
          qty,
          price,
          type: this.orderType
        });
      }
    };
  }

  renderPortfolio(m) {
    if (!m) return;
    document.getElementById('port-cash').innerText = '$' + m.cash.toLocaleString('en-US', { minimumFractionDigits: 2 });
    document.getElementById('port-shares').innerText = m.shares;
    document.getElementById('port-avg-price').innerText = '$' + m.avgEntry.toFixed(2);
    document.getElementById('port-pos-val').innerText = '$' + m.posValue.toLocaleString('en-US', { minimumFractionDigits: 2 });

    const unrl = document.getElementById('port-unrealized');
    unrl.innerText = (m.unrealizedPnL >= 0 ? '+' : '') + '$' + m.unrealizedPnL.toFixed(2);
    unrl.className = `font-bold font-mono-num ${m.unrealizedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`;

    const rlz = document.getElementById('port-realized');
    rlz.innerText = (m.realizedPnL >= 0 ? '+' : '') + '$' + m.realizedPnL.toFixed(2);
    rlz.className = `font-bold font-mono-num ${m.realizedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
  }
}

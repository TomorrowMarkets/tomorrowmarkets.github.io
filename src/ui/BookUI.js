// src/ui/BookUI.js
export class BookUI {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.asksContainer = document.getElementById('asks-container');
    this.bidsContainer = document.getElementById('bids-container');
    this.midDisplay = document.getElementById('mid-price-display');
    this.spreadDisplay = document.getElementById('spread-display');

    if (this.eventBus) {
      this.eventBus.on('TICK', (data) => this.render(data.bids, data.asks, data.midPrice));
    }
  }

  render(bids = [], asks = [], midPrice = 100.00) {
    if (this.midDisplay) this.midDisplay.innerText = '$' + midPrice.toFixed(2);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const spread = (bestAsk && bestBid) ? (bestAsk - bestBid).toFixed(2) : '0.00';
    if (this.spreadDisplay) this.spreadDisplay.innerText = '$' + spread;

    if (this.asksContainer) {
      const topAsks = [...asks].sort((a, b) => b.price - a.price).slice(-6);
      this.asksContainer.innerHTML = topAsks.map(a => `
        <div class="grid grid-cols-3 text-red-400 hover:bg-red-500/10 px-1 py-0.5 rounded transition-colors font-mono text-xs">
          <span>$${a.price.toFixed(2)}</span>
          <span class="text-right font-bold">${a.qty}</span>
          <span class="text-right text-slate-500">${(a.price * a.qty).toFixed(0)}</span>
        </div>
      `).join('');
    }

    if (this.bidsContainer) {
      const topBids = [...bids].sort((a, b) => b.price - a.price).slice(0, 6);
      this.bidsContainer.innerHTML = topBids.map(b => `
        <div class="grid grid-cols-3 text-emerald-400 hover:bg-emerald-500/10 px-1 py-0.5 rounded transition-colors font-mono text-xs">
          <span>$${b.price.toFixed(2)}</span>
          <span class="text-right font-bold">${b.qty}</span>
          <span class="text-right text-slate-500">${(b.price * b.qty).toFixed(0)}</span>
        </div>
      `).join('');
    }
  }
}

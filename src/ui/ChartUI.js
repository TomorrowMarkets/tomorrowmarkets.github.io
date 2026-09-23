// src/ui/ChartUI.js
export class ChartUI {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.canvas = document.getElementById('priceChartCanvas');

    if (this.eventBus) {
      this.eventBus.on('TICK', (data) => this.render(data.priceHistory));
    }
    window.addEventListener('resize', () => this.lastHistory && this.render(this.lastHistory));
  }

  render(priceHistory = []) {
    this.lastHistory = priceHistory;
    if (!this.canvas || priceHistory.length < 2) return;

    const ctx = this.canvas.getContext('2d');
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * (window.devicePixelRatio || 1);
    this.canvas.height = rect.height * (window.devicePixelRatio || 1);
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);

    const minPrice = Math.min(...priceHistory) - 0.20;
    const maxPrice = Math.max(...priceHistory) + 0.20;
    const range = (maxPrice - minPrice) || 1;

    // Draw Price Line
    ctx.beginPath();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;

    priceHistory.forEach((price, idx) => {
      const x = (idx / (priceHistory.length - 1)) * width;
      const y = height - ((price - minPrice) / range) * (height - 20) - 10;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill Gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.2)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.fillStyle = gradient;
    ctx.fill();
  }
}

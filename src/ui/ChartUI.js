export class ChartUI {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.canvas = document.getElementById('priceChartCanvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.history = [];

    if (this.eventBus) {
      this.eventBus.on('TICK', (data) => {
        if (data && data.priceHistory) {
          this.history = data.priceHistory;
          this.draw();
        }
      });
    }

    window.addEventListener('resize', () => this.draw());
  }

  draw() {
    if (!this.canvas || !this.ctx || this.history.length < 2) return;

    const width = (this.canvas.width = this.canvas.parentElement.clientWidth);
    const height = (this.canvas.height = this.canvas.parentElement.clientHeight);

    this.ctx.clearRect(0, 0, width, height);

    const min = Math.min(...this.history) * 0.998;
    const max = Math.max(...this.history) * 1.002;
    const range = max - min || 1;

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

    const step = width / (this.history.length - 1);

    this.history.forEach((price, index) => {
      const x = index * step;
      const y = height - ((price - min) / range) * height;
      if (index === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });

    this.ctx.stroke();
  }
}

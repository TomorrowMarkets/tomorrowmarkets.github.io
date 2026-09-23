export class ChartUI {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.canvas = document.getElementById('priceChartCanvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.clockDisplay = document.getElementById('sim-clock');

    // Timeframes mapped to number of 15-second timesteps
    this.timeframeSteps = {
      '1M': 4,      // 60s / 15s
      '5M': 20,     // 300s / 15s
      '10M': 40,    // 600s / 15s
      '1H': 240     // 3600s / 15s
    };
    this.activeTimeframe = '5M';
    this.history = []; // Holds objects: { price, simTimeStr }

    this.initListeners();
  }

  initListeners() {
    // Timeframe selector button events
    const buttons = document.querySelectorAll('.tf-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tf = e.target.getAttribute('data-tf');
        if (tf && this.timeframeSteps[tf]) {
          this.activeTimeframe = tf;
          this.updateButtonStyles(buttons, e.target);
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

  updateButtonStyles(allButtons, activeBtn) {
    allButtons.forEach((btn) => {
      btn.className = 'tf-btn px-2 py-0.5 rounded text-slate-400 hover:text-white transition-colors cursor-pointer';
    });
    activeBtn.className = 'tf-btn px-2 py-0.5 rounded bg-blue-600 text-white font-bold transition-colors cursor-pointer';
  }

  draw() {
    if (!this.canvas || !this.ctx || this.history.length === 0) return;

    const width = (this.canvas.width = this.canvas.parentElement.clientWidth);
    const height = (this.canvas.height = this.canvas.parentElement.clientHeight);

    this.ctx.clearRect(0, 0, width, height);

    // Filter slice by current timeframe steps
    const maxSteps = this.timeframeSteps[this.activeTimeframe];
    const visibleData = this.history.slice(-maxSteps);
    if (visibleData.length < 2) return;

    const prices = visibleData.map((d) => (typeof d === 'number' ? d : d.price));
    let min = Math.min(...prices);
    let max = Math.max(...prices);

    // Padding for visual clarity
    if (min === max) {
      min -= 1;
      max += 1;
    } else {
      const pad = (max - min) * 0.08;
      min -= pad;
      max += pad;
    }
    const range = max - min;

    // Grid lines (horizontal)
    this.ctx.strokeStyle = '#1e293b';
    this.ctx.lineWidth = 1;
    const gridRows = 4;
    for (let i = 1; i < gridRows; i++) {
      const y = (height / gridRows) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }

    // Grid lines (vertical time ticks)
    const gridCols = 5;
    for (let i = 1; i < gridCols; i++) {
      const x = (width / gridCols) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();
    }

    // Draw Price Line
    this.ctx.beginPath();
    this.ctx.strokeStyle = '#3b82f6';
    this.ctx.lineWidth = 2;

    const stepWidth = width / (maxSteps - 1);
    const startOffsetIndex = maxSteps - visibleData.length; // Align right when filling initial history

    visibleData.forEach((item, index) => {
      const p = typeof item === 'number' ? item : item.price;
      const x = (startOffsetIndex + index) * stepWidth;
      const y = height - ((p - min) / range) * height;

      if (index === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });

    this.ctx.stroke();

    // Render Price Axis Overlay Labels
    this.ctx.fillStyle = '#64748b';
    this.ctx.font = '10px monospace';
    this.ctx.fillText(`$${max.toFixed(2)}`, 8, 14);
    this.ctx.fillText(`$${min.toFixed(2)}`, 8, height - 6);
  }
}

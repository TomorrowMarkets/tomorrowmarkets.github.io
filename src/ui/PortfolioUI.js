import { validateWeights } from '../engine/PortfolioChallenge.js';

const money = (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
const text = (root, id, value) => { root.getElementById(id).textContent = value; };

export class PortfolioUI {
  constructor({ onSubmit, onExit, root = document }) {
    this.root = root;
    this.onSubmit = onSubmit;
    this.screen = root.getElementById('portfolio-screen');
    this.inputs = [];
    this.snapshot = null;
    this.round = null;
    this.offset = 0;
    this.timer = null;
    root.getElementById('pm-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!this.snapshot || this.snapshot.finished) return;
      try {
        const weights = validateWeights(this.readWeights());
        this.onSubmit(weights, this.snapshot.round);
      } catch (err) { this.message(err.message, true); }
    });
    root.getElementById('pm-equal').addEventListener('click', () => {
      // Exactly 100%, to the nearest 0.01 percentage point.
      this.inputs.forEach((input, i) => { input.value = i < 10 ? '3.34' : '3.33'; });
      this.changed();
    });
    root.getElementById('pm-cash').addEventListener('click', () => {
      this.inputs.forEach((input) => { input.value = '0'; });
      this.changed();
    });
    root.getElementById('pm-exit').addEventListener('click', () => onExit());
    const chart = root.getElementById('pm-chart');
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.draw()).observe(chart);
  }

  readWeights() { return this.inputs.map((input) => input.value.trim() === '' ? 0 : Number(input.value) / 100); }

  message(message, error = false) {
    const status = this.root.getElementById('pm-status');
    status.textContent = message;
    status.classList.toggle('neg', error);
  }

  changed() {
    this.updateTotal();
    this.message('Unsaved changes. Save allocations to apply them at this round’s deadline.');
  }

  updateTotal() {
    const weights = this.readWeights();
    const sum = weights.reduce((a, b) => a + b, 0) * 100;
    let valid = true;
    try { validateWeights(weights); } catch { valid = false; }
    text(this.root, 'pm-total', Number.isFinite(sum) ? `${sum.toFixed(2)}% invested · ${Math.max(0, 100 - sum).toFixed(2)}% cash` : 'Invalid allocation');
    this.root.getElementById('pm-total').classList.toggle('neg', !valid);
    this.root.getElementById('pm-save').disabled = !valid || !this.snapshot || this.snapshot.finished;
  }

  buildRows(assets) {
    const body = this.root.getElementById('pm-assets');
    body.replaceChildren();
    this.inputs = assets.map((asset, i) => {
      const row = this.root.createElement('tr');
      const nameCell = this.root.createElement('th');
      nameCell.scope = 'row';
      const ticker = this.root.createElement('strong');
      ticker.textContent = asset.symbol;
      const name = this.root.createElement('span');
      name.className = 'pm-asset-name';
      name.textContent = asset.name;
      nameCell.append(ticker, name);
      row.append(nameCell);
      for (const type of ['price', 'period', 'year']) {
        const cell = this.root.createElement('td');
        cell.dataset.pmValue = type;
        cell.className = 'num';
        row.append(cell);
      }
      const inputCell = this.root.createElement('td');
      const input = this.root.createElement('input');
      Object.assign(input, { type: 'number', min: '0', max: '100', step: 'any', value: '0', className: 'field num pm-weight', id: `pm-weight-${i}` });
      input.setAttribute('aria-label', `${asset.symbol} allocation percent`);
      input.addEventListener('input', () => this.changed());
      inputCell.append(input);
      row.append(inputCell);
      body.append(row);
      return input;
    });
  }

  show(snapshot) {
    const nextRound = this.round !== snapshot.round;
    this.snapshot = snapshot;
    this.offset = snapshot.serverNow - Date.now();
    this.screen.classList.remove('hidden');
    if (this.inputs.length !== snapshot.assets.length) this.buildRows(snapshot.assets);
    if (nextRound) {
      const weights = snapshot.account.pending || snapshot.account.weights;
      this.inputs.forEach((input, i) => { input.value = String(Number((weights[i] * 100).toFixed(8))); });
      this.message(snapshot.finished
        ? 'Challenge complete. Your final allocation was valued at the last adjusted close.'
        : 'Saved target percentages carry into each new round. Unallocated capital stays in cash.');
    }
    this.round = snapshot.round;
    const returns = (snapshot.account.capital / 10000 - 1) * 100;
    text(this.root, 'pm-title', snapshot.finished ? 'Portfolio challenge complete' : 'Portfolio management');
    text(this.root, 'pm-source', `${snapshot.source}${snapshot.demo ? ' · DEMO — synthetic prices' : ''}`);
    text(this.root, 'pm-window', `${snapshot.startDate} → ${snapshot.endDate} · 30 assets · ${snapshot.totalRounds} rounds`);
    text(this.root, 'pm-date', snapshot.date);
    text(this.root, 'pm-round', snapshot.finished ? `${snapshot.totalRounds} / ${snapshot.totalRounds}` : `${snapshot.round + 1} / ${snapshot.totalRounds}`);
    text(this.root, 'pm-next-date', snapshot.finished ? 'Final valuation' : `Allocate for ${snapshot.date} → ${snapshot.nextDate}`);
    text(this.root, 'pm-capital', money(snapshot.account.capital));
    text(this.root, 'pm-return', percent(returns));
    text(this.root, 'pm-benchmark', percent(snapshot.benchmark));
    text(this.root, 'pm-drawdown', `${snapshot.account.maxDrawdown.toFixed(2)}%`);
    this.root.getElementById('pm-return').className = `num ${returns >= 0 ? 'pos' : 'neg'}`;
    this.root.getElementById('pm-progress').style.width = `${snapshot.round / snapshot.totalRounds * 100}%`;
    const rows = this.root.getElementById('pm-assets').children;
    snapshot.assets.forEach((asset, i) => {
      const row = rows[i];
      row.querySelector('[data-pm-value="price"]').textContent = money(asset.price);
      for (const [key, value] of [['period', asset.periodReturn], ['year', asset.totalReturn]]) {
        const cell = row.querySelector(`[data-pm-value="${key}"]`);
        cell.textContent = percent(value);
        cell.className = `num ${value >= 0 ? 'pos' : 'neg'}`;
      }
    });
    const standings = this.root.getElementById('pm-standings');
    standings.replaceChildren(...snapshot.standings.map((player, i) => {
      const row = this.root.createElement('div');
      row.className = 'row-card pm-standing';
      const name = this.root.createElement('span');
      name.textContent = `${i + 1}. ${player.id}`;
      const value = this.root.createElement('strong');
      value.className = `num ${player.returnPct >= 0 ? 'pos' : 'neg'}`;
      value.textContent = percent(player.returnPct);
      row.append(name, value);
      return row;
    }));
    this.root.getElementById('pm-fields').disabled = snapshot.finished;
    this.updateTotal();
    this.draw();
    if (!this.timer && !snapshot.finished) this.timer = setInterval(() => this.countdown(), 100);
    if (snapshot.finished) this.stop();
    this.countdown();
  }

  acknowledge(round) {
    if (this.snapshot && round === this.snapshot.round) this.message('Allocation saved for this round. It will carry forward until you save a change.');
  }

  countdown() {
    if (!this.snapshot) return;
    const remaining = Math.max(0, this.snapshot.deadline - Date.now() - this.offset);
    text(this.root, 'pm-countdown', this.snapshot.finished ? 'Finished' : remaining > 0 ? `${Math.ceil(remaining / 1000)}s to save` : 'Waiting for next round…');
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  disconnect() {
    this.stop();
    this.root.getElementById('pm-fields').disabled = true;
    this.message('The host disconnected. The challenge has ended; these are the last confirmed results.', true);
    text(this.root, 'pm-countdown', 'Disconnected');
  }

  draw() {
    const history = this.snapshot?.account.history;
    const canvas = this.root.getElementById('pm-chart');
    if (!history?.length || !canvas?.clientWidth) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const low = Math.min(10000, ...history) * 0.998;
    const high = Math.max(10000, ...history) * 1.002;
    const x = (i) => 5 + i / Math.max(1, history.length - 1) * (width - 10);
    const y = (v) => height - 10 - (v - low) / (high - low) * (height - 20);
    const css = getComputedStyle(this.screen);
    ctx.strokeStyle = css.getPropertyValue('--line-strong').trim();
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y(10000)); ctx.lineTo(width, y(10000)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = css.getPropertyValue('--gold').trim();
    ctx.lineWidth = 2;
    ctx.beginPath();
    history.forEach((value, i) => { if (i) ctx.lineTo(x(i), y(value)); else ctx.moveTo(x(i), y(value)); });
    ctx.stroke();
  }
}

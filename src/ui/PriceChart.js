// src/ui/PriceChart.js
// The price chart: line or candles, volume, indicators, a crosshair with an
// OHLC readout, and your working orders and SL/TP levels.
//
// Layout (all on one canvas):
//   ┌──────────────────────────────┬───────┐
//   │ price pane (+ volume at foot)│ price │
//   ├──────────────────────────────┤ scale │
//   │ one pane per RSI / MACD      │       │
//   ├──────────────────────────────┴───────┤
//   │ time scale                           │
//   └──────────────────────────────────────┘
// Legends and the indicator editor are HTML laid over the canvas.
// Settings (chart type, timeframe, indicators) are remembered per browser.

import { resample } from '../engine/bars.js';
import { sma, ema, bollinger, rsi, macd, vwap } from '../engine/indicators.js';

const STORAGE_KEY = 'tm.chart.v1';
const AXIS_W = 62;            // right-hand price scale
const TIME_H = 20;            // bottom time scale
const VOLUME_SHARE = 0.18;    // volume bars use the bottom 18% of the price pane
const MAX_OVERLAYS = 6;
const MAX_PANES = 2;
const FONT = '10.5px Inter, system-ui, sans-serif';

const COLORS = {
  ink: '#0B1D47',
  muted: '#5A6B88',
  faint: '#8C99B0',
  grid: 'rgba(11, 29, 71, 0.06)',
  rule: 'rgba(11, 29, 71, 0.12)',
  gold: '#B08D3C',
  up: '#0F8A5F',
  down: '#C23B32',
  upVol: 'rgba(15, 138, 95, 0.30)',
  downVol: 'rgba(194, 59, 50, 0.28)'
};
const PALETTE = ['#B08D3C', '#156082', '#7B4FA0', '#C0612B', '#2E8B84', '#A23B72'];
// A second or third moving average starts at the next common length, so two
// lines are ready for a crossover straight away.
const COMMON_LENGTHS = { sma: [20, 50, 100, 200], ema: [9, 21, 50, 100] };

// Each button is a window onto the day; the bar size is picked so the
// chart shows a readable number of candles.
const TIMEFRAMES = {
  '1M': { window: 4, perBar: 1, title: 'Last minute, 15-second bars' },
  '5M': { window: 20, perBar: 1, title: 'Last 5 minutes, 15-second bars' },
  '10M': { window: 40, perBar: 1, title: 'Last 10 minutes, 15-second bars' },
  '1H': { window: 240, perBar: 2, title: 'Last hour, 30-second bars' },
  ALL: { window: null, perBar: 20, title: 'The whole day, 5-minute bars' }
};

export const INDICATORS = {
  sma: {
    name: 'Simple moving average', short: 'SMA', pane: 'price',
    hint: 'Average closing price over the last N bars.',
    params: [{ key: 'period', label: 'Length (bars)', value: 20, min: 2, max: 200, step: 1 }],
    compute: (bars, p, closes) => ({ line: sma(closes, p.period) })
  },
  ema: {
    name: 'Exponential moving average', short: 'EMA', pane: 'price',
    hint: 'Like the SMA, but recent bars count more, so it turns sooner.',
    params: [{ key: 'period', label: 'Length (bars)', value: 9, min: 2, max: 200, step: 1 }],
    compute: (bars, p, closes) => ({ line: ema(closes, p.period) })
  },
  bb: {
    name: 'Bollinger Bands', short: 'BB', pane: 'price',
    hint: 'A moving average with bands a few standard deviations either side.',
    params: [
      { key: 'period', label: 'Length (bars)', value: 20, min: 2, max: 200, step: 1 },
      { key: 'mult', label: 'Width (std devs)', value: 2, min: 0.5, max: 4, step: 0.1 }
    ],
    compute: (bars, p, closes) => bollinger(closes, p.period, p.mult)
  },
  vwap: {
    name: 'VWAP', short: 'VWAP', pane: 'price',
    hint: 'The average price paid today, weighted by how many shares traded.',
    params: [],
    compute: (bars) => ({ line: vwap(bars) })
  },
  rsi: {
    name: 'Relative strength index', short: 'RSI', pane: 'own',
    hint: 'Momentum from 0 to 100. Above 70 is often read as overbought, below 30 as oversold.',
    params: [{ key: 'period', label: 'Length (bars)', value: 14, min: 2, max: 100, step: 1 }],
    compute: (bars, p, closes) => ({ line: rsi(closes, p.period) })
  },
  macd: {
    name: 'MACD', short: 'MACD', pane: 'own',
    hint: 'The gap between a fast and a slow EMA, with a signal line to show when it turns.',
    params: [
      { key: 'fast', label: 'Fast EMA', value: 12, min: 2, max: 100, step: 1 },
      { key: 'slow', label: 'Slow EMA', value: 26, min: 3, max: 200, step: 1 },
      { key: 'signal', label: 'Signal', value: 9, min: 2, max: 50, step: 1 }
    ],
    compute: (bars, p, closes) => macd(closes, p.fast, p.slow, p.signal)
  }
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = Number.isFinite;
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function hhmm(secs, withSeconds = false) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return withSeconds ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}`;
}

function niceStep(range, maxTicks, floor = 0.01) {
  const raw = range / Math.max(1, maxTicks);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return Math.max(floor, nice * pow);
}

function fmtValue(v, digits = 2) {
  if (!isNum(v)) return '–';
  return v.toFixed(Math.abs(v) < 1 && digits === 2 ? 3 : digits);
}

function labelFor(ind) {
  const def = INDICATORS[ind.kind];
  return [def.short, ...def.params.map((p) => ind.params[p.key])].join(' ');
}

export class PriceChart {
  constructor(eventBus, getCurrentUserId, { originSecs, secsPerTick, totalTicks }) {
    this.getCurrentUserId = getCurrentUserId;
    this.originSecs = originSecs;
    this.secsPerTick = secsPerTick;
    this.totalTicks = totalTicks;

    const $ = (id) => document.getElementById(id);
    this.canvas = $('priceChartCanvas');
    this.stage = $('chart-stage') || (this.canvas && this.canvas.parentElement);
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.clockDisplay = $('sim-clock');
    this.legend = $('chart-legend');
    this.menuBtn = $('chart-ind-btn');
    this.menu = $('chart-ind-menu');

    this.settings = this.loadSettings();
    this.history = [];
    this.levels = [];
    this.bars = [];
    this.series = new Map();
    this.hover = null;
    this.view = null;
    this.raf = 0;
    this.paneLegends = new Map();
    this.editor = null;

    this.bindControls();
    this.renderMenu();
    this.renderLegend();

    eventBus.on('TICK', (data) => this.onTick(data));
    window.addEventListener('resize', () => this.requestDraw());
    document.addEventListener('visibilitychange', () => this.requestDraw());
    if (window.ResizeObserver && this.stage) new ResizeObserver(() => this.requestDraw()).observe(this.stage);
  }

  // ---- settings -----------------------------------------------------------

  loadSettings() {
    const fallback = { type: 'line', volume: true, timeframe: '5M', indicators: [] };
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return fallback;
      const indicators = [];
      for (const i of Array.isArray(raw.indicators) ? raw.indicators : []) {
        if (i && INDICATORS[i.kind]) indicators.push(this.makeIndicator(i.kind, i.params, i.color, i.uid, indicators));
      }
      return {
        type: raw.type === 'candles' ? 'candles' : 'line',
        volume: raw.volume !== false,
        timeframe: TIMEFRAMES[raw.timeframe] ? raw.timeframe : '5M',
        indicators
      };
    } catch (err) {
      return fallback;
    }
  }

  saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch (err) {
      // Private browsing or storage full: settings just won't persist.
    }
  }

  makeIndicator(kind, params = {}, color = null, uid = null, existing = this.settings.indicators) {
    const def = INDICATORS[kind];
    const clean = {};
    for (const p of def.params) {
      const v = Number(params[p.key]);
      clean[p.key] = isNum(v) ? clamp(v, p.min, p.max) : p.value;
    }
    const used = new Set(existing.map((i) => i.color));
    return {
      uid: uid || `${kind}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      params: clean,
      color: color || PALETTE.find((c) => !used.has(c)) || PALETTE[0]
    };
  }

  changed({ recompute = true } = {}) {
    this.saveSettings();
    if (recompute) this.recompute();
    this.requestDraw();
  }

  // ---- controls -------------------------------------------------------------

  bindControls() {
    document.querySelectorAll('.tf-btn').forEach((btn) => {
      const tf = btn.getAttribute('data-tf');
      if (TIMEFRAMES[tf]) btn.title = TIMEFRAMES[tf].title;
      btn.classList.toggle('is-active', tf === this.settings.timeframe);
      btn.addEventListener('click', () => {
        if (!TIMEFRAMES[tf]) return;
        this.settings.timeframe = tf;
        document.querySelectorAll('.tf-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
        this.changed();
      });
    });

    document.querySelectorAll('[data-chart-type]').forEach((btn) => {
      const type = btn.getAttribute('data-chart-type');
      btn.classList.toggle('is-active', type === this.settings.type);
      btn.setAttribute('aria-pressed', String(type === this.settings.type));
      btn.addEventListener('click', () => {
        this.settings.type = type;
        document.querySelectorAll('[data-chart-type]').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        this.changed({ recompute: false });
      });
    });

    if (this.menuBtn && this.menu) {
      this.menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMenu();
      });
      this.menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-add], [data-toggle]');
        if (!item || item.disabled) return;
        if (item.dataset.toggle === 'volume') {
          this.settings.volume = !this.settings.volume;
          this.renderMenu();
          this.changed({ recompute: false });
          return;
        }
        this.addIndicator(item.dataset.add);
        this.toggleMenu(false);
      });
    }

    if (this.legend) {
      this.legend.addEventListener('click', (e) => this.onLegendClick(e));
    }

    // Close the menu or editor on a click elsewhere. composedPath() is taken
    // at dispatch time, so it still works after the menu re-renders itself.
    document.addEventListener('click', (e) => {
      const path = e.composedPath();
      if (this.menu && !path.includes(this.menu) && !path.includes(this.menuBtn)) this.toggleMenu(false);
      if (this.editor && !path.includes(this.editor) && !e.target.closest('.cl-name')) this.closeEditor();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.editor) this.closeEditor();
      else if (this.menu && !this.menu.classList.contains('hidden')) {
        this.toggleMenu(false);
        this.menuBtn.focus();
      }
    });

    if (this.stage) {
      const move = (e) => {
        const r = this.stage.getBoundingClientRect();
        const onControls = e.target.closest && e.target.closest('.chart-editor, .cl-name, .cl-x');
        this.hover = onControls ? null : { x: e.clientX - r.left, y: e.clientY - r.top };
        this.requestDraw();
      };
      this.stage.addEventListener('pointermove', move);
      this.stage.addEventListener('pointerdown', move);
      this.stage.addEventListener('pointerleave', () => {
        this.hover = null;
        this.requestDraw();
      });
    }
  }

  toggleMenu(open) {
    if (!this.menu) return;
    const show = open ?? this.menu.classList.contains('hidden');
    this.menu.classList.toggle('hidden', !show);
    this.menuBtn.setAttribute('aria-expanded', String(show));
    if (show) {
      this.closeEditor();
      this.renderMenu();
    }
  }

  renderMenu() {
    if (!this.menu) return;
    const overlays = this.settings.indicators.filter((i) => INDICATORS[i.kind].pane === 'price').length;
    const panes = this.settings.indicators.length - overlays;
    const item = (kind) => {
      const def = INDICATORS[kind];
      const full = def.pane === 'price' ? overlays >= MAX_OVERLAYS : panes >= MAX_PANES;
      const hint = full
        ? `Remove a ${def.pane === 'price' ? 'line on the chart' : 'lower panel'} to add another.`
        : def.hint;
      return `<button type="button" role="menuitem" class="chart-menu-item" data-add="${kind}"${full ? ' disabled' : ''}>
        <span class="cm-name">${def.name}</span><span class="cm-hint">${hint}</span></button>`;
    };
    this.menu.innerHTML = `
      <div class="cm-group">On the price chart</div>
      ${['sma', 'ema', 'bb', 'vwap'].map(item).join('')}
      <div class="cm-group">In a panel below</div>
      ${['rsi', 'macd'].map(item).join('')}
      <div class="chart-menu-rule"></div>
      <button type="button" role="menuitemcheckbox" aria-checked="${this.settings.volume}" class="chart-menu-item cm-check" data-toggle="volume">
        <span class="cm-name">Volume</span><span class="cm-hint">Shares traded in each bar, along the bottom of the chart.</span>
      </button>`;
  }

  addIndicator(kind) {
    if (!INDICATORS[kind]) return;
    const params = {};
    if (COMMON_LENGTHS[kind]) {
      const used = new Set(this.settings.indicators.filter((i) => i.kind === kind).map((i) => i.params.period));
      params.period = COMMON_LENGTHS[kind].find((len) => !used.has(len)) ?? COMMON_LENGTHS[kind][0];
    }
    const ind = this.makeIndicator(kind, params);
    this.settings.indicators.push(ind);
    this.renderLegend();
    this.changed();
  }

  removeIndicator(uid) {
    this.settings.indicators = this.settings.indicators.filter((i) => i.uid !== uid);
    this.closeEditor();
    this.renderLegend();
    this.changed();
  }

  // ---- legends ----------------------------------------------------------------

  renderLegend() {
    if (!this.legend) return;
    const row = (ind) => `
      <div class="cl-row" data-uid="${ind.uid}" style="--c:${ind.color}">
        <button type="button" class="cl-name" title="Change settings">${labelFor(ind)}</button>
        <span class="cl-val"></span>
        <button type="button" class="cl-x" aria-label="Remove ${labelFor(ind)}">&times;</button>
      </div>`;

    this.legend.innerHTML = `
      <div class="cl-row cl-ohlc" aria-hidden="true">
        <span class="cl-time"></span>
        <span><span class="k">O</span> <span class="v" data-f="open"></span></span>
        <span><span class="k">H</span> <span class="v" data-f="high"></span></span>
        <span><span class="k">L</span> <span class="v" data-f="low"></span></span>
        <span><span class="k">C</span> <span class="v" data-f="close"></span></span>
        <span class="cl-vol"><span class="k">Vol</span> <span class="v" data-f="volume"></span></span>
      </div>
      ${this.settings.indicators.filter((i) => INDICATORS[i.kind].pane === 'price').map(row).join('')}`;

    for (const el of this.paneLegends.values()) el.remove();
    this.paneLegends.clear();
    for (const ind of this.settings.indicators.filter((i) => INDICATORS[i.kind].pane === 'own')) {
      const el = document.createElement('div');
      el.className = 'chart-legend chart-legend-pane';
      el.innerHTML = row(ind);
      el.addEventListener('click', (e) => this.onLegendClick(e));
      this.stage.appendChild(el);
      this.paneLegends.set(ind.uid, el);
    }
  }

  onLegendClick(e) {
    const rowEl = e.target.closest('.cl-row[data-uid]');
    if (!rowEl) return;
    const uid = rowEl.dataset.uid;
    if (e.target.closest('.cl-x')) this.removeIndicator(uid);
    else if (e.target.closest('.cl-name')) {
      e.stopPropagation();
      if (this.editor && this.editor.dataset.uid === uid) this.closeEditor();
      else this.openEditor(uid, rowEl);
    }
  }

  openEditor(uid, anchor) {
    this.closeEditor();
    const ind = this.settings.indicators.find((i) => i.uid === uid);
    if (!ind) return;
    const def = INDICATORS[ind.kind];
    const el = document.createElement('div');
    el.className = 'chart-editor';
    el.dataset.uid = uid;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `${def.name} settings`);
    el.innerHTML = `
      <div class="ce-title">${def.name}</div>
      ${def.params.length ? def.params.map((p) => `
        <label class="ce-field"><span class="label">${p.label}</span>
          <input type="number" class="field field-sm num" data-key="${p.key}" value="${ind.params[p.key]}"
            min="${p.min}" max="${p.max}" step="${p.step}" />
        </label>`).join('') : '<p class="ce-note">VWAP has no settings. It starts fresh at the open.</p>'}
      <div class="ce-actions">
        <button type="button" class="mini mini-danger" data-act="remove">Remove</button>
        <button type="button" class="mini mini-primary" data-act="done">Done</button>
      </div>`;

    el.addEventListener('input', (e) => {
      const input = e.target.closest('input[data-key]');
      if (!input) return;
      const spec = def.params.find((p) => p.key === input.dataset.key);
      const v = Number(input.value);
      if (!isNum(v) || v < spec.min || v > spec.max) return; // wait for a valid number
      ind.params[spec.key] = spec.step >= 1 ? Math.round(v) : v;
      this.refreshLabels(ind);
      this.changed();
    });
    el.addEventListener('change', (e) => {
      const input = e.target.closest('input[data-key]');
      if (input) input.value = ind.params[input.dataset.key]; // snap back anything out of range
    });
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'remove') this.removeIndicator(uid);
      else this.closeEditor();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.closeEditor();
    });

    this.stage.appendChild(el);
    const sr = this.stage.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    el.style.left = `${clamp(ar.left - sr.left, 4, Math.max(4, sr.width - el.offsetWidth - 4))}px`;
    el.style.top = `${clamp(ar.bottom - sr.top + 4, 4, Math.max(4, sr.height - el.offsetHeight - 4))}px`;
    this.editor = el;
    const first = el.querySelector('input');
    if (first) first.focus();
  }

  closeEditor() {
    if (this.editor) {
      this.editor.remove();
      this.editor = null;
    }
  }

  refreshLabels(ind) {
    const text = labelFor(ind);
    document.querySelectorAll(`.cl-row[data-uid="${ind.uid}"]`).forEach((r) => {
      r.querySelector('.cl-name').textContent = text;
      r.querySelector('.cl-x').setAttribute('aria-label', `Remove ${text}`);
    });
  }

  updateLegendValues(i) {
    if (!this.legend) return;
    const bar = this.bars[i];
    const ohlc = this.legend.querySelector('.cl-ohlc');
    if (ohlc) {
      ohlc.style.visibility = bar ? 'visible' : 'hidden';
      if (bar) {
        const tf = TIMEFRAMES[this.settings.timeframe];
        const color = bar.close >= bar.open ? COLORS.up : COLORS.down;
        ohlc.querySelector('.cl-time').textContent = hhmm(bar.t, tf.perBar * this.secsPerTick < 60);
        for (const f of ['open', 'high', 'low', 'close']) {
          const el = ohlc.querySelector(`[data-f="${f}"]`);
          el.textContent = bar[f].toFixed(2);
          el.style.color = color;
        }
        const vol = ohlc.querySelector('.cl-vol');
        vol.style.display = this.settings.volume ? '' : 'none';
        vol.querySelector('[data-f="volume"]').textContent = compact.format(bar.volume);
      }
    }
    for (const ind of this.settings.indicators) {
      const s = this.series.get(ind.uid);
      const host = INDICATORS[ind.kind].pane === 'price' ? this.legend : this.paneLegends.get(ind.uid);
      const valEl = host && host.querySelector(`.cl-row[data-uid="${ind.uid}"] .cl-val`);
      if (!s || !valEl) continue;
      let text;
      if (ind.kind === 'bb') text = [s.upper[i], s.mid[i], s.lower[i]].map((v) => fmtValue(v)).join('  ');
      else if (ind.kind === 'macd') text = [s.macd[i], s.signal[i], s.hist[i]].map((v) => fmtValue(v, 3)).join('  ');
      else text = fmtValue(s.line[i]);
      valEl.textContent = text;
    }
  }

  // ---- data -----------------------------------------------------------------------

  onTick(data) {
    if (!data || !data.priceHistory) return;
    this.history = data.priceHistory;
    if (data.simTimeStr && this.clockDisplay) this.clockDisplay.innerText = data.simTimeStr;

    const me = this.getCurrentUserId();
    const orders = (data.playerOrders && data.playerOrders[me]) || [];
    const brackets = (data.brackets && data.brackets[me]) || [];
    this.levels = [
      ...orders.map((o) => ({ price: o.price, color: COLORS.muted, label: `${o.side} ${o.qty}` })),
      ...brackets.flatMap((b) => [
        b.sl != null ? { price: b.sl, color: COLORS.down, label: 'SL' } : null,
        b.tp != null ? { price: b.tp, color: COLORS.up, label: 'TP' } : null
      ].filter(Boolean))
    ];
    this.recompute();
    this.requestDraw();
  }

  recompute() {
    const tf = TIMEFRAMES[this.settings.timeframe];
    this.bars = resample(this.history, tf.perBar, { originSecs: this.originSecs, secsPerTick: this.secsPerTick });
    const closes = this.bars.map((b) => b.close);
    this.series = new Map();
    for (const ind of this.settings.indicators) {
      this.series.set(ind.uid, INDICATORS[ind.kind].compute(this.bars, ind.params, closes));
    }
  }

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  // ---- drawing ------------------------------------------------------------------------

  draw() {
    if (document.hidden || !this.canvas || !this.ctx || !this.stage) return;
    const W = this.stage.clientWidth || 400;
    const H = this.stage.clientHeight || 200;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = FONT;

    const bars = this.bars;
    const n = bars.length;
    if (n === 0) {
      this.updateLegendValues(-1);
      return;
    }

    // Panes
    const tf = TIMEFRAMES[this.settings.timeframe];
    const plotW = Math.max(40, W - AXIS_W);
    const oscInds = this.settings.indicators.filter((i) => INDICATORS[i.kind].pane === 'own');
    const avail = H - TIME_H;
    let oscH = oscInds.length ? clamp(Math.round(avail * 0.18), 56, 110) : 0;
    if (oscH * oscInds.length > avail * 0.4) oscH = Math.floor((avail * 0.4) / oscInds.length);
    const price = { top: 0, h: avail - oscH * oscInds.length };
    const oscPanes = oscInds.map((ind, k) => ({ ind, top: price.h + k * oscH, h: oscH }));

    // Horizontal layout: a fixed number of slots with the newest bar on the
    // right. "All" grows with the day (at least 24 slots, so the first bars
    // aren't drawn huge).
    const slots = tf.window ? Math.ceil(tf.window / tf.perBar) : Math.max(24, n);
    const count = Math.min(n, slots);
    const start = n - count;
    const offset = slots - count;
    const slotW = plotW / slots;
    const xAt = (i) => (offset + (i - start) + 0.5) * slotW;
    const bodyW = clamp(slotW * 0.64, 1, 16);
    const span = tf.perBar * this.secsPerTick;

    const inPlot = !!this.hover && this.hover.x >= 0 && this.hover.x < plotW && this.hover.y >= 0 && this.hover.y < avail;
    let hoverIdx = null;
    if (inPlot) {
      const i = Math.floor(this.hover.x / slotW) - offset + start;
      if (i >= start && i < n) hoverIdx = i;
    }

    // ---- price pane scale
    const candles = this.settings.type === 'candles';
    const overlays = this.settings.indicators.filter((i) => INDICATORS[i.kind].pane === 'price');
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < n; i++) {
      const b = bars[i];
      lo = Math.min(lo, candles ? b.low : b.close);
      hi = Math.max(hi, candles ? b.high : b.close);
      for (const ind of overlays) {
        const s = this.series.get(ind.uid);
        for (const key of ['line', 'upper', 'lower']) {
          const v = s && s[key] ? s[key][i] : NaN;
          if (isNum(v)) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
      }
    }
    if (hi - lo < 0.02) {
      const mid = (hi + lo) / 2;
      lo = mid - 0.05;
      hi = mid + 0.05;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const pTop = price.top + 10;
    const pBottom = price.top + price.h * (this.settings.volume ? 1 - VOLUME_SHARE - 0.02 : 1) - 10;
    const yP = (p) => pTop + ((hi - p) / (hi - lo)) * (pBottom - pTop);
    const lastY = yP(bars[n - 1].close);

    // ---- grid and price scale
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    const step = niceStep(hi - lo, Math.floor((pBottom - pTop) / 42));
    for (let k = Math.ceil(lo / step); k * step <= hi; k++) {
      const v = k * step;
      const y = Math.round(yP(v)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      if (Math.abs(y - lastY) < 13) continue; // the last-price tag sits here
      ctx.fillStyle = COLORS.faint;
      ctx.fillText(`$${v.toFixed(2)}`, plotW + 8, y);
    }

    // ---- time scale (vertical grid across every pane)
    const pxPerMin = slotW / (span / 60);
    const minuteStep = [1, 2, 5, 10, 15, 30, 60, 120].find((m) => m * pxPerMin >= 80) || 240;
    const tLeft = this.originSecs + (start - offset) * span;
    const tRight = tLeft + slots * span;
    const dayEnd = this.originSecs + this.totalTicks * this.secsPerTick;
    const xT = (t) => (offset - start + (t - this.originSecs) / span) * slotW;
    ctx.textAlign = 'center';
    for (let t = Math.ceil(tLeft / (minuteStep * 60)) * minuteStep * 60; t <= tRight; t += minuteStep * 60) {
      if (t < this.originSecs || t > dayEnd) continue;
      const x = Math.round(xT(t)) + 0.5;
      if (x < 0 || x > plotW) continue;
      const label = hhmm(t);
      const half = ctx.measureText(label).width / 2;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, avail);
      ctx.stroke();
      if (x - half < 0 || x + half > plotW) continue; // label would be cut off
      ctx.fillStyle = COLORS.faint;
      ctx.fillText(label, x, avail + TIME_H / 2 + 1);
    }
    ctx.textAlign = 'left';

    // Axis rules
    ctx.strokeStyle = COLORS.rule;
    ctx.beginPath();
    ctx.moveTo(Math.round(plotW) + 0.5, 0);
    ctx.lineTo(Math.round(plotW) + 0.5, avail);
    ctx.moveTo(0, avail + 0.5);
    ctx.lineTo(W, avail + 0.5);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, price.top, plotW, price.h);
    ctx.clip();

    // ---- volume
    if (this.settings.volume) {
      let maxV = 0;
      for (let i = start; i < n; i++) maxV = Math.max(maxV, bars[i].volume);
      const vBase = price.top + price.h - 1;
      const vH = price.h * VOLUME_SHARE;
      if (maxV > 0) {
        for (let i = start; i < n; i++) {
          const b = bars[i];
          const h = (b.volume / maxV) * vH;
          if (h <= 0) continue;
          ctx.fillStyle = b.close >= b.open ? COLORS.upVol : COLORS.downVol;
          ctx.fillRect(Math.round(xAt(i) - bodyW / 2), vBase - h, Math.max(1, Math.round(bodyW)), h);
        }
      }
    }

    // ---- Bollinger fills sit behind the price
    for (const ind of overlays) {
      if (ind.kind !== 'bb') continue;
      const s = this.series.get(ind.uid);
      if (s) this.fillBand(ctx, s.upper, s.lower, start, n, xAt, yP, ind.color);
    }

    // ---- price
    if (candles) {
      for (let i = start; i < n; i++) {
        const b = bars[i];
        const x = xAt(i);
        const color = b.close >= b.open ? COLORS.up : COLORS.down;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        const cx = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, Math.round(yP(b.high)));
        ctx.lineTo(cx, Math.round(yP(b.low)));
        ctx.stroke();
        if (bodyW >= 2) {
          const yo = yP(b.open);
          const yc = yP(b.close);
          const top = Math.round(Math.min(yo, yc));
          const h = Math.max(1, Math.round(Math.abs(yo - yc)));
          ctx.fillRect(Math.round(x - bodyW / 2), top, Math.round(bodyW), h);
        }
      }
    } else {
      const fill = ctx.createLinearGradient(0, pTop, 0, price.top + price.h);
      fill.addColorStop(0, 'rgba(176, 141, 60, 0.22)');
      fill.addColorStop(1, 'rgba(176, 141, 60, 0)');
      ctx.beginPath();
      ctx.moveTo(xAt(start), price.top + price.h);
      for (let i = start; i < n; i++) ctx.lineTo(xAt(i), yP(bars[i].close));
      ctx.lineTo(xAt(n - 1), price.top + price.h);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.beginPath();
      for (let i = start; i < n; i++) {
        if (i === start) ctx.moveTo(xAt(i), yP(bars[i].close));
        else ctx.lineTo(xAt(i), yP(bars[i].close));
      }
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // ---- overlay lines
    for (const ind of overlays) {
      const s = this.series.get(ind.uid);
      if (!s) continue;
      if (ind.kind === 'bb') {
        this.line(ctx, s.upper, start, n, xAt, yP, ind.color, 1);
        this.line(ctx, s.lower, start, n, xAt, yP, ind.color, 1);
        this.line(ctx, s.mid, start, n, xAt, yP, ind.color, 1, [3, 3]);
      } else {
        this.line(ctx, s.line, start, n, xAt, yP, ind.color, ind.kind === 'vwap' ? 1.5 : 1.5, ind.kind === 'vwap' ? [6, 3] : null);
      }
    }

    // ---- last price
    const last = bars[n - 1];
    const ly = lastY;
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(176, 141, 60, 0.6)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(ly) + 0.5);
    ctx.lineTo(plotW, Math.round(ly) + 0.5);
    ctx.stroke();
    ctx.restore();
    if (!candles) {
      const lx = xAt(n - 1);
      ctx.fillStyle = 'rgba(176, 141, 60, 0.25)';
      ctx.beginPath();
      ctx.arc(lx, ly, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.gold;
      ctx.beginPath();
      ctx.arc(lx, ly, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- your working orders and SL/TP levels
    ctx.save();
    ctx.setLineDash([4, 4]);
    for (const lv of this.levels) {
      if (lv.price < lo || lv.price > hi) continue;
      const y = Math.round(yP(lv.price)) + 0.5;
      ctx.strokeStyle = lv.color;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      const text = `${lv.label} $${lv.price.toFixed(2)}`;
      ctx.fillStyle = lv.color;
      ctx.textBaseline = 'bottom';
      ctx.fillText(text, plotW - ctx.measureText(text).width - 6, y - 3);
    }
    ctx.restore();
    ctx.restore(); // price pane clip

    this.tag(ctx, plotW, ly, `$${last.close.toFixed(2)}`, COLORS.gold, '#fff');

    // ---- indicator panes
    for (const pane of oscPanes) this.drawPane(ctx, pane, { W, plotW, start, n, xAt, bodyW });

    // ---- crosshair: the horizontal line follows the pointer, the vertical
    // line snaps to the bar under it
    if (inPlot) {
      const x = hoverIdx != null ? Math.round(xAt(hoverIdx)) + 0.5 : null;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(11, 29, 71, 0.35)';
      ctx.beginPath();
      if (x != null) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, avail);
      }
      const y = Math.round(this.hover.y) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.restore();

      if (this.hover.y >= pTop - 10 && this.hover.y < price.h) {
        const v = hi - ((this.hover.y - pTop) / (pBottom - pTop)) * (hi - lo);
        this.tag(ctx, plotW, this.hover.y, `$${v.toFixed(2)}`, COLORS.ink, '#fff');
      } else {
        const pane = oscPanes.find((p) => this.hover.y >= p.top && this.hover.y < p.top + p.h);
        if (pane && pane.scale) this.tag(ctx, plotW, this.hover.y, fmtValue(pane.scale.inv(this.hover.y), pane.ind.kind === 'rsi' ? 1 : 3), COLORS.ink, '#fff');
      }
      if (x != null) {
        const tText = hhmm(bars[hoverIdx].t, span < 60);
        ctx.font = FONT;
        const tw = ctx.measureText(tText).width + 10;
        const tx = clamp(x - tw / 2, 0, plotW - tw);
        ctx.fillStyle = COLORS.ink;
        this.roundRect(ctx, tx, avail + 2, tw, TIME_H - 4, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tText, tx + tw / 2, avail + TIME_H / 2 + 1);
        ctx.textAlign = 'left';
      }
    }

    // Legends
    for (const pane of oscPanes) {
      const el = this.paneLegends.get(pane.ind.uid);
      if (el) el.style.top = `${pane.top + 3}px`;
    }
    this.updateLegendValues(hoverIdx ?? n - 1);
  }

  drawPane(ctx, pane, { W, plotW, start, n, xAt, bodyW }) {
    const { ind, top, h } = pane;
    const s = this.series.get(ind.uid);
    const padT = 20;
    const padB = 6;
    ctx.strokeStyle = COLORS.rule;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(top) + 0.5);
    ctx.lineTo(W, Math.round(top) + 0.5);
    ctx.stroke();
    if (!s) return;

    let lo;
    let hi;
    if (ind.kind === 'rsi') {
      lo = 0;
      hi = 100;
    } else {
      lo = 0;
      hi = 0;
      for (let i = start; i < n; i++) {
        for (const v of [s.macd[i], s.signal[i], s.hist[i]]) {
          if (isNum(v)) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
      }
      if (hi - lo < 1e-6) {
        lo -= 0.01;
        hi += 0.01;
      }
      const pad = (hi - lo) * 0.1;
      lo -= pad;
      hi += pad;
    }
    const y = (v) => top + padT + ((hi - v) / (hi - lo)) * (h - padT - padB);
    pane.scale = { inv: (py) => hi - ((py - top - padT) / (h - padT - padB)) * (hi - lo) };

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top + 1, plotW, h - 1);
    ctx.clip();

    const guide = (v, label) => {
      const gy = Math.round(y(v)) + 0.5;
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(11, 29, 71, 0.18)';
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(plotW, gy);
      ctx.stroke();
      ctx.restore();
      return { gy, label };
    };

    const labels = [];
    if (ind.kind === 'rsi') {
      ctx.fillStyle = 'rgba(11, 29, 71, 0.035)';
      ctx.fillRect(0, y(70), plotW, y(30) - y(70));
      labels.push(guide(70, '70'), guide(30, '30'));
      this.line(ctx, s.line, start, n, xAt, y, ind.color, 1.5);
    } else {
      labels.push(guide(0, '0'));
      const zero = y(0);
      for (let i = start; i < n; i++) {
        const v = s.hist[i];
        if (!isNum(v)) continue;
        ctx.fillStyle = v >= 0 ? COLORS.upVol : COLORS.downVol;
        const yv = y(v);
        ctx.fillRect(Math.round(xAt(i) - bodyW / 2), Math.min(zero, yv), Math.max(1, Math.round(bodyW)), Math.max(1, Math.abs(yv - zero)));
      }
      this.line(ctx, s.macd, start, n, xAt, y, ind.color, 1.5);
      this.line(ctx, s.signal, start, n, xAt, y, COLORS.faint, 1.25);
    }
    ctx.restore();

    ctx.fillStyle = COLORS.faint;
    ctx.textBaseline = 'middle';
    for (const { gy, label } of labels) ctx.fillText(label, plotW + 8, gy);
  }

  line(ctx, values, start, n, xAt, y, color, width, dash = null) {
    ctx.save();
    if (dash) ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let drawing = false;
    for (let i = start; i < n; i++) {
      const v = values[i];
      if (!isNum(v)) {
        drawing = false;
        continue;
      }
      if (drawing) ctx.lineTo(xAt(i), y(v));
      else ctx.moveTo(xAt(i), y(v));
      drawing = true;
    }
    ctx.stroke();
    ctx.restore();
  }

  fillBand(ctx, upper, lower, start, n, xAt, y, color) {
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color;
    let i = start;
    while (i < n) {
      while (i < n && !(isNum(upper[i]) && isNum(lower[i]))) i++;
      const from = i;
      while (i < n && isNum(upper[i]) && isNum(lower[i])) i++;
      if (i - from < 2) continue;
      ctx.beginPath();
      for (let j = from; j < i; j++) ctx.lineTo(xAt(j), y(upper[j]));
      for (let j = i - 1; j >= from; j--) ctx.lineTo(xAt(j), y(lower[j]));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  tag(ctx, plotW, y, text, bg, fg) {
    ctx.font = `600 ${FONT}`;
    const w = AXIS_W - 6;
    const h = 17;
    const top = Math.round(y - h / 2);
    ctx.fillStyle = bg;
    this.roundRect(ctx, plotW + 3, top, w, h, 4);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, plotW + 8, top + h / 2 + 0.5);
    ctx.font = FONT;
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

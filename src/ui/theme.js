// src/ui/theme.js
// The three layouts (White, Black, Navy blue) and the Settings popover
// that switches between them.
//
//   import { mountSettingsButtons, onThemeChange, themeColors } from './ui/theme.js';
//   mountSettingsButtons();            // wires every <button data-settings>
//   onThemeChange(() => redraw());     // canvases repaint with the new colours
//   const c = themeColors();           // { ink, gold, bid, shade, palette, ... }
//
// The colours themselves live in assets/themes.css. The choice is kept in
// localStorage under THEME_KEY; each page's <head> has a two-line script
// that applies it before first paint, so switch pages without a flash.

export const THEME_KEY = 'tomorrowMarkets.theme';

// `preview` colours are fixed per layout so each tile always shows what
// you would get, whichever layout is active.
export const THEMES = [
  { id: 'light', label: 'White', preview: { bg: '#EAF0F7', panel: '#FFFFFF', line: '#0B1D47', accent: '#B08D3C', bid: '#0F8A5F', ask: '#C23B32' } },
  { id: 'black', label: 'Black', preview: { bg: '#0B0E11', panel: '#1E2329', line: '#EAECEF', accent: '#4D8DFF', bid: '#2EBD85', ask: '#F6465D' } },
  { id: 'navy', label: 'Navy blue', preview: { bg: '#090C1D', panel: '#1B2150', line: '#E6E8FA', accent: '#8C96FF', bid: '#3DD598', ask: '#FF6B81' } }
];
const IDS = new Set(THEMES.map((t) => t.id));
const EVENT = 'tm:themechange';

export function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return IDS.has(t) ? t : 'light';
}

export function setTheme(id) {
  if (!IDS.has(id)) id = 'light';
  document.documentElement.setAttribute('data-theme', id);
  try { localStorage.setItem(THEME_KEY, id); } catch (err) { /* storage blocked: applies for this visit only */ }
  colorCache = null;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { theme: id } }));
}

export function onThemeChange(cb) {
  const handler = (e) => cb(e.detail.theme);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

// Another tab changed the layout: follow it.
window.addEventListener('storage', (e) => {
  if (e.key === THEME_KEY && IDS.has(e.newValue) && e.newValue !== currentTheme()) setTheme(e.newValue);
});

// ---- Colours for canvas drawing ---------------------------------------------
// Canvas can't use CSS variables, so the chart and lobby background read the
// active layout's tokens here. Cached until the layout changes.

const FALLBACK = {
  ink: '#0B1D47', muted: '#5A6B88', faint: '#8C99B0', shade: '11, 29, 71',
  gold: '#B08D3C', goldRgb: '176, 141, 60', onAccent: '#fff',
  bid: '#0F8A5F', bidRgb: '15, 138, 95', ask: '#C23B32', askRgb: '194, 59, 50',
  tag: '#0B1D47', tagText: '#FFFFFF',
  palette: ['#B08D3C', '#156082', '#7B4FA0', '#C0612B', '#2E8B84', '#A23B72']
};
let colorCache = null;

export function themeColors() {
  if (colorCache) return colorCache;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, key) => cs.getPropertyValue(name).trim() || FALLBACK[key];
  const palette = cs.getPropertyValue('--chart-palette').split(',').map((c) => c.trim()).filter(Boolean);
  const colors = {
    ink: v('--ink', 'ink'),
    muted: v('--muted', 'muted'),
    faint: v('--faint', 'faint'),
    shade: v('--shade', 'shade'),
    gold: v('--gold', 'gold'),
    goldRgb: v('--gold-rgb', 'goldRgb'),
    onAccent: v('--on-accent', 'onAccent'),
    bid: v('--bid', 'bid'),
    bidRgb: v('--bid-rgb', 'bidRgb'),
    ask: v('--ask', 'ask'),
    askRgb: v('--ask-rgb', 'askRgb'),
    tag: v('--chart-tag', 'tag'),
    tagText: v('--chart-tag-text', 'tagText'),
    palette: palette.length ? palette : FALLBACK.palette
  };
  // Only cache once themes.css has loaded, so an early read can't pin the fallback.
  if (cs.getPropertyValue('--ink').trim()) colorCache = colors;
  return colors;
}

// ---- Settings popover -------------------------------------------------------

const STYLE_ID = 'tm-settings-styles';
const CSS = `
.tm-settings {
  position: fixed; z-index: 60; width: 17.5rem; padding: 14px;
  background: var(--menu); color: var(--ink); border-radius: 14px;
  box-shadow: 0 0 0 1px var(--line), 0 22px 48px -24px rgba(var(--shadow-rgb), 0.55);
  font-family: 'Inter', system-ui, 'Segoe UI', sans-serif;
}
.tm-settings[hidden] { display: none; }
.tm-settings fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.tm-settings legend { padding: 0; font-size: 12.5px; font-weight: 600; color: var(--ink); margin-bottom: 10px; }
.tm-settings__options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.tm-theme-opt { display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; }
.tm-theme-opt input { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); border: 0; }
.tm-theme-opt__preview {
  position: relative; display: block; width: 100%; border-radius: 9px; line-height: 0;
  box-shadow: 0 0 0 1px var(--line-strong); transition: box-shadow .15s;
}
.tm-theme-opt__preview svg { display: block; width: 100%; height: auto; border-radius: 9px; }
.tm-theme-opt:hover .tm-theme-opt__preview { box-shadow: 0 0 0 1px var(--line-hover); }
.tm-theme-opt.is-selected .tm-theme-opt__preview { box-shadow: 0 0 0 2px var(--gold); }
.tm-theme-opt input:focus-visible + .tm-theme-opt__preview { outline: 2px solid var(--gold); outline-offset: 3px; }
.tm-theme-opt__tick {
  position: absolute; right: -5px; top: -5px; width: 16px; height: 16px; border-radius: 999px;
  background: var(--gold); color: var(--on-accent); display: none; place-items: center;
  box-shadow: 0 0 0 2px var(--menu);
}
.tm-theme-opt__tick svg { width: 10px; height: 10px; border-radius: 0; }
.tm-theme-opt.is-selected .tm-theme-opt__tick { display: grid; }
.tm-theme-opt__name { font-size: 11.5px; font-weight: 500; color: var(--muted); }
.tm-theme-opt.is-selected .tm-theme-opt__name { color: var(--ink); font-weight: 600; }
[data-settings][aria-expanded="true"] { border-color: var(--line-hover); background: var(--ghost-hover); }
`;

function previewSvg(p) {
  return `<svg viewBox="0 0 64 42" aria-hidden="true">
    <rect width="64" height="42" fill="${p.bg}"/>
    <rect x="5" y="5" width="34" height="32" rx="3.5" fill="${p.panel}"/>
    <polyline points="9,29 14,24 18,26.5 23,18 28,21 34,12" fill="none" stroke="${p.line}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="34" cy="12" r="2.1" fill="${p.accent}"/>
    <rect x="43" y="5" width="16" height="14.5" rx="3" fill="${p.panel}"/>
    <rect x="46" y="8.5" width="10" height="2" rx="1" fill="${p.ask}"/>
    <rect x="46" y="13" width="7" height="2" rx="1" fill="${p.ask}"/>
    <rect x="43" y="22.5" width="16" height="14.5" rx="3" fill="${p.panel}"/>
    <rect x="46" y="26" width="10" height="2" rx="1" fill="${p.bid}"/>
    <rect x="46" y="30.5" width="7" height="2" rx="1" fill="${p.bid}"/>
  </svg>`;
}

const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let panel = null;
let anchor = null;

function buildPanel() {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }
  panel = document.createElement('div');
  panel.className = 'tm-settings';
  panel.id = 'tm-settings';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Settings');
  panel.hidden = true;
  panel.innerHTML = `
    <fieldset>
      <legend>Layout</legend>
      <div class="tm-settings__options">
        ${THEMES.map((t) => `
          <label class="tm-theme-opt" data-theme-id="${t.id}">
            <input type="radio" name="tm-theme" value="${t.id}" />
            <span class="tm-theme-opt__preview">${previewSvg(t.preview)}<span class="tm-theme-opt__tick">${TICK}</span></span>
            <span class="tm-theme-opt__name">${t.label}</span>
          </label>`).join('')}
      </div>
    </fieldset>`;

  panel.addEventListener('change', (e) => {
    if (e.target.name === 'tm-theme') setTheme(e.target.value);
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close({ restoreFocus: true });
    }
  });
  onThemeChange(syncSelection);
  document.body.append(panel);
}

function syncSelection() {
  if (!panel) return;
  const id = currentTheme();
  panel.querySelectorAll('.tm-theme-opt').forEach((opt) => {
    const on = opt.dataset.themeId === id;
    opt.classList.toggle('is-selected', on);
    opt.querySelector('input').checked = on;
  });
}

function place() {
  if (!panel || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const below = r.bottom + 8;
  panel.style.left = `${left}px`;
  panel.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below}px`;
}

function onOutside(e) {
  if (panel.contains(e.target) || (anchor && anchor.contains(e.target))) return;
  close();
}

function open(button) {
  if (!panel) buildPanel();
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  anchor = button;
  anchor.setAttribute('aria-expanded', 'true');
  syncSelection();
  panel.hidden = false;
  place();
  const checked = panel.querySelector('input:checked');
  if (checked) checked.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', place);
}

function close({ restoreFocus = false } = {}) {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('resize', place);
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus) anchor.focus();
  }
  anchor = null;
}

/** Wires every `[data-settings]` button under `root` to the Settings popover. */
export function mountSettingsButtons(root = document) {
  root.querySelectorAll('[data-settings]').forEach((btn) => {
    if (btn.dataset.settingsBound) return;
    btn.dataset.settingsBound = '1';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-controls', 'tm-settings');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => {
      if (panel && !panel.hidden && anchor === btn) close();
      else open(btn);
    });
  });
}

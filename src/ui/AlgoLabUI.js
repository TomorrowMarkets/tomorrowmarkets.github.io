// src/ui/AlgoLabUI.js
// The Algo Lab: choose Python or R, write or upload a strategy, and test it
// before it's allowed into a game. "Test" means really loading the runtime,
// running the source, and calling on_tick once on a sample market; nothing
// from that test run is traded. Drafts are kept in this browser per
// language, so a player can close the game, come back, improve the script
// and run it again.
import { AlgoRunner } from '../engine/algo/AlgoRunner.js';
import { sampleSnapshot } from '../engine/algo/AlgoAPI.js';

const DRAFT_KEY = (lang) => `tomorrowMarkets.algoDraft.${lang}`;
const LAST_LANG_KEY = 'tomorrowMarkets.algoLastLang';

const TEMPLATES = {
  python: `# on_tick(data) is called at every decision round. data holds:
#   data["close"], ["open"], ["high"], ["low"], ["volume"]  lists, oldest first
#   data["returns"]                                         bar-to-bar % change
#   data["sma20"], ["sma50"], ["ema12"], ["ema26"]          None until warmed up
#   data["book"]["bids"], ["asks"]   [{"price": .., "qty": ..}], best first
#   data["book"]["mid"], ["spread"], ["imbalance"]          imbalance in [-1, 1]
#   data["orders"]                   your working limit orders
#   data["account"]["cash"], ["shares"], ["avg_entry"], ["realized_pnl"], ["unrealized_pnl"]
#
# Trade with:
#   market_order("buy" | "sell", qty)
#   limit_order("buy" | "sell", qty, price)
#   cancel_all()
#
# Top-level variables keep their values between rounds.

LOT = 10

def on_tick(data):
    price = data["close"][-1]
    sma20 = data["sma20"][-1]
    shares = data["account"]["shares"]
    if price is None or sma20 is None:
        return  # not enough history yet

    if price > sma20 and shares <= 0:
        market_order("buy", LOT - shares)    # go long LOT shares
    elif price < sma20 and shares >= 0:
        market_order("sell", LOT + shares)   # go short LOT shares
`,
  r: `# on_tick(data) is called at every decision round. data holds:
#   data$close, $open, $high, $low, $volume   vectors, oldest first
#   data$returns                              bar-to-bar % change
#   data$sma20, $sma50, $ema12, $ema26        NA until warmed up
#   data$book$bids, data$book$asks            data frames (price, qty), best first
#   data$book$mid, $spread, $imbalance        imbalance in [-1, 1]
#   data$orders                               your working limit orders
#   data$account$cash, $shares, $avg_entry, $realized_pnl, $unrealized_pnl
#
# Trade with:
#   market_order("buy" | "sell", qty)
#   limit_order("buy" | "sell", qty, price)
#   cancel_all()
#
# Variables set outside on_tick (or with <<-) keep their values between rounds.

lot <- 10

on_tick <- function(data) {
  price  <- tail(data$close, 1)
  sma20  <- tail(data$sma20, 1)
  shares <- data$account$shares
  if (length(sma20) == 0 || is.na(price) || is.na(sma20)) return(invisible(NULL))

  if (price > sma20 && shares <= 0) {
    market_order("buy", lot - shares)    # go long lot shares
  } else if (price < sma20 && shares >= 0) {
    market_order("sell", lot + shares)   # go short lot shares
  }
}
`
};

export class AlgoLabUI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.screen = $('algo-lab-screen');
    this.langButtons = document.querySelectorAll('#algo-lab-screen [data-lang]');
    this.codeArea = $('algo-code');
    this.fileInput = $('algo-file-input');
    this.consoleBox = $('algo-console');
    this.statusLabel = $('algo-lab-status');
    this.enterBtn = $('btn-algo-enter');
    this.backBtn = $('btn-algo-back');
    this.resetBtn = $('btn-algo-template');
    this.refBlocks = { python: $('algo-reference-python'), r: $('algo-reference-r') };

    this.language = 'python';
    this.onReady = null; // (runner) => void, called with a tested AlgoRunner
    this.onBack = null;  // () => void
    this.validating = false;
    this.initListeners();
  }

  initListeners() {
    this.langButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        if (btn.disabled || lang === this.language || !TEMPLATES[lang]) return;
        this.saveDraft();
        this.setLanguage(lang);
      });
    });

    if (this.fileInput) {
      this.fileInput.addEventListener('change', async () => {
        const file = this.fileInput.files && this.fileInput.files[0];
        this.fileInput.value = '';
        if (!file) return;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const lang = ext === 'r' ? 'r' : ext === 'py' ? 'python' : this.language;
        if (lang !== this.language) {
          this.saveDraft();
          this.setLanguage(lang);
        }
        this.codeArea.value = await file.text();
        this.saveDraft();
        this.setConsole([{ level: 'info', text: `Loaded ${file.name}.` }]);
      });
    }

    if (this.codeArea) {
      this.codeArea.addEventListener('input', () => this.saveDraft());
      // Tab inserts four spaces instead of leaving the editor.
      this.codeArea.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || e.shiftKey) return;
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b, value } = this.codeArea;
        this.codeArea.value = value.slice(0, a) + '    ' + value.slice(b);
        this.codeArea.selectionStart = this.codeArea.selectionEnd = a + 4;
      });
    }

    if (this.resetBtn) {
      this.resetBtn.addEventListener('click', () => {
        this.codeArea.value = TEMPLATES[this.language];
        this.saveDraft();
        this.setConsole(null);
      });
    }
    if (this.enterBtn) this.enterBtn.addEventListener('click', () => this.testAndEnter());
    if (this.backBtn) {
      this.backBtn.addEventListener('click', () => {
        if (this.validating) return;
        this.saveDraft();
        if (this.onBack) this.onBack();
      });
    }
  }

  open({ language = null, note = '' } = {}) {
    let lang = language;
    if (!lang) {
      try { lang = localStorage.getItem(LAST_LANG_KEY); } catch (err) { /* storage unavailable */ }
    }
    this.setLanguage(TEMPLATES[lang] ? lang : 'python');
    this.setConsole(null);
    this.setStatus(note);
    if (this.screen) this.screen.classList.remove('hidden');
    if (this.codeArea) this.codeArea.focus();
  }

  close() {
    if (this.screen) this.screen.classList.add('hidden');
  }

  setLanguage(lang) {
    this.language = lang;
    try { localStorage.setItem(LAST_LANG_KEY, lang); } catch (err) { /* storage unavailable */ }
    this.langButtons.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.lang === lang));
    for (const [key, el] of Object.entries(this.refBlocks)) {
      if (el) el.classList.toggle('hidden', key !== lang);
    }
    let draft = null;
    try { draft = localStorage.getItem(DRAFT_KEY(lang)); } catch (err) { /* storage unavailable */ }
    this.codeArea.value = draft || TEMPLATES[lang];
    this.setConsole(null);
  }

  saveDraft() {
    try { localStorage.setItem(DRAFT_KEY(this.language), this.codeArea.value); } catch (err) { /* storage full or blocked */ }
  }

  async testAndEnter() {
    if (this.validating) return;
    const code = this.codeArea.value;
    if (!code.trim()) {
      this.setConsole([{ level: 'error', text: 'Write or upload a strategy first.' }]);
      return;
    }
    this.saveDraft();
    this.validating = true;
    this.enterBtn.disabled = true;
    const runner = new AlgoRunner(this.language);
    this.setConsole(null);
    this.setStatus(`Loading ${runner.label} and test-running your strategy. The first load can take a little while…`);

    try {
      const res = await runner.validate(code, sampleSnapshot());
      const lines = (res.logs || []).map((text) => ({ level: 'info', text }));
      const asks = (res.actions || []).map((a) => describeAction(a));
      lines.push({
        level: 'success',
        text: asks.length
          ? `Test run passed. On a sample market it would have placed: ${asks.join('; ')} (nothing was traded).`
          : 'Test run passed. It placed no orders on the sample market, which is fine.'
      });
      this.setConsole(lines);
      this.setStatus('');
      if (this.onReady) this.onReady(runner);
    } catch (err) {
      runner.dispose();
      this.setStatus('');
      this.setConsole([{ level: 'error', text: err.message }]);
    } finally {
      this.validating = false;
      this.enterBtn.disabled = false;
    }
  }

  setStatus(text) {
    if (this.statusLabel) this.statusLabel.textContent = text || '';
  }

  setConsole(lines) {
    if (!this.consoleBox) return;
    if (!lines || lines.length === 0) {
      this.consoleBox.classList.add('hidden');
      this.consoleBox.innerHTML = '';
      return;
    }
    this.consoleBox.classList.remove('hidden');
    this.consoleBox.innerHTML = lines.map((l) => `<div class="line-${l.level || 'info'}">${escapeHtml(l.text)}</div>`).join('');
    this.consoleBox.scrollTop = this.consoleBox.scrollHeight;
  }
}

function describeAction(a) {
  const kind = String(a.kind || '').toUpperCase();
  if (kind === 'CANCEL_ALL') return 'cancel all';
  const side = String(a.side || '').toLowerCase();
  return kind === 'LIMIT' ? `${side} ${a.qty} @ ${Number(a.price).toFixed(2)}` : `${side} ${a.qty} at market`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

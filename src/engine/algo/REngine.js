// src/engine/algo/REngine.js
// Runs a player's R strategy with webR (https://webr.r-wasm.org). webR runs R
// in its own worker, so there's no separate worker file here.
//
// The strategy defines on_tick <- function(data) { ... }; `data` is the same
// snapshot Python gets, parsed with jsonlite into plain R lists, vectors and
// data frames (JSON nulls become NA).
//
// R code can't call back into JavaScript directly, so market_order(),
// limit_order() and cancel_all() each cat() one marked line of JSON to
// stdout, which we pick back out of the captured output. Everything else the
// script prints comes through as ordinary log lines.
const WEBR_URL = 'https://webr.r-wasm.org/latest/webr.mjs';
const ORDER_MARK = '@@TM_ORDER@@';
const ERROR_MARK = '@@TM_ERROR@@';
// Stream message()/warning() as plain stderr text (webR would otherwise hand
// them back as condition objects), and skip the plot device: nothing is drawn.
const CAPTURE = { captureConditions: false, captureGraphics: false };
// Wraps R code so any error, parse errors included, is printed as one marked
// line with its message, rather than coming back as an opaque condition.
const guarded = (expr) =>
  `tryCatch(${expr}, error = function(e) cat(paste0("${ERROR_MARK}", gsub("\\n", " ", conditionMessage(e)), "\n")))`;

const HARNESS = `
if (!requireNamespace("jsonlite", quietly = TRUE)) webr::install("jsonlite", quiet = TRUE)
.tm_emit <- function(x) cat(paste0("${ORDER_MARK}", jsonlite::toJSON(x, auto_unbox = TRUE), "\\n"))
market_order <- function(side, qty) .tm_emit(list(kind = "MARKET", side = toupper(side), qty = qty))
limit_order <- function(side, qty, price) .tm_emit(list(kind = "LIMIT", side = toupper(side), qty = qty, price = price))
cancel_all <- function() .tm_emit(list(kind = "CANCEL_ALL"))
if (exists("on_tick")) rm(on_tick)
`;

export class REngine {
  constructor() {
    this.webR = null;
    this.shelter = null;
  }

  // Safe to call again on the same engine: re-running the source resets the
  // strategy's top-level variables (used after the Algo Lab's test run).
  async init(code) {
    if (!this.webR) {
      const { WebR } = await import(WEBR_URL);
      this.webR = new WebR();
      await this.webR.init();
      this.shelter = await new this.webR.Shelter();
    }
    try {
      const harness = await this.shelter.captureR(HARNESS, CAPTURE);
      this._raiseIfError(harness, 'Could not prepare the R runtime.');
      await this.webR.objs.globalEnv.bind('.tm_code', code);
      const setup = await this.shelter.captureR(guarded('eval(parse(text = .tm_code), envir = globalenv())'), CAPTURE);
      this._raiseIfError(setup, 'Your R script failed to load.');
      const check = await this.shelter.captureR('cat(isTRUE(exists("on_tick") && is.function(on_tick)))', CAPTURE);
      const ok = check.output.some((o) => o.type === 'stdout' && String(o.data).includes('TRUE'));
      if (!ok) throw new Error('Your script needs to define a function called on_tick(data).');
    } finally {
      this.shelter.purge();
    }
  }

  async step(data) {
    await this.webR.objs.globalEnv.bind('.tm_tick_json', JSON.stringify(data));
    try {
      const capture = await this.shelter.captureR(
        guarded('invisible(on_tick(jsonlite::fromJSON(.tm_tick_json, simplifyVector = TRUE)))'),
        CAPTURE
      );
      this._raiseIfError(capture, 'Your R script raised an error.');
      return this._parseOutput(capture);
    } finally {
      this.shelter.purge();
    }
  }

  terminate() {
    try { if (this.shelter) this.shelter.purge(); } catch (err) { /* best effort */ }
    try { if (this.webR) this.webR.close(); } catch (err) { /* best effort */ }
    this.webR = null;
    this.shelter = null;
  }

  _parseOutput(capture) {
    const actions = [];
    const logs = [];
    for (const item of capture.output) {
      if (item.type !== 'stdout' && item.type !== 'stderr') continue;
      const text = typeof item.data === 'string' ? item.data : '';
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (line.startsWith(ERROR_MARK)) continue; // handled by _raiseIfError
        if (line.startsWith(ORDER_MARK)) {
          try { actions.push(JSON.parse(line.slice(ORDER_MARK.length))); } catch (err) { /* malformed, skip */ }
        } else {
          logs.push(line);
        }
      }
    }
    return { actions, logs };
  }

  _raiseIfError(capture, fallback) {
    for (const o of capture.output) {
      if (o.type === 'stdout' && typeof o.data === 'string' && o.data.startsWith(ERROR_MARK)) {
        throw new Error(`R error: ${o.data.slice(ERROR_MARK.length).trim()}`);
      }
    }
    if (capture.output.some((o) => o.type === 'error')) throw new Error(fallback);
  }
}

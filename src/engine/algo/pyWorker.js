// src/engine/algo/pyWorker.js
// A dedicated module Web Worker so a slow or stuck Python strategy can never
// freeze the game tab: the main thread can always terminate() it.
// 'init' (re)runs the player's source (which must define on_tick(data));
// 'step' calls on_tick(data) once. Python globals survive between steps, so
// strategies keep state in ordinary module-level variables. Sending 'init'
// again re-runs the source, which resets those variables.
import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs';

// Bump this together with the import URL above to move to a newer Pyodide.
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const pyodideReady = loadPyodide({ indexURL: PYODIDE_INDEX_URL });

let actions = [];
const jsMarket = (side, qty) => { actions.push({ kind: 'MARKET', side, qty }); };
const jsLimit = (side, qty, price) => { actions.push({ kind: 'LIMIT', side, qty, price }); };
const jsCancelAll = () => { actions.push({ kind: 'CANCEL_ALL' }); };

// The trading handles are thin Python wrappers, so keyword arguments and
// numpy numbers work. print() output (stdout) is collected and sent back to
// the game's own log. stderr is deliberately left alone: Pyodide writes the
// traceback there to build the error message, and capturing it would reduce
// every error to a bare "PythonError".
const HARNESS = `
import sys, io, json as _tm_json

_log_lines = []

class _TMOut(io.TextIOBase):
    # print() writes each argument separately, so buffer until a newline.
    def __init__(self):
        super().__init__()
        self._buf = ''

    def write(self, s):
        self._buf += str(s)
        *done, self._buf = self._buf.split('\\n')
        for line in done:
            if line.strip():
                _log_lines.append(line)
        return len(s)

    def flush_rest(self):
        if self._buf.strip():
            _log_lines.append(self._buf)
        self._buf = ''

_tm_out = _TMOut()
sys.stdout = _tm_out

def market_order(side, qty):
    _tm_js_market(str(side), float(qty))

def limit_order(side, qty, price):
    _tm_js_limit(str(side), float(qty), float(price))

def cancel_all():
    _tm_js_cancel_all()

def _tm_step(payload):
    _log_lines.clear()
    try:
        on_tick(_tm_json.loads(payload))
    finally:
        _tm_out.flush_rest()
    return list(_log_lines)
`;

function formatError(err) {
  const msg = err && err.message ? err.message : String(err);
  // Pyodide tracebacks are long; the last lines are the ones a player needs.
  return msg.split('\n').filter(Boolean).slice(-6).join('\n');
}

self.onmessage = async (e) => {
  const { id, type, code, data } = e.data;
  try {
    const pyodide = await pyodideReady;

    if (type === 'init') {
      pyodide.globals.set('_tm_js_market', jsMarket);
      pyodide.globals.set('_tm_js_limit', jsLimit);
      pyodide.globals.set('_tm_js_cancel_all', jsCancelAll);
      pyodide.runPython(HARNESS);
      await pyodide.loadPackagesFromImports(code); // numpy, pandas, ... if imported
      pyodide.runPython('try:\n    del on_tick\nexcept NameError:\n    pass');
      await pyodide.runPythonAsync(code);
      const onTick = pyodide.globals.get('on_tick');
      const ok = typeof onTick === 'function';
      if (onTick && typeof onTick.destroy === 'function') onTick.destroy();
      if (!ok) throw new Error('Your script needs to define a function called on_tick(data).');
      self.postMessage({ id, ok: true });
    } else if (type === 'step') {
      actions = [];
      const step = pyodide.globals.get('_tm_step');
      let logs = [];
      try {
        const out = step(JSON.stringify(data));
        logs = out && typeof out.toJs === 'function' ? out.toJs() : [];
        if (out && typeof out.destroy === 'function') out.destroy();
      } finally {
        step.destroy();
      }
      self.postMessage({ id, ok: true, actions, logs });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: formatError(err) });
  }
};

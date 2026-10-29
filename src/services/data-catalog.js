// Datasets stay in the repository; only the authority loads future prices.
import { SESSION_DAY_OPTIONS, DURATION_OPTIONS, PORTFOLIO_ROUND_OPTIONS } from '../engine/session.js';
export async function fetchJSON(url, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Could not load ${new URL(url).pathname} (HTTP ${response.status}).`);
    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Loading the dataset timed out. Please try again.');
    throw err;
  } finally { clearTimeout(timer); }
}

export async function loadCatalog(manifestPath, baseURL = document.baseURI, options = {}) {
  const url = new URL(manifestPath, baseURL);
  const raw = await fetchJSON(url.href, options);
  if (!raw || raw.version !== 1) throw new Error('Unsupported data manifest version; expected version 1.');
  const ids = new Set();
  const read = (kind) => {
    const entries = raw[kind] || [];
    if (!Array.isArray(entries)) throw new Error(`Manifest ${kind} must be an array.`);
    return entries.map((entry) => {
      if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
        || typeof entry.path !== 'string' || !entry.path || typeof entry.label !== 'string') {
        throw new Error('Every dataset needs a unique id, label and path.');
      }
      ids.add(entry.id);
      const dataURL = new URL(entry.path, url);
      if (dataURL.origin !== url.origin || !['http:', 'https:'].includes(dataURL.protocol)) {
        throw new Error('Dataset paths must point to files on this site.');
      }
      return { id: entry.id, label: entry.label, demo: entry.demo === true, url: dataURL.href };
    });
  };
  return { orderbooks: read('orderbooks'), portfolios: read('portfolios') };
}

// Only public, descriptive session settings travel over WebRTC. Never send a
// dataset, its future price rows, or the authority's pending allocation map.
export function publicSettings(settings) {
  return {
    version: 4,
    sessionDays: SESSION_DAY_OPTIONS.includes(settings.sessionDays) ? settings.sessionDays : 5,
    barMinutes: [0.25,5,10,15].includes(settings.barMinutes) ? settings.barMinutes : 5,
    fastBacktest: settings.fastBacktest === true,
    arenaLearning: settings.arenaLearning === true,
    windowStart: String(settings.windowStart || '').slice(0,10),
    windowEnd: String(settings.windowEnd || '').slice(0,10),
    dataSource: settings.dataSource === 'historical' ? 'historical' : 'simulated',
    durationMinutes: DURATION_OPTIONS.includes(settings.durationMinutes) ? settings.durationMinutes : 20,
    portfolioRoundSeconds: PORTFOLIO_ROUND_OPTIONS.includes(settings.portfolioRoundSeconds) ? settings.portfolioRoundSeconds : 30,
    portfolioStride: settings.portfolioStride === 1 ? 1 : 5,
    datasetId: String(settings.datasetId || '').slice(0, 100),
    datasetLabel: String(settings.datasetLabel || '').slice(0, 160),
    demo: settings.demo === true
  };
}

import { loadCatalog, fetchJSON, publicSettings } from '../services/data-catalog.js';
import { validateOrderbookDataset } from '../engine/HistoricalMarket.js';
import { validatePortfolioDataset, chooseAnnualWindow } from '../engine/PortfolioChallenge.js';

export class ChallengeSetup {
  constructor(manifestPath, root = document) {
    this.root = root;
    this.manifestPath = manifestPath;
    this.catalogPromise = null;
    this.kind = 'solo';
    this.byId('setup-source').addEventListener('change', () => this.render());
    this.byId('setup-portfolio-dataset').addEventListener('change', () => this.render());
  }
  byId(id) { return this.root.getElementById(id); }

  async catalog() {
    if (!this.catalogPromise) {
      this.catalogPromise = loadCatalog(this.manifestPath).catch((err) => { this.catalogPromise = null; throw err; });
    }
    return this.catalogPromise;
  }

  async show(kind) {
    this.kind = kind;
    this.byId('challenge-settings').hidden = kind === 'join';
    this.byId('setup-join-note').hidden = kind !== 'join';
    if (kind === 'join') return;
    this.byId('setup-status').textContent = 'Loading available datasets…';
    try {
      const catalog = await this.catalog();
      for (const [id, entries] of [['setup-book-dataset', catalog.orderbooks], ['setup-portfolio-dataset', catalog.portfolios]]) {
        const select = this.byId(id);
        const selected = select.value;
        select.replaceChildren(...entries.map((entry) => new Option(entry.label + (entry.demo ? ' · DEMO' : ''), entry.id)));
        if (!entries.length) select.add(new Option('No dataset installed', ''));
        if (entries.some((entry) => entry.id === selected)) select.value = selected;
        else if (entries.some((entry) => !entry.demo)) select.value = entries.find((entry) => !entry.demo).id;
      }
      this.render();
    } catch (err) {
      this.byId('setup-status').textContent = `${err.message} Simulated trading is still available.`;
    }
  }

  render() {
    this.byId('setup-book-wrap').hidden = this.byId('setup-source').value !== 'historical';
    const option = this.byId('setup-portfolio-dataset').selectedOptions[0];
    this.byId('setup-status').textContent = option?.textContent.includes('DEMO')
      ? 'The included demo uses synthetic prices. Add a Yahoo Finance dataset to play with real history.'
      : 'The host loads the dataset. Every player receives the same current prices and decision dates.';
  }

  async prepare(mode) {
    const settings = publicSettings({
      dataSource: mode === 'portfolio' ? 'historical' : this.byId('setup-source').value,
      durationMinutes: Number(this.byId('setup-duration').value),
      portfolioStride: Number(this.byId('setup-stride').value)
    });
    // Joining never loads a local dataset or dictates the host's settings.
    if (this.kind === 'join') return { settings, data: null };
    if (mode !== 'portfolio' && settings.dataSource === 'simulated') return { settings, data: null };
    const catalog = await this.catalog();
    const entries = mode === 'portfolio' ? catalog.portfolios : catalog.orderbooks;
    const id = this.byId(mode === 'portfolio' ? 'setup-portfolio-dataset' : 'setup-book-dataset').value;
    const entry = entries.find((item) => item.id === id);
    if (!entry) throw new Error(`No ${mode === 'portfolio' ? 'portfolio' : 'orderbook'} dataset is installed. Add one to data/manifest.json first.`);
    const raw = await fetchJSON(entry.url);
    const data = mode === 'portfolio' ? validatePortfolioDataset(raw) : validateOrderbookDataset(raw);
    if (mode === 'portfolio') chooseAnnualWindow(data, () => 0); // validate coverage before leaving the menu
    return { settings: publicSettings({ ...settings, datasetId: entry.id, datasetLabel: entry.label,
      demo: entry.demo || data.demo }), data };
  }
}

import { loadCatalog, fetchJSON, publicSettings } from '../services/data-catalog.js';
import { selectHistoricalSessions } from '../engine/session.js';
import { sessionPlan } from '../engine/session.js';
import { validateOrderbookDataset } from '../engine/HistoricalMarket.js';
import { validatePortfolioDataset, chooseAnnualWindow } from '../engine/PortfolioChallenge.js';

export class ChallengeSetup {
  constructor(manifestPath, root = document) {
    this.root = root;
    this.manifestPath = manifestPath;
    this.catalogPromise = null;
    this.kind = 'solo';
    this.byId('challenge-settings').addEventListener('change', () => this.render());
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
    this.byId('challenge-settings-details').hidden = kind === 'join';
    this.byId('challenge-settings-details').open = kind === 'backtest';
    this.byId('setup-source').disabled = kind === 'backtest';
    if (kind === 'backtest') this.byId('setup-source').value = 'historical';
    this.byId('setup-history-start-wrap').hidden = kind !== 'backtest';
    for (const id of ['mode-discretionary','mode-portfolio','mode-arena']) this.byId(id).hidden = kind === 'backtest';
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
    this.byId('setup-summary').textContent = `Session settings · ${this.byId('setup-duration').value} min · ${this.byId('setup-days').value} trading day(s) · ${this.byId('setup-source').value === 'historical' ? 'Historical' : 'Simulated'}`;
    this.byId('setup-book-wrap').hidden = this.byId('setup-source').value !== 'historical';
    const stride = Number(this.byId('setup-stride').value);
    const seconds = Number(this.byId('setup-round-seconds').value);
    this.byId('setup-pm-timing').textContent = `${seconds} seconds for every allocation round. About ${Math.ceil(Math.ceil(252/stride)*seconds/60)} minutes for a typical year; the exact duration appears when the random year is selected. Trading duration above does not shorten portfolio rounds.`;
    const plan = sessionPlan({sessionDays:Number(this.byId('setup-days').value),barMinutes:Number(this.byId('setup-bar-minutes').value),durationMinutes:Number(this.byId('setup-duration').value)});
    this.byId('setup-trading-timing').textContent = `${plan.totalTicks.toLocaleString()} completed bars · ${(plan.tickIntervalMs/1000).toFixed(1)} real seconds per decision bar. The order book updates between bars.${plan.tickIntervalMs<1000 ? ' Very fast compression; a longer duration gives strategies more time.' : ''} Historical runs require ${plan.sessionDays} recorded sessions.`;
    const option = this.byId('setup-portfolio-dataset').selectedOptions[0];
    this.byId('setup-status').textContent = option?.textContent.includes('DEMO')
      ? 'The included demo uses synthetic prices. Add a Yahoo Finance dataset to play with real history.'
      : 'The host loads the dataset. Every player receives the same current prices and decision dates.';
  }

  async prepare(mode) {
    const settings = publicSettings({
      dataSource: mode === 'portfolio' ? 'historical' : this.byId('setup-source').value,
      durationMinutes: Number(this.byId('setup-duration').value),
      sessionDays: Number(this.byId('setup-days').value),
      barMinutes: Number(this.byId('setup-bar-minutes').value),
      arenaLearning: this.byId('setup-arena-learning').checked,
      portfolioStride: Number(this.byId('setup-stride').value),
      portfolioRoundSeconds: Number(this.byId('setup-round-seconds').value)
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
    const data = mode === 'portfolio' ? validatePortfolioDataset(raw) : selectHistoricalSessions(validateOrderbookDataset(raw), settings.sessionDays,
      this.kind === 'backtest' ? () => 0 : Math.random, this.kind === 'backtest' ? this.byId('setup-history-start').value || null : null);
    if (mode === 'portfolio') chooseAnnualWindow(data, () => 0); // validate coverage before leaving the menu
    return { settings: publicSettings({ ...settings, datasetId: entry.id, datasetLabel: entry.label,
      demo: entry.demo || data.demo, windowStart: data.windowStart, windowEnd: data.windowEnd }), data };
  }
}

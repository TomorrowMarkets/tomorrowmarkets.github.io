# Tomorrow Markets — version 3

Merge this source package into your existing repository, preserving your Git settings, other workflows and any real datasets/configuration you have added. It combines public source commit `e1e0592a29ac7444dc5a9633734841f800635e67`, the earlier historical/portfolio update, and the changes below. Version 3 extends the earlier package; it is a source update and has not been deployed here.

## Implemented

| Request | Result |
| --- | --- |
| Donations | PayPal-first setup guide, primary support link and optional GoFundMe/Patreon alternatives |
| Consistent colours | Main lobby actions share one accent; readable gold fills in the light theme |
| Trading layouts | Responsive chart/book/tape/positions layouts; manual quick sizes and click-to-price; algorithmic status/log with no manual ticket |
| Multiple leaderboards | Challenge, strategy, data source, duration, horizon, bar interval, player mode and dataset categories |
| Simple strategies | Buy/sell editor, AND/OR, rolling/accumulating indicators, comparisons/crossings, persistence and order settings |
| Historical trading | Updates between decision bars, executed-volume counters, recorded trade tape and honest missing-data states |
| Portfolio challenge | 30 adjusted-price assets, random one-year window, full 30/45/60/90 seconds per daily/weekly allocation round |
| Daily portfolio | Account-based UI, protected server functions, deadlines, compounding and scheduled price ingestion |
| Historical backtest | Fast single-player runs using Python/R/Simple; pause/stop and equity-curve CSV |
| Bot behaviours | Six new agent types, intraday participation segments, persistent multi-day regimes and existing random events |
| RL arena | Two independent copies of the current DQN, background liquidity, solo/hosted spectators, optional learning/checkpoint export |
| Longer trading | 1/5/10/20/60 trading days; 10/15/20/30/45/60/90/120 real minutes; 5/10/15-minute decision bars |

Owner activation remains: add your real donation link, prepare real market data, and activate the Supabase migration/data publisher. Included datasets are explicitly synthetic. Production services have not been changed here.

## Install

1. Copy/merge these files into the repository root. Serve `index.html` through HTTP or your existing GitHub Pages deployment.
2. Preserve any real donation settings and merge `data/manifest.json` with your existing entries.
3. For a fresh install, apply `20261028_markets_v2.sql` then `20261028_markets_v3.sql`. If v2 is already deployed, apply only the v3 migration. Configure the daily publisher below if using live portfolios.
4. Publish using your normal process and smoke-test two browsers/devices.

```bash
python3 -m http.server 8000
```

The frontend remains static ES modules; no npm build is required. Node 22+ runs the core tests. Python 3.10+ runs the preparation tools.

## Donations

Start with a PayPal Business support/donation link. PayPal supports contributions to for-profit and nonprofit businesses; normal account payment fees apply. Use GoFundMe if you want a public, finite server-funding campaign. Add Patreon when recurring memberships and regular supporter updates make sense. Current provider details and the account setup steps are in [DONATIONS.md](DONATIONS.md).

Edit `src/config/app-config.js`: paste your verified HTTPS provider link into `donations.url`, set `provider` and `recipient`, and optionally populate `donations.channels`. Empty alternatives stay hidden. No account numbers, payment secrets or credentials belong in this file. The provider's verified receiving account/beneficiary controls where the money goes. Until a real link is supplied, Support says it is coming soon.

Contributions are described as funding planned server space/domain, database/caching/speed and larger lobbies. This update does not purchase infrastructure or change public-room capacity.

## Longer trading and backtests

Private/solo challenges offer 1, 5, 10, 20 or 60 active trading sessions and 10, 15, 20, 30, 45, 60, 90 or 120 real minutes. Defaults remain five 09:30–18:00 simulated sessions in about 20 minutes. These are the simulator's existing hours, not an asserted NYSE trading schedule. Historical replay uses each selected session's recorded opening and closing timestamps, compressed over the same active-time axis. Positions/capital persist overnight. Bot cohorts do not multiply at each open.

| Decision bars | Bars in 5 sessions | Bars in 20 sessions | Bars in 60 sessions |
| --- | ---: | ---: | ---: |
| 5 minutes | 510 | 2,040 | 6,120 |
| 10 minutes | 255 | 1,020 | 3,060 |
| 15 minutes | 170 | 680 | 2,040 |

The book, tape, clock and PnL update between completed bars. Strategy observations and chart history advance only when a full decision bar is observed. Internal simulation still uses 15-second steps, with bounded recent bot history. Timed pulses do a bounded amount of work; a suspended/slow host extends elapsed time instead of dropping unseen market steps.

Multi-day timed runs count strategy computation within their nominal clock. Slow strategies/network delays can extend a session. The setup displays the real seconds available per decision bar; select a longer duration or coarser bars if needed. Long challenges still depend on the host browser; persistent save/resume for a trading run is not included.

Fast historical backtests keep their initial opening decision, Python/R/Simple API, 60-second decision ceiling, pause/stop and equity CSV. They repeat the first requested sessions unless a recorded start date is supplied. A stopped run is not submitted as a completed score.

Public matchmaking keeps the original one-day, 10-minute discretionary schedule. Longer windows apply to solo/private-hosted trading, arena and historical backtests.

## Simple rules

Choose Algorithmic → Simple rules in the Algo Lab. Separate Buy and Sell blocks support:

- AND/OR conditions and comparisons to a number or another indicator.
- Price, mean, population standard deviation, RSI, summed volume, return %, cash and shares held.
- >, ≥, <, ≤, Around, Crosses above and Crosses below.
- Rolling windows of 1–200 observed bars or accumulating statistics since the start.
- Consecutive matches, K matches in the last N rounds, or K total matches since the start.
- Fixed shares, % of available cash, or % of the current long position.
- Market orders or limit offsets from mid in basis points, cooldowns and optional cancellation of working orders.

Rolling RSI uses Wilder smoothing; accumulating RSI uses all observed gains and losses. Lifetime hit conditions remain satisfied once their threshold is reached. Crossings compare successive decision observations. Warmup/missing volume produces no signal. Simultaneous Buy and Sell signals are skipped. Capital and fills still go through the trading engine.

Simple JSON files can be imported, and drafts are stored separately from Python/R drafts. The validation run resets state before the actual game.

## Historical trading data

Data stays in `data/`. To use `src/data/`, move the directory and change `APP_CONFIG.dataManifest` to `./src/data/manifest.json`. Manifest paths are relative to the manifest, including on GitHub Pages subpaths.

Add to the manifest's `orderbooks` array:

```json
{"id":"your-book","label":"Your recorded orderbook","path":"orderbooks/your-book.json","demo":false}
```

Example dataset:

```json
{
  "version":1,"kind":"orderbook","symbol":"YOUR_ASSET / USD","currency":"USD","demo":false,
  "frames":[
    {"timestamp":"2024-01-03T09:30:00Z","bids":[{"price":99.98,"qty":250}],"asks":[{"price":100.02,"qty":200}],"volume":0},
    {"timestamp":"2024-01-03T09:35:00Z","bids":[{"price":100.00,"qty":180}],"asks":[{"price":100.04,"qty":210}],"volume":1200}
  ]
}
```

Use full, uncrossed snapshots, increasing ISO timestamps with explicit timezone, positive whole-share quantities and USD prices in cents. Optional `sessionDate` assigns an exchange session; otherwise UTC dates identify sessions. Optional `volume` is a nonnegative whole-share traded quantity since the previous snapshot, not displayed depth or a cumulative daily total. Convert cumulative source volume into increments before import. Without volume, the strategy API and UI mark it unavailable and Simple volume conditions cannot fire.

For a trade tape, include `trades: [{"price":100.02,"qty":120,"side":"BUY"}]` on a frame. Side is the aggressor: BUY, SELL or UNKNOWN. These are all prints in that frame's interval; if `volume` is also present, it must equal their summed quantities. Use `trades: []` for an interval with no prints. Prices are positive USD cents; quantities are positive whole shares. The tape displays the snapshot timestamp, not invented intra-interval times. Trade-only snapshots derive volume from those prints.

The selected 5/10/15-minute bars are measured on the simulator’s normalised 8.5-hour active-session axis; source timestamps identify the actual exchange observations. Sessions of different recorded lengths are each compressed into that axis. This is snapshot replay, not an exchange-calendar bar engine.

Recorded prints are display/volume observations, not synthetic matching-engine fills. They do not move player capital or enter the normal TRADE event channel. If only interval volume is supplied, the tape shows an interval total with no invented price or buy/sell classification. Day/run counters include every supplied print even though the tape shows only the latest 12 rows.

The chooser selects 1/5/10/20/60 whole sessions and rejects insufficient coverage. Included synthetic demos supply five sessions with 15-second snapshots and 20 sessions with one-minute snapshots. The 60-day option requires your own sufficiently long dataset. Each demo session has independent prices, changing spreads/depth and explicit synthetic prints; no daily book pattern is copied. All crossed snapshots, including intermediate bracket triggers, are processed. The last bar of a day stops at that day’s close; it never reveals tomorrow’s opening quote. Player limits survive refreshes; accounts mark to recorded mid. Replay approximates execution without original exchange queues, unseen trades, latency or hypothetical market impact. Yahoo daily OHLC data is not historical bid/ask depth; supply an appropriate depth source.

### Why a historical book can look flat

A depth ladder shows shares currently resting at each price. Executed volume is a different quantity: orders can trade and be replaced while aggregate depth stays similar. Liquid markets can have stable best prices/depth for a time, but identical sizes throughout every session are also a sign of sparse/duplicated snapshots or synthetic demo construction. The previous included demo reused a daily depth pattern and the UI refreshed at decision bars; both issues are addressed in v3.

The replay now shows its typical source cadence. If a real source supplies only five-minute snapshots, the app cannot observe the missing intra-interval additions/cancellations or individual trades. Load denser quote snapshots and actual prints for finer activity. Real history is not randomly perturbed to create motion. Historical quote/depth and trade feeds are distinct data products; see [NYSE's historical market-data description](https://www.nyse.com/market-data/historical). Intraday participation patterns also vary; see [NYSE's opening-volume analysis](https://www.nyse.com/data-insights/opening-auction-filling-behaviors-opportunities-early-in-the-day).

## Historical portfolio challenges

Every allocation round now receives a full 30 seconds by default; 45/60/90 seconds are available. The total duration is calculated from the randomly selected year and decision stride, rather than compressing all rounds into 10–20 minutes. For a typical 252-interval year, weekly decisions take 51 rounds (25.5 minutes at 30 seconds) and daily decisions take 252 rounds (126 minutes). The selected window’s exact round count and planned duration appear in the challenge header. A delayed host starts a fresh full allocation period after settling one round; it does not rush through missed rounds. The Save bar stays available while scrolling and the timer highlights the last ten seconds.

The one-year portfolio flow uses $10,000, 30 USD assets, long-only fractional positions, no fees/leverage, and 0% cash return. Save at most 100% in target weights. Unallocated capital remains cash. Saved percentages rebalance at round boundaries until changed; unsaved edits do not execute.

The host selects the same random start and one-calendar-year anniversary for everybody. Both dates must exist for all assets; February 29 maps to February 28 the next year. Weekly rounds span five trading dates, plus a partial final round where required. Daily rounds use one interval. Drawdown includes intervening daily values. The benchmark buys all assets equally and holds for the year.

Prepare Yahoo CSVs with `Date` and `Adj Close`, one symbol per file from `data/portfolio/universe.json`:

```bash
python3 tools/prepare-yahoo.py --csv-dir data/yahoo-raw
```

Optional download:

```bash
python3 -m pip install yfinance
python3 tools/prepare-yahoo.py --download --start 2015-01-01 --end 2026-10-29
```

The end is exclusive. The script intersects complete daily dates, does not backfill from the future or substitute raw Close, writes `data/portfolio/yahoo-30.json`, and updates the manifest while preserving other entries. Several years provide many random annual windows.

Yahoo access/licensing and third-party download availability can change. Obtain suitable rights before publishing vendor data. A fixed present-day universe also introduces selection/survivorship bias in earlier periods.

## Activate daily portfolios

The existing public Supabase configuration remains in `src/services/leaderboard-api.js`. Never put a secret/service-role key in frontend code.

1. Apply `supabase/migrations/20261028_markets_v2.sql` then `supabase/migrations/20261028_markets_v3.sql` through your Supabase deployment workflow/SQL editor. It adds new `tm_*` tables/functions and leaves the old leaderboard RPCs in place.
2. Enable the email/password Auth settings you want and allow the deployed `live-portfolio.html` redirect URL. Linking an existing anonymous account requires manual linking and email verification before setting its password.
3. Add repository variable `TM_SUPABASE_URL` with that same project URL.
4. Add repository secret `TM_SUPABASE_SERVICE_ROLE_KEY`, using a backend `sb_secret_...` key or legacy service_role JWT. This is used only by the trusted publisher.
5. Run the Daily portfolio market data workflow manually once to publish calendar/price observations.
6. Set repository variable `TM_LIVE_PM_ENABLED` to `true` to enable its weekday 22:35 UTC schedule. This is an application data job, not a ChatGPT reminder.

Trusted-host command:

```bash
python3 -m pip install -r tools/live-data-requirements.txt
python3 tools/update-live-data.py --download --publish
```

Or omit `--download` and use `--portfolio-data PATH` for prepared real Yahoo data. `--output FILE` prepares a non-secret payload without publishing. The job uses XNYS exchange sessions, including holidays, daylight saving and early closes, rejects synthetic data, and excludes sessions whose exchange close has not occurred.

Daily weights lock at the previous exchange close and earn close-to-close returns at the next trading close. Players cannot choose weights after part of that return is known. Only periods beginning after joining apply. Weights carry forward and rebalance daily; cash earns 0%.

Server functions own account IDs, deadlines, values and settlement. Each return vector is frozen from two price rows in the same adjustment snapshot to avoid inconsistent dividend/split bases. Settlement is safe to repeat and does not skip missing return periods. The publisher settles everybody after data arrives; state refresh can also catch up one account, up to 400 missed periods per call.

A guest portfolio remains tied to its saved browser session. Sign in or link a verified email to use the same portfolio on another device. Live standings show starting dates because account ages can differ.

## Leaderboards and RL arena

The new leaderboard filters challenge, strategy, source, horizon, bars, duration, players, portfolio round size and dataset. Backtests have their own category. Demo IDs are distinct. Completed runs save on the device; a backend with both migrations issues a run ticket with fixed dimensions and checks minimum elapsed time before accepting timed scores. Shared boards show each user's best result. The end-game notice identifies device versus shared storage. Use Rules version → Previous (v2) to inspect the previous categorized boards; their keys and scores are preserved. New v3 keys also separate portfolio round seconds and the simulation-v3 generation. Original pre-v2 boards remain at `leaderboard-legacy.html`. Portfolio completion checks use a conservative lower bound from the annual interval count and round clock, rather than the unrelated trading-duration selector.

Trading/backtest community scores remain client-reported; historical dates are shown and can differ. Daily results come from server settlement. Public repository datasets and a browser-controlled WebRTC host do not hide future prices from determined participants.

Watch the RL arena in solo or a hosted room. Two independent copies of the same shipped/current DQN trade with background liquidity. Spectators have no order ticket. Evaluation disables weight updates; optional learning updates each copy independently. Checkpoints can be downloaded. Arena training does not replace the published brain or upload arena experience to the shared nightly trainer.

## Bot behaviours and regimes

The 1,000-agent starting mix retains market makers, noise/limit providers and the existing strategies while adding:

- TWAP parent orders: staggered slices of a bounded session target.
- VWAP schedule execution: a U-shaped expected volume profile, not future realised volume.
- Fundamental investors: patient orders around heterogeneous, noisy fair-value estimates.
- Breakout traders: prior-range breaks with observed-volume confirmation and exits.
- Order-flow traders: signed executed-flow/imbalance signals, short expiries and inventory exits.
- Risk managers: smaller targets in high volatility, partial deleveraging in stress and near the close.

Opening discovery, midday quieter trading, the existing US-overlap event and closing rebalancing change participation/liquidity. Balanced, directional, range, stress and recovery regimes can persist across days and weeks, with occasional intraday transitions. Makers still respect inventory controls and a liquidity floor; long-run population drift is bounded. New execution agents have finite position limits, cancel stale child orders and reset their session targets without pretending unfilled shares executed.

Existing earnings, macro, fund-flow, rumour and liquidity events remain. This is a stylised market simulation, not an empirical calibration or a guarantee of realistic trading profits. Compare spread/depth, trade sizes, return autocorrelation, tails, volatility clustering and inventory paths with suitable real data before further tuning. Normality is not a realistic target for all horizons.

```bash
node tools/market-check.mjs --days 50 --seed review
```

Five independent seeded diagnostic days showed a 5.85-cent average spread, zero empty/wide-book collapses, return lag-1 autocorrelation 0.016 and absolute-return lag-1 autocorrelation 0.225. A separate continuous ten-day run completed 340 15-minute bars without empty book sides; recent bot history remained bounded. These small smoke samples are implementation checks, not calibration evidence. Rare jumps still produce substantial excess kurtosis.

## Validation

```bash
npm test
npm run test:integration
python3 -m unittest discover -s tests -p 'test_*.py'
```

Passed: 50 JavaScript core tests, 6 Python tests and 12 isolated app integration scenarios. The supplied `tests/integration.mjs` harness uses a mock DOM/transport and selected UI/service stubs; it exercised routing, allocation ownership/carryover, completed backtests and actual RL startup. Run `python3 tools/build-test-dom.py` after HTML edits to refresh its fixture. JavaScript syntax, HTML IDs and the real simulated bot fleet were checked.

`tests/database-v2.sql` and `tests/database-v3.sql` supply rollback-based tests for an isolated Supabase database after migration: permissions, ownership, deadline rejection, compounding, cash and idempotence, prior board compatibility, allocation clocks and early score rejection. PostgreSQL, real online Yahoo downloads, production Supabase mutations, live broker connections and full browser rendering were not executed here.

Before release, test all themes/mobile sizing, Python/R/Simple, two-device trading/arena observation, a full portfolio challenge, daily sign-in/linking, cutoff boundaries, a delayed data day and repeated settlement.

## Primary references

- Supabase functions: https://supabase.com/docs/guides/database/functions
- Supabase anonymous accounts/linking: https://supabase.com/docs/guides/auth/auth-anonymous
- Supabase API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Exchange calendars: https://github.com/gerrymanoim/exchange_calendars
- Yahoo downloads: https://help.yahoo.com/kb/sln2311.html
- Pyodide: https://pyodide.org/en/stable/usage/downloading-and-deploying.html
- webR: https://docs.r-wasm.org/webr/latest/downloading.html

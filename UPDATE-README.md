# Tomorrow Markets — version 2

Merge this source package into your existing repository, preserving your Git settings, other workflows and any real datasets/configuration you have added. It combines public source commit `e1e0592a29ac7444dc5a9633734841f800635e67`, the earlier historical/portfolio update, and the changes below.

## Implemented

| Request | Result |
| --- | --- |
| Donations | Support buttons, recipient/link configuration, and planned hosting/domain/database/speed/lobby copy |
| Consistent colours | Main lobby actions share one accent; readable gold fills in the light theme |
| Algorithmic layout | Manual order ticket removed from view; positions and strategy activity remain |
| Multiple leaderboards | Challenge, strategy, data source, duration, horizon, bar interval, player mode and dataset categories |
| Simple strategies | Buy/sell editor, AND/OR, rolling/accumulating indicators, comparisons/crossings, persistence and order settings |
| Historical trading | Whole-session orderbook replay and optional recorded volume |
| Portfolio challenge | 30 adjusted-price assets, random one-year window, daily/weekly rounds in 10/15/20 minutes |
| Daily portfolio | Account-based UI, protected server functions, deadlines, compounding and scheduled price ingestion |
| Historical backtest | Fast single-player runs using Python/R/Simple; pause/stop and equity-curve CSV |
| Bot events | Earnings, macro, flow, rumour and liquidity events with bounded, fading effects |
| RL arena | Two independent copies of the current DQN, background liquidity, solo/hosted spectators, optional learning/checkpoint export |
| Five-day trading | Default 20-minute week; 5/10/15-minute chart/decision bars and 15-second internal simulation |

Owner activation remains: add your real donation link, prepare real market data, and activate the Supabase migration/data publisher. Included datasets are explicitly synthetic. Production services have not been changed here.

## Install

1. Copy/merge these files into the repository root. Serve `index.html` through HTTP or your existing GitHub Pages deployment.
2. Preserve any real donation settings and merge `data/manifest.json` with your existing entries.
3. Apply the supplied Supabase migration and configure the daily publisher below.
4. Publish using your normal process and smoke-test two browsers/devices.

```bash
python3 -m http.server 8000
```

The frontend remains static ES modules; no npm build is required. Node 22+ runs the core tests. Python 3.10+ runs the preparation tools.

## Donations

Edit `src/config/app-config.js`: set `donations.url` to your own HTTPS PayPal.Me/hosted payment link, GoFundMe fundraiser or another provider page, then set the displayed provider and recipient. The provider controls the receiving account/beneficiary. The app collects no payment credentials. Until configured, Support says the link is coming soon.

The copy says contributions will help fund dedicated server space and a domain, database storage/caching and faster loading, and larger lobbies. These are planned improvements; the patch does not purchase infrastructure or change the public-room capacity.

## Five-day trading and backtests

New private/solo trading defaults to five 09:30–18:00 sessions in about 20 real minutes. Positions and capital carry across days. Temporary cohorts leave overnight; the base population is not duplicated.

| Bar interval | Bars per session | Bars in five sessions |
| --- | ---: | ---: |
| 5 minutes | 102 | 510 |
| 10 minutes | 51 | 255 |
| 15 minutes | 34 | 170 |

The simulator still advances in 15-second microsteps, preserving bot reaction/expiry units. The chart uses a compressed active-session axis labelled Day 1–5. Historical clocks display the recorded timestamps and skip idle overnight gaps.

Five-day live sessions count computation time within the nominal clock and cap strategy decisions according to their bar interval. Slow code, network delays or a suspended host can extend a session. Fast backtests run as quickly as their strategies finish, with a 60-second per-decision ceiling. Choose Historical backtest, then Algorithmic and Python/R/Simple. Backtests repeat the first requested sessions by default; an optional recorded start date selects a fixed window. Pause, stop or export the observed equity curve as CSV. Stops are not submitted as completed leaderboard runs.

Public matchmaking retains the original one-day, 10-minute discretionary format.

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

Use full, uncrossed snapshots, increasing ISO timestamps with explicit timezone, positive whole-share quantities and USD prices in cents. Optional `sessionDate` assigns an exchange session; otherwise UTC dates identify sessions. Optional `volume` is actual traded quantity since the previous snapshot, not displayed depth. Without volume, the strategy API marks it unavailable and Simple volume conditions cannot fire.

The chooser selects 1 or 5 whole sessions. The example has five synthetic sessions. All crossed snapshots, including intermediate bracket triggers, are processed. Player limits survive refreshes; accounts mark to recorded mid. Replay approximates execution without original exchange queues, unseen trades, latency or hypothetical market impact. Yahoo daily OHLC data is not historical bid/ask depth; supply an appropriate depth source.

## Historical portfolio challenges

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

1. Apply `supabase/migrations/20261028_markets_v2.sql` through your Supabase deployment workflow/SQL editor. It adds new `tm_*` tables/functions and leaves the old leaderboard RPCs in place.
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

The new leaderboard filters challenge, strategy, source, horizon, bars, duration, players, portfolio round size and dataset. Backtests have their own category. Demo IDs are distinct. Completed runs save on the device; a configured v2 backend issues a run ticket with fixed dimensions and checks minimum elapsed time before accepting timed scores. Shared boards show each user's best result. The end-game notice identifies device versus shared storage. Original boards remain at `leaderboard-legacy.html`.

Trading/backtest community scores remain client-reported; historical dates are shown and can differ. Daily results come from server settlement. Public repository datasets and a browser-controlled WebRTC host do not hide future prices from determined participants.

Watch the RL arena in solo or a hosted room. Two independent copies of the same shipped/current DQN trade with background liquidity. Spectators have no order ticket. Evaluation disables weight updates; optional learning updates each copy independently. Checkpoints can be downloaded. Arena training does not replace the published brain or upload arena experience to the shared nightly trainer.

## Bot realism and calibration

Random earnings, macro, fund-flow, rumour and liquidity events add bounded fair-value shocks and fading volatility/depth effects. Makers retain inventory controls, and signed aggressor flow now reaches the RL observations.

For further tuning, compare multiple seeds with real data for spread/depth, trade sizes, return autocorrelation, tails, volatility clustering and inventory behaviour. Preserve opening/closing activity patterns and avoid predictable announcement drifts. A Gaussian return distribution is not the target.

```bash
node tools/market-check.mjs --days 50 --seed review
```

Three seeded smoke-test days produced excess kurtosis 4.52, lag-1 absolute-return autocorrelation 0.226, and no empty/wide-book collapses under that diagnostic. This small sample checks implementation and is not empirical calibration.

## Validation

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
```

Passed: 34 JavaScript core tests, 6 Python tests and 9 isolated app integration scenarios. The integration harness used a mock DOM/transport and selected UI/service stubs; it exercised routing, allocation ownership/carryover, completed backtests and actual RL startup. JavaScript syntax, HTML IDs and the real simulated bot fleet were checked.

`tests/database-v2.sql` supplies rollback-based tests for an isolated Supabase database after migration: permissions, ownership, deadline rejection, compounding, cash and idempotence. PostgreSQL, real online Yahoo downloads, production Supabase mutations, live broker connections and full browser rendering were not executed here.

Before release, test all themes/mobile sizing, Python/R/Simple, two-device trading/arena observation, a full portfolio challenge, daily sign-in/linking, cutoff boundaries, a delayed data day and repeated settlement.

## Primary references

- Supabase functions: https://supabase.com/docs/guides/database/functions
- Supabase anonymous accounts/linking: https://supabase.com/docs/guides/auth/auth-anonymous
- Supabase API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Exchange calendars: https://github.com/gerrymanoim/exchange_calendars
- Yahoo downloads: https://help.yahoo.com/kb/sln2311.html
- Pyodide: https://pyodide.org/en/stable/usage/downloading-and-deploying.html
- webR: https://docs.r-wasm.org/webr/latest/downloading.html

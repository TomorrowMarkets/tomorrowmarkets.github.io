## Tomorrow Markets — Patch Notes
**Version 1.0**

### Core engine
- 15-level limit order book with a full order matching engine and bot-driven liquidity
- Order types: limit, market, stop-loss/take-profit, with account view, position sizing, current value, and an order overview with delete support

### Multiplayer

- Initial multiplayer setup, later reworked so each participant's client shares the processing load instead of one node carrying it all
- Lobby UI with leaderboard, laying the groundwork for multiple concurrent games

### Charts & analysis

- Multi-timeframe charts: 1-minute, 5-minute, 1-hour, and full-day views
- Built-in features, indicators, and basic trading signals

### Trading logic fixes

- Corrected short selling, buying, inventory tracking, and limit order handling
- Multiplayer sync issues resolved

### Bots & modes

- Basic bot behaviours, then iterated multiple times: corrected existing behaviours, added randomised participation windows, and introduced 3 new behaviour types
- Reinforcement-learning bot added
- Discretionary vs. Algorithmic modes, available in both single-player and multiplayer

### Scripting

- Python and R support for algorithmic trading, plus Pine Script and a custom TMRW user language

### Architecture

- Externalised core systems so individual pieces can be updated independently
- UI/UX overhaul and general design pass

### Still in progress for 1.0

- Eye-strain feedback fix: rolling out white, black (low-eyestrain), and navy themes
- Randomised trader usernames so players aren't all "trader_1"
- Public lobbies: auto-filling rooms of 10 recurring random players

## Version 1.0.x (maintenance)
- 1.0.1: bugfixes
- 1.0.2+: minor UI polish, quality-of-life tweaks, small bugfixes

## Version 1.1 (planned)

### Scripting

- Add Pine Script and MATLAB as supported languages for algorithmic trading

### New game modes

- The Blind Quant — backtest your algo on 3 days of data, then run it live against the following day
- The PM Battle — allocate across 10 assets, pick 5 with target weightings, 10 rounds over 20 minutes
- The Trader — single-market trading, with variants: Hardcore (trading fees), Multiplayer, and Ultimate (5 markets at once)

### Bot behaviour overhaul (again)

- Fix exploitable, deterministic drift on US session open
- Rework last-hour behaviour, which is currently too aggressively mean-reverting
- Allow legitimate open/close/high/low touches instead of always flagging "high/low outside candle"
- Make volatility cyclical rather than persistently elevated
- Model low-participation periods as a real, recurring phenomenon
- Better probability weighting across flat/drift/jump/mean-reversion states at the US open
- More realistic end-of-day behaviour: mean reversion, aggressive closes, participation drop-off

## Version 1.2 (future)
- Larger multiplayer lobbies (may require moving off GitHub Pages to your own infrastructure)
- Performance optimisation; possible paid web domain
- Mixed-mode matches
- Predetermined "map" datasets (OHLCV and L3)

## Version 1.3 (future)
- Multi-asset matches
- Derivatives market matches




## Leaderboard keys
https://jpsdqawilipmsineoufz.supabase.co \
sb_publishable_Rzvy0JUEksDPLELwB2UJkQ_Sf4ELYPJ

## Bot keys
https://iwmqwqguisduqwnsdbyj.supabase.co \
sb_publishable_x-5rCxKoGiy7bGouB23uAQ_7w_eUMaW

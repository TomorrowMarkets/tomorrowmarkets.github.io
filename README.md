
These patch notes are to be taken with a grain of salt, as I will have to very publicly and very obviously explain that these are not going to be the public patch notes.
I have made considerable reflections, developments and feature designs in advance and none of these will go up in the noted order as "content sharing" is more important
in order for me to grab a hold of an audience on social media before actually implementing the work and features I myself desire.


## Tomorrow Markets — Patch Notes
**Version 1.0**
The goal was to add the core gameplay and game setup, such that players could genuinely participate in playing traders in the markets, while having the opportunity to do algorithmic trading as well as just simply playing against their mates in a trading competition.

### Core engine
- 15-level limit order book with a full order matching engine and bot-driven liquidity
- Order types: limit, market, stop-loss/take-profit, with account view, position sizing, current value, and an order overview with delete support

### Multiplayer
- Initial multiplayer setup, later reworked so each participant's client shares the processing load instead of one node carrying it all
- Lobby UI with leaderboard, laying the groundwork for multiple concurrent games
- Public lobbies: auto-filling rooms of 10 recurring random players

### Charts & analysis
- Multi-timeframe charts: 1-minute, 5-minute, 1-hour, and full-day views
- Built-in features, indicators, and basic trading signals
  - Simple moving averages, volume and beyond.
- Added PnL to each algo trade and history 

### Trading logic fixes
- Corrected short selling, buying, inventory tracking, and limit order handling
- Multiplayer sync issues resolved
- Added Stoploss and Take-profit. Editting live orders.

### Bots & modes
- Basic bot behaviours, noise bot, basic MR bot, basic Trend bot, basic whale bot. *Quickly discarded because jesus fuk these bots are dumb*
- Bot behaviours version 2. Throw the fucking kitchen sink at it! 15 different versions of either "noise", "MR", "trend" or "whale". *corrected existing behaviours*
- Bot behaviours version 3. Electric boogaloo, let us add regimes within the day. *added randomised participation windows*
- Reinforcement-learning bot added. *This is a feature just for me, to actually make this entertaining for an algorithmic trading looking to setup a firm*
- Discretionary vs. Algorithmic modes, available in both single-player and multiplayer. *This is the core feature of the game*

### Scripting
- Python and R support for algorithmic trading

### Architecture
- Externalised core systems so individual pieces can be updated independently, *this also gives space for optimisation of components.*
- UI/UX overhaul and general design pass, added different layouts for original layout and 2 dark modes for ease on eyes.


### User experience
- **Eye-strain feedback fix:** rolling out white, black (low-eyestrain), and navy themes
- Randomised trader usernames so players aren't all "trader_1", *this will make players recognise themselves and actually pick a name.*
- Added "loading screen notes" for each player to have something silly to do while waiting for a game to start. *I want each part of the experience to be entertaining.*

## Version 1.0.x (maintenance)
These patches have already been predetermined to be patch fix notes.
- 1.0.1: bugfixes
- 1.0.2+: minor UI polish, quality-of-life tweaks, small bugfixes



## Version 1.1 (planned)

### Scripting
- Add Pine Script and MATLAB as supported languages for algorithmic trading
- Designing a custom TMRW user language for Algorithmic trading, so it will be easier to slap ideas into the engine and go.

### New game modes
- multiplayer, public lobby, mixed lobby with algorithmic trading designed and overhauled completely.
- The Blind Quant — backtest your algo on 3 days of data, then run it live against the following day
- The PM Battle — allocate across 10 assets, pick 5 with target weightings, 10 rounds over 20 minutes
- The Trader — single-market trading, with variants: Hardcore (trading fees), Multiplayer, and Ultimate (5 markets at once)

### Bot behaviour overhaul (again)
The combined and separate bot behaviours need another overhaul, this should be another tiny step on the way to updating bot behaviours.
- Fix exploitable, deterministic drift on US session open
- More realistic end-of-day behaviour: mean reversion, aggressive closes, participation drop-off
- Rework last-hour behaviour, which is currently too aggressively mean-reverting, there genuinely needs to be a random chance between MR, trend, low participation or high volatilty,
- Allow legitimate open/close/high/low touches instead of always flagging "high/low outside candle"
- Make volatility cyclical rather than persistently elevated
- Model low-participation periods, sudden jumps, self-excitation as a real, recurring phenomenon
- Better probability weighting across flat/drift/jump/mean-reversion states at the open and US open periods.
- Adjust varying volume periods.



### User experience
- Added "switched hands" mode, for left handed players.

## Version 1.2 (future)
- Larger multiplayer lobbies (may require moving off GitHub Pages to your own infrastructure)
- Performance optimisation; possible paid web domain
- Mixed-mode matches
- Predetermined "map" datasets (OHLCV and L3)

## Version 1.3 (future)

### Core Gameplay modes
- Multi-asset matches
- Derivatives market matches

### Bot behaviour overhaul (again)
We need to do an entire research study and bot overhaul from baseline. \ 
Bots should be N > 1000 at all times, but their participation, size, value and more should be the baseline function.\
We want to map them as psychological human beings with chaos in their lives. \
Some ought to be other traders, investors and firms. But the focus should be psychological with a random event instead\
We want to add market events and let those impact the traders, rather than simply doing market events and forcing bots.

### User Experience
- Added "keyboard mode", where each part of the discretionary website can be handled with keyboard only.




## Leaderboard keys
https://jpsdqawilipmsineoufz.supabase.co \
sb_publishable_Rzvy0JUEksDPLELwB2UJkQ_Sf4ELYPJ

## Bot keys
https://iwmqwqguisduqwnsdbyj.supabase.co \
sb_publishable_x-5rCxKoGiy7bGouB23uAQ_7w_eUMaW

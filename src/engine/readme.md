bots.js: every trading strategy, plus TUNING (the dials for how the market behaves) \
BotFleet.js: the trading population, the daily schedule and the market state bots read \
OrderBook.js: the limit order book and matching \
random.js: the engine's random numbers; seed it and the same day plays out again \
simulate.js: runs a whole day with no UI (checks, backtests, generated data)

After changing TUNING or the mix, check the market still behaves: `node tools/market-check.mjs`

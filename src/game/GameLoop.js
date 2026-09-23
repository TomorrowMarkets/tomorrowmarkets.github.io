
// src/game/GameLoop.js
tick() {
  const marketState = {
    clockSeconds: this.clockSeconds,
    durationMinutes: this.durationMinutes,
    midPrice: this.orderBook.getMidPrice()
  };

  // Run all active bot behaviors
  this.bots.forEach(bot => bot.onTick(marketState));
}

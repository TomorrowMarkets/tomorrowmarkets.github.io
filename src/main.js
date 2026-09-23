import { EventBus } from './EventBus.js';
import { AccountManager } from './AccountManager.js';
import { OrderBook } from './engine/OrderBook.js';
import { MarketMakerBot } from './engine/MarketMakerBot.js';
import { NoiseBot } from './engine/NoiseBot.js';
import { TrendBot } from './engine/TrendBot.js';
import { MRBot } from './engine/MRBot.js';
import { WhaleBot } from './engine/WhaleBot.js';

import { BookUI } from './ui/BookUI.js';
import { ChartUI } from './ui/ChartUI.js';
import { ControlsUI } from './ui/ControlsUI.js';
import { PeerNetwork } from './net/PeerNetwork.js';
import { GameLoop } from './game/GameLoop.js';

function initApp() {
  try {
    const eventBus = new EventBus();
    const accountManager = new AccountManager(eventBus, 'Trader_1');
    const orderBook = new OrderBook(eventBus);
    
    let network = null;
    try {
      network = new PeerNetwork(eventBus);
    } catch (e) {
      console.warn('PeerNetwork deferred:', e);
    }

    const bots = [
      new MarketMakerBot('mm_1', 'Sigma Liquidity', orderBook, eventBus),
      new NoiseBot('noise_1', 'Flow Noise', orderBook, eventBus),
      new TrendBot('trend_1', 'Momentum Alpha', orderBook, eventBus),
      new MRBot('mr_1', 'Mean Reversion', orderBook, eventBus),
      new WhaleBot('whale_1', 'Deep Capital', orderBook, eventBus)
    ];

    const gameLoop = new GameLoop(orderBook, bots, network, eventBus);
    const bookUI = new BookUI(eventBus);
    const chartUI = new ChartUI(eventBus);
    const controlsUI = new ControlsUI(eventBus, accountManager);

    let currentUserId = 'Trader_1';

    // Route UI Orders to OrderBook
    eventBus.on('USER_SUBMIT_ORDER', (order) => {
      orderBook.processOrder({
        playerId: currentUserId,
        side: order.side,
        price: order.price,
        qty: order.qty,
        type: order.type
      });
    });

    // Seed Initial Liquidity Depth
    function seedOrderBook() {
      orderBook.processOrder({ playerId: 'mm_1', side: 'BUY', price: 99.80, qty: 50, type: 'LIMIT' });
      orderBook.processOrder({ playerId: 'mm_1', side: 'BUY', price: 99.50, qty: 100, type: 'LIMIT' });
      orderBook.processOrder({ playerId: 'mm_1', side: 'SELL', price: 100.20, qty: 50, type: 'LIMIT' });
      orderBook.processOrder({ playerId: 'mm_1', side: 'SELL', price: 100.50, qty: 100, type: 'LIMIT' });
    }

    function launchDashboard() {
      const lobbyScreen = document.getElementById('lobby-screen');
      const tradingScreen = document.getElementById('trading-screen');

      if (lobbyScreen) lobbyScreen.classList.add('hidden');
      if (tradingScreen) tradingScreen.classList.remove('hidden');

      seedOrderBook();
      gameLoop.start();
    }

    // Attach Lobby Listeners
    const btnSinglePlayer = document.getElementById('btn-single-player');
    const btnHostMultiplayer = document.getElementById('btn-host-multiplayer');

    if (btnSinglePlayer) {
      btnSinglePlayer.addEventListener('click', () => {
        const input = document.getElementById('trader-name-input');
        if (input && input.value.trim()) {
          currentUserId = input.value.trim();
          accountManager.setPlayerId(currentUserId);
        }
        launchDashboard();
      });
    }

    if (btnHostMultiplayer) {
      btnHostMultiplayer.addEventListener('click', () => {
        const input = document.getElementById('trader-name-input');
        if (input && input.value.trim()) {
          currentUserId = input.value.trim();
          accountManager.setPlayerId(currentUserId);
        }
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        if (network && typeof network.initHost === 'function') {
          network.initHost(roomCode);
        }
        launchDashboard();
      });
    }

  } catch (err) {
    console.error('Initialization error in main.js:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

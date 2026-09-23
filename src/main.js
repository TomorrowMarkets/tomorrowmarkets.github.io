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
    const accountManager = new AccountManager(eventBus);
    const orderBook = new OrderBook(eventBus);
    
    let network = null;
    try {
      network = new PeerNetwork(eventBus);
    } catch (e) {
      console.warn('PeerNetwork initialization deferred:', e);
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

    let currentUserId = 'Player_1';

    eventBus.on('USER_SUBMIT_ORDER', (order) => {
      orderBook.processOrder({
        playerId: currentUserId,
        side: order.side,
        price: order.price,
        qty: order.qty,
        type: order.type
      });
    });

    function launchDashboard() {
      const lobbyScreen = document.getElementById('lobby-screen');
      const tradingScreen = document.getElementById('trading-screen');

      if (lobbyScreen) lobbyScreen.classList.add('hidden');
      if (tradingScreen) tradingScreen.classList.remove('hidden');

      gameLoop.start();
    }

    // Attach Lobby Event Listeners
    const btnSinglePlayer = document.getElementById('btn-single-player');
    const btnHostMultiplayer = document.getElementById('btn-host-multiplayer');

    if (btnSinglePlayer) {
      btnSinglePlayer.addEventListener('click', () => {
        const input = document.getElementById('trader-name-input');
        if (input && input.value.trim()) {
          currentUserId = input.value.trim();
        }
        launchDashboard();
      });
    }

    if (btnHostMultiplayer) {
      btnHostMultiplayer.addEventListener('click', () => {
        const input = document.getElementById('trader-name-input');
        if (input && input.value.trim()) {
          currentUserId = input.value.trim();
        }
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        if (network && typeof network.initHost === 'function') {
          network.initHost(roomCode);
        }
        launchDashboard();
      });
    }

  } catch (err) {
    console.error('Fatal initialization error in main.js:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

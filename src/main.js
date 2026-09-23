// src/main.js
import { EventBus } from './EventBus.js';
import { AccountManager } from './AccountManager.js';
import { OrderBook } from './engine/OrderBook.js';
import { BaseBot } from './engine/BaseBot.js';
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

// Central Event Dispatcher & Core Managers
const eventBus = new EventBus();
const accountManager = new AccountManager(eventBus);
const orderBook = new OrderBook(eventBus);
const network = new PeerNetwork(eventBus);

// Instantiate Trading Bots
const bots = [
  new MarketMakerBot('mm_1', 'Sigma Liquidity', orderBook, eventBus),
  new NoiseBot('noise_1', 'Flow Noise', orderBook, eventBus),
  new TrendBot('trend_1', 'Momentum Alpha', orderBook, eventBus),
  new MRBot('mr_1', 'Mean Reversion', orderBook, eventBus),
  new WhaleBot('whale_1', 'Deep Capital', orderBook, eventBus)
];

// Initialize Game Engine Loop & UI
const gameLoop = new GameLoop(orderBook, bots, network, eventBus);

const bookUI = new BookUI(eventBus);
const chartUI = new ChartUI(eventBus);
const controlsUI = new ControlsUI(eventBus, accountManager);

console.log("Tomorrow Markets initialized in modular architecture.");

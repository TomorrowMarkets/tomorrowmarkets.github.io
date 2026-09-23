
// src/main.js
import { OrderBook } from './engine/OrderBook.js';
import { BookUI } from './ui/BookUI.js';
import { ChartUI } from './ui/ChartUI.js';
import { ControlsUI } from './ui/ControlsUI.js';
import { PeerNetwork } from './net/PeerNetwork.js';
import { GameLoop } from './game/GameLoop.js';

// Initialize core components
const orderBook = new OrderBook();
const network = new PeerNetwork();
const gameLoop = new GameLoop();

// Initialize UI views
const bookUI = new BookUI();
const chartUI = new ChartUI();
const controlsUI = new ControlsUI();

console.log("Tomorrow Markets initialized in modular architecture.");

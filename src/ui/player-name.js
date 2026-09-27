// src/ui/player-name.js
// Keeps each player's trader handle between visits (per browser, in
// localStorage) and makes a random one for first-time players:
// FIRST_PARTS + SECOND_PARTS + a two-digit number, e.g. "SteadyOtter42".
//
//   mountHandleField(input, { shuffleButton, clean });
//   rememberHandle(name);   // call when a game starts with that name
//
// Each part is at most 7 characters, so a generated name always fits the
// 16-character limit. Swap in your own lists freely; keep them to letters.

const STORAGE_KEY = 'tomorrowMarkets.handle';

export const FIRST_PARTS = [
  'Jane Street', 'JPM', 'Clever', 'Millennium', 'TwoSigma', 'Citadel', 'Investor', 'Brave',
  'Sharp', 'Patient', 'BridgeWater', 'Golden', 'Cosmic', 'Renaissance', 'Option', 'Warren',
  'Quant', 'Keen', 'Point72', 'Crafty', 'Sunstone', 'Stellar', 'Turbo', 'Mighty',
  'Alpha', 'Lazarus', 'Goldman', 'Bullish', 'Noble', 'Money', 'Candle', 'Lunar'
];

export const SECOND_PARTS = [
  'Capital', 'Falcon', 'Sigma', 'Simons', 'Buffett', 'Tech', 'Owl', 'Investment',
  'Researcher', 'Banker', 'Dolphin', 'Orca', 'Tiger', 'Trade', 'Securities', 'God',
  'Mngt', 'Comet', 'Rocket', 'Trader', 'Broker', 'Quant', 'Bull', 'Bear',
  'Ticker', 'Whale', 'Analyst', 'Fund', 'Jaguar', 'Investor', 'Technologies', 'King'
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function randomHandle(previous = '') {
  let name = previous;
  // Re-roll until it differs from the current one (the shuffle button
  // should always visibly change something).
  for (let i = 0; i < 5 && name === previous; i++) {
    name = `${pick(FIRST_PARTS)}${pick(SECOND_PARTS)}${10 + Math.floor(Math.random() * 90)}`;
  }
  return name;
}

export function savedHandle() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch (err) {
    return ''; // storage blocked (some private modes)
  }
}

export function rememberHandle(name) {
  if (!name) return;
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch (err) { /* storage blocked: the name lasts for this visit only */ }
}

/**
 * Fills the handle input with the saved name (or a fresh random one, which
 * is saved straight away so it stays put on the next visit), saves edits as
 * the player types, and wires the random-name button.
 * `clean` strips disallowed characters and returns '' if nothing is left.
 */
export function mountHandleField(input, { shuffleButton = null, clean = (s) => String(s || '').trim() } = {}) {
  if (!input) return;
  const start = clean(savedHandle()) || randomHandle();
  input.value = start;
  rememberHandle(start);

  input.addEventListener('input', () => {
    const name = clean(input.value);
    if (name) rememberHandle(name); // a blank field keeps the last good name
  });
  input.addEventListener('blur', () => {
    // Left blank: put their saved name back rather than starting as "Trader".
    if (!clean(input.value)) input.value = savedHandle() || randomHandle();
  });

  if (shuffleButton) {
    shuffleButton.addEventListener('click', () => {
      input.value = randomHandle(input.value);
      rememberHandle(input.value);
    });
  }
}

// lobby-facts.js
// A small rotating "Did you know?" card for the waiting-for-players screen.
//
//   import { mountLobbyFacts } from './js/lobby-facts.js';
//   const stopFacts = mountLobbyFacts(document.getElementById('lobby-facts'));
//   // when the game starts:
//   stopFacts();
//
// Facts rotate every 14 seconds in a shuffled order, pause while hovered or
// focused, and can be stepped through with the arrow buttons.

export const LOBBY_FACTS = [
  {
    text: 'The word “algorithm” comes from al-Khwarizmi, a Persian scholar at Baghdad’s House of Wisdom around 825 AD. When his book on Hindu–Arabic numerals was translated into Latin, his name became “Algoritmi”.',
    link: 'https://en.wikipedia.org/wiki/Al-Khwarizmi',
  },
  {
    text: '“Algebra” comes from the title of another al-Khwarizmi book. “Al-jabr” is Arabic for restoring broken parts, and was also used for setting bones. The rest of the title, “al-muqabala”, means balancing: what you do to both sides of an equation.',
    link: 'https://en.wikipedia.org/wiki/Algebra',
  },
  {
    text: 'In 1843 Ada Lovelace published what’s often called the first computer program, for Charles Babbage’s Analytical Engine, a machine that was never built. She also imagined such machines might one day compose music.',
    link: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
  },
  {
    text: 'Before “computer” meant a machine, it was a job. At NASA and its predecessor NACA, teams of women calculated flight paths by hand. In 1962 astronaut John Glenn asked for Katherine Johnson to check the electronic computer’s numbers before his orbit.',
    link: 'https://en.wikipedia.org/wiki/Katherine_Johnson',
  },
  {
    text: 'In 1897 Indiana’s House of Representatives voted 67 to 0 for a bill that implied π equals 3.2. It died in the state Senate, helped by a Purdue maths professor who happened to be visiting the statehouse that day.',
    link: 'https://en.wikipedia.org/wiki/Indiana_pi_bill',
  },
  {
    text: 'Fibonacci’s 1202 book Liber Abaci showed European merchants how much easier their sums were with Hindu–Arabic numerals than Roman ones. The Fibonacci sequence appears in the same book, as a puzzle about breeding rabbits.',
    link: 'https://en.wikipedia.org/wiki/Liber_Abaci',
  },
  {
    text: 'Double-entry bookkeeping, where every trade is recorded twice as a debit and a credit, was first described in print by Luca Pacioli in 1494. He also taught mathematics to Leonardo da Vinci.',
    link: 'https://en.wikipedia.org/wiki/Luca_Pacioli',
  },
  {
    text: '“Bank” comes from the Italian “banca”, the bench where money-changers worked. “Bankrupt” comes from “banca rotta”: a broken bench.',
    link: 'https://en.wikipedia.org/wiki/Bankruptcy',
  },
  {
    text: 'In 1602 the Dutch East India Company sold shares to the public, and Amsterdam traders were soon buying and selling them. It’s often called the first modern stock exchange.',
    link: 'https://en.wikipedia.org/wiki/Dutch_East_India_Company',
  },
  {
    text: 'The New York Stock Exchange traces its start to 1792, when 24 brokers signed an agreement under a buttonwood tree on Wall Street.',
    link: 'https://en.wikipedia.org/wiki/Buttonwood_Agreement',
  },
  {
    text: 'During Holland’s tulip mania in 1637, a single rare bulb was said to sell for the price of a house. Historians now think the craze was smaller than the legend, which is a good reason to check your sources.',
    link: 'https://en.wikipedia.org/wiki/Tulip_mania',
  },
  {
    text: 'Isaac Newton reportedly lost around £20,000 in the South Sea Bubble of 1720, a fortune at the time. Even a genius can get swept up in a market frenzy.',
    link: 'https://en.wikipedia.org/wiki/South_Sea_Company',
  },
  {
    text: 'In 1900 French mathematician Louis Bachelier described stock prices as a random walk, five years before Einstein used similar maths to explain how tiny particles jiggle in water.',
    link: 'https://en.wikipedia.org/wiki/Louis_Bachelier',
  },
  {
    text: 'The stock ticker, invented in 1867, printed prices on long strips of paper. Used ticker tape is how New York’s ticker-tape parades got their name.',
    link: 'https://en.wikipedia.org/wiki/Ticker_tape',
  },
  {
    text: 'In 1906 Francis Galton looked at a contest where about 800 people guessed an ox’s weight. The middle guess was within 1% of the real weight: many opinions combined into one number, a bit like a market price.',
    link: 'https://en.wikipedia.org/wiki/Wisdom_of_the_crowd',
  },
  {
    text: 'In 1956 Bell Labs scientist John Kelly worked out how much to bet when you have an edge. Traders still use the Kelly criterion to decide how big a position to take.',
    link: 'https://en.wikipedia.org/wiki/Kelly_criterion',
  },
  {
    text: 'In the early 1960s mathematician Ed Thorp used probability to beat blackjack, and built a wearable computer with Claude Shannon to predict roulette. Then he took the same thinking to Wall Street.',
    link: 'https://en.wikipedia.org/wiki/Edward_O._Thorp',
  },
  {
    text: 'The Monte Carlo method, which solves hard problems with random simulations, came to Stanisław Ulam while he was playing solitaire in 1946. It’s named after the casino in Monaco.',
    link: 'https://en.wikipedia.org/wiki/Monte_Carlo_method',
  },
  {
    text: 'On 6 May 2010, US stock prices plunged about 9% and mostly recovered within roughly half an hour. It became known as the Flash Crash.',
    link: 'https://en.wikipedia.org/wiki/2010_flash_crash',
  },
  {
    text: 'In 2012 a faulty software release at trading firm Knight Capital sent millions of unintended orders into the market and lost about $440 million in 45 minutes. Algorithmic traders still tell this story as a reason to test code carefully.',
    link: 'https://en.wikipedia.org/wiki/Knight_Capital_Group',
  },
  {
    text: 'On 22 May 2010 programmer Laszlo Hanyecz paid 10,000 bitcoin for two pizzas, the first well-known purchase of real goods with bitcoin. Fans now mark the date as Bitcoin Pizza Day.',
  },
];

const STYLE_ID = 'tm-lobby-facts-styles';

const CSS = `
.tm-facts {
  --tm-facts-ink: var(--ink, #13203f);
  --tm-facts-gold: var(--gold, #b08c3e);
  --tm-facts-muted: var(--muted, #66728a);
  --tm-facts-line: var(--line, #e2e7ef);
  position: relative;
  margin-top: 16px;
  padding: 18px 22px 20px;
  border: 1px solid var(--tm-facts-line);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.6);
  color: var(--tm-facts-ink);
  font-family: var(--sans, 'Inter', system-ui, sans-serif);
  overflow: hidden;
}
.tm-facts__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.tm-facts__label {
  font-family: var(--serif, 'Source Serif 4', Georgia, serif);
  font-size: 17px;
}
.tm-facts__nav { display: flex; align-items: center; gap: 4px; }
.tm-facts__count {
  font-size: 12px;
  color: var(--tm-facts-muted);
  font-variant-numeric: tabular-nums;
  margin-right: 6px;
}
.tm-facts__btn {
  width: 28px;
  height: 28px;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--tm-facts-line);
  border-radius: 7px;
  background: #fff;
  color: var(--tm-facts-ink);
  cursor: pointer;
  padding: 0;
}
.tm-facts__btn:hover { border-color: #c9d1de; }
.tm-facts__btn:focus-visible,
.tm-facts__more:focus-visible { outline: 2px solid var(--tm-facts-gold); outline-offset: 2px; }
.tm-facts__btn svg { width: 14px; height: 14px; }
.tm-facts__body { transition: opacity 220ms ease; }
.tm-facts__body.is-swapping { opacity: 0; }
.tm-facts__text {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.6;
  color: #33405c;
}
.tm-facts__more {
  display: inline-block;
  margin-top: 10px;
  font-size: 13px;
  color: var(--tm-facts-ink);
  text-decoration: underline;
  text-decoration-color: var(--tm-facts-gold);
  text-underline-offset: 3px;
}
.tm-facts__timer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: transparent;
}
.tm-facts__timer span {
  display: block;
  height: 100%;
  width: 100%;
  background: var(--tm-facts-gold);
  opacity: 0.55;
  transform-origin: left center;
  transform: scaleX(0);
  animation: tm-facts-timer var(--tm-facts-interval, 14s) linear forwards;
}
.tm-facts:hover .tm-facts__timer span,
.tm-facts:focus-within .tm-facts__timer span { animation-play-state: paused; }
@keyframes tm-facts-timer { to { transform: scaleX(1); } }
@media (prefers-reduced-motion: reduce) {
  .tm-facts__body { transition: none; }
}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const chevron = (dir) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${dir === 'prev' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * Renders the facts card into `container` and returns a function that
 * removes it. Pass your own `facts` array to override the defaults.
 */
export function mountLobbyFacts(container, { facts = LOBBY_FACTS, intervalMs = 14000 } = {}) {
  if (!container || !facts.length) return () => {};
  injectStyles();

  const order = shuffled(facts);
  let index = 0;
  let swapTimer = null;

  const root = document.createElement('aside');
  root.className = 'tm-facts';
  root.setAttribute('aria-label', 'Fun facts');
  root.style.setProperty('--tm-facts-interval', `${intervalMs}ms`);
  root.innerHTML = `
    <div class="tm-facts__head">
      <span class="tm-facts__label">Did you know?</span>
      <div class="tm-facts__nav">
        <span class="tm-facts__count"></span>
        <button type="button" class="tm-facts__btn" data-dir="prev" aria-label="Previous fact">${chevron('prev')}</button>
        <button type="button" class="tm-facts__btn" data-dir="next" aria-label="Next fact">${chevron('next')}</button>
      </div>
    </div>
    <div class="tm-facts__body" aria-live="off">
      <p class="tm-facts__text"></p>
      <a class="tm-facts__more" target="_blank" rel="noopener noreferrer">Read more on Wikipedia</a>
    </div>
    <div class="tm-facts__timer" aria-hidden="true"><span></span></div>
  `;

  const body = root.querySelector('.tm-facts__body');
  const text = root.querySelector('.tm-facts__text');
  const more = root.querySelector('.tm-facts__more');
  const count = root.querySelector('.tm-facts__count');
  const bar = root.querySelector('.tm-facts__timer span');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function restartTimer() {
    bar.style.animation = 'none';
    void bar.offsetWidth; // reflow so the animation starts again
    bar.style.animation = '';
  }

  function paint() {
    const fact = order[index];
    text.textContent = fact.text;
    if (fact.link) {
      more.href = fact.link;
      more.hidden = false;
    } else {
      more.removeAttribute('href');
      more.hidden = true;
    }
    count.textContent = `${index + 1} of ${order.length}`;
    restartTimer();
  }

  function go(step, { announce = false } = {}) {
    index = (index + step + order.length) % order.length;
    body.setAttribute('aria-live', announce ? 'polite' : 'off');
    clearTimeout(swapTimer);
    if (reduceMotion.matches) {
      paint();
      return;
    }
    body.classList.add('is-swapping');
    swapTimer = setTimeout(() => {
      paint();
      body.classList.remove('is-swapping');
    }, 220);
  }

  // The timer bar's animation drives rotation, so pausing it on hover
  // or focus also pauses the facts.
  // Reserve the height of the longest fact so the lobby doesn't jump around.
  function reserveHeight() {
    body.style.minHeight = '';
    const current = text.textContent;
    const moreHidden = more.hidden;
    more.hidden = false;
    let tallest = 0;
    for (const fact of order) {
      text.textContent = fact.text;
      tallest = Math.max(tallest, body.offsetHeight);
    }
    text.textContent = current;
    more.hidden = moreHidden;
    body.style.minHeight = `${tallest}px`;
  }

  let resizeFrame = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(reserveHeight);
  };

  const onTimerEnd = () => go(1);
  const onClick = (e) => {
    const btn = e.target.closest('.tm-facts__btn');
    if (btn) go(btn.dataset.dir === 'prev' ? -1 : 1, { announce: true });
  };

  bar.addEventListener('animationend', onTimerEnd);
  root.addEventListener('click', onClick);

  container.append(root);
  paint();
  reserveHeight();
  window.addEventListener('resize', onResize);

  return function unmount() {
    clearTimeout(swapTimer);
    cancelAnimationFrame(resizeFrame);
    window.removeEventListener('resize', onResize);
    bar.removeEventListener('animationend', onTimerEnd);
    root.removeEventListener('click', onClick);
    root.remove();
  };
}

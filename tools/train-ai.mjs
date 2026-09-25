// tools/train-ai.mjs
// Practice for Tomorrow AI: plays simulated trading days against the full
// bot market (about 10 s per day), learning as it goes, and saves its brain
// to assets/ai-brain.json. Runs resume where the last one stopped.
//
//   node tools/train-ai.mjs --minutes 60          # practise for an hour
//   node tools/train-ai.mjs --days 200            # or a number of days
//   node tools/train-ai.mjs --days 50 --fresh     # start again from a random brain
//   node tools/train-ai.mjs --eval 30             # test the saved brain (no learning)
//
// Needs Node 22+.

import { loadBrain, saveBrain, newBrain, practise, scoreOnDays, describeBehaviour, playDay, withSeed, seedingWorks, SEEDING_WARNING, fmt, mean, sd } from './ai-lib.mjs';
import { createAgent } from '../src/engine/ai/RLTrader.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

if (args.includes('--eval')) {
  const days = opt('--eval', 30);
  const brain = loadBrain();
  if (!brain) {
    console.log('No saved brain yet: run some practice first.');
    process.exit(0);
  }
  if (!seedingWorks()) console.log(SEEDING_WARNING);
  const seeds = Array.from({ length: days }, (_, i) => 1000 + i); // same days every time
  const trained = scoreOnDays(brain, seeds);
  const randomTrader = createAgent({ epsStart: 1, epsEnd: 1, bufferSize: 1000 }); // picks every action at random
  const random = seeds.map((seed) => withSeed(seed, () => playDay(randomTrader, { learning: false, record: false })));
  const line = (name, pnls) => {
    const se = sd(pnls) / Math.sqrt(pnls.length);
    console.log(`  ${name.padEnd(14)} ${fmt(mean(pnls)).padStart(10)} per day (±${se.toFixed(2)})   won ${pnls.filter((p) => p > 0).length}/${pnls.length} days`);
  };
  console.log(`Tomorrow AI after ${brain.episodes} practised days (generation ${brain.generation}), tested on ${days} fixed simulated days:`);
  console.log(`  ${'always flat'.padEnd(14)} ${fmt(0).padStart(10)} per day`);
  line('random trader', random.map((r) => r.pnl));
  line('Tomorrow AI', trained.map((r) => r.pnl));
  const b = describeBehaviour(trained);
  console.log(`  average position ${b.avgExposure.toFixed(0)} shares`);
  console.log(`  sizes:  ${b.sizes}`);
  console.log(`  prices: ${b.prices}`);
  console.log(`  quotes: ${b.quotes}`);
  process.exit(0);
}

let brain = args.includes('--fresh') ? null : loadBrain();
if (!brain) {
  brain = newBrain();
  console.log(`Starting from a random brain (${brain.online.paramCount.toLocaleString()} parameters).`);
} else {
  console.log(`Resuming: ${brain.episodes} days practised, exploring ${(brain.epsilon * 100).toFixed(0)}% of the time.`);
}
const played = practise(brain, { days: opt('--days', Infinity), minutes: opt('--minutes', args.includes('--days') ? Infinity : 30), save: saveBrain });
console.log(`Practised ${played} days. Saved to assets/ai-brain.json (${brain.episodes} days in total).`);

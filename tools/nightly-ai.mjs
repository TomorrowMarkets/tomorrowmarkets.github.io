// tools/nightly-ai.mjs
// Tomorrow AI's long-term learning, run every night by GitHub Actions
// (.github/workflows/ai-nightly.yml), or by hand.
//
//   1. download the games uploaded since last night (the experience inbox)
//   2. replay them into the AI's memory and learn from them
//   3. practise further against the simulated market
//   4. test the result against the current brain on identical seeded days
//   5. publish it to assets/ai-brain.json only if it isn't clearly worse
//
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node tools/nightly-ai.mjs --practice-minutes 120
//
// Without the SUPABASE_* variables it skips step 1 and just practises.

import fs from 'node:fs';
import { BRAIN_PATH, newBrain, saveBrain, practise, compare, fmt, seedingWorks, SEEDING_WARNING } from './ai-lib.mjs';
import { BranchingDQN } from '../src/engine/ai/brain.js';
import { replayGame } from '../src/engine/ai/RLTrader.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const PRACTICE_MINUTES = opt('--practice-minutes', 60);
const EVAL_DAYS = opt('--eval-days', 40);
const MAX_GAMES = opt('--max-games', 2000);
const INBOX = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/ai_experience` : null;
const KEY = process.env.SUPABASE_SERVICE_KEY;
// New secret keys (sb_secret_...) go only in the apikey header; legacy
// service_role JWTs (eyJ...) also need the Bearer header.
const headers = !KEY ? {} : KEY.startsWith('eyJ') ? { apikey: KEY, Authorization: `Bearer ${KEY}` } : { apikey: KEY };

// Inbox requests with retries: after hours of practice, pooled connections
// may have been closed by the server, and networks hiccup.
async function request(url, init = {}, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}), Connection: 'close' } });
    } catch (err) {
      if (attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

const summary = [];
const say = (line) => {
  console.log(line);
  summary.push(line);
};

async function fetchGames() {
  if (!INBOX || !KEY) return { games: [], lastId: null };
  const games = [];
  let lastId = 0;
  while (games.length < MAX_GAMES) {
    const res = await request(`${INBOX}?select=id,payload&id=gt.${lastId}&order=id.asc&limit=50`);
    if (!res.ok) throw new Error(`Inbox read failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    if (!rows.length) break;
    games.push(...rows);
    lastId = rows[rows.length - 1].id;
  }
  return { games, lastId: games.length ? lastId : null };
}

async function clearGames(lastId) {
  if (!INBOX || !KEY || lastId == null) return;
  const res = await request(`${INBOX}?id=lte.${lastId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!res.ok) throw new Error(`Inbox cleanup failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const incumbentJson = fs.existsSync(BRAIN_PATH) ? JSON.parse(fs.readFileSync(BRAIN_PATH, 'utf8')) : null;
  const candidate = incumbentJson ? BranchingDQN.fromJSON(incumbentJson) : newBrain();
  const startGeneration = incumbentJson ? incumbentJson.generation || 0 : 0;
  say(`Tomorrow AI nightly learning: generation ${startGeneration}, ${candidate.episodes} days of experience so far.`);

  // 1-2. Real games from the inbox
  const { games, lastId } = await fetchGames();
  let used = 0;
  let transitions = 0;
  for (const g of games) {
    const n = replayGame(candidate, g.payload);
    if (n > 0) {
      used += 1;
      transitions += n;
    }
  }
  if (games.length) {
    say(`Real games: ${games.length} uploaded, ${used} valid (${transitions.toLocaleString()} decisions).`);
    const steps = Math.min(20000, Math.ceil((transitions * 16) / candidate.config.batch));
    for (let i = 0; i < steps; i++) candidate.learn();
    say(`Learned from real games: ${steps.toLocaleString()} training steps.`);
  } else {
    say(INBOX ? 'Real games: none uploaded since last night.' : 'Real games: inbox not configured, practice only.');
  }

  // 3. Practice
  const days = practise(candidate, { minutes: PRACTICE_MINUTES, log: () => {} });
  say(`Practice: ${days} simulated days (now ${candidate.episodes} in total, exploring ${(candidate.epsilon * 100).toFixed(0)}%).`);

  // 4. Test on identical days (a new set every night, so it can't overfit a fixed exam)
  if (!seedingWorks()) say(SEEDING_WARNING);
  const night = Math.floor(Date.now() / 86400000);
  const seeds = Array.from({ length: EVAL_DAYS }, (_, i) => night * 1000 + i);
  const incumbent = incumbentJson ? BranchingDQN.fromJSON(incumbentJson) : null;
  const r = compare(candidate, incumbent, seeds);
  say(`Test on ${EVAL_DAYS} identical days: new ${fmt(r.candidate)}/day vs current ${fmt(r.incumbent)}/day (difference ${fmt(r.diff)} ± ${r.se.toFixed(2)}).`);

  // 5. Publish unless clearly worse
  const publish = !incumbent || r.diff >= -r.se;
  if (publish) {
    candidate.generation = startGeneration + 1;
    saveBrain(candidate);
    await clearGames(lastId);
    say(`Published generation ${candidate.generation}.`);
  } else {
    say('Not published: the new brain tested clearly worse. Real games are kept for tomorrow.');
  }

  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n\n')}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

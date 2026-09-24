// leaderboard-api.js
// The only file that knows about Supabase. Fill in your project URL and key
// (Supabase > Project Settings > API). The publishable/anon key is designed
// to be public; the database functions do the validation.

const SUPABASE_URL = 'https://jpsdqawilipmsineoufz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Rzvy0JUEksDPLELwB2UJkQ_Sf4ELYPJ';

export const CATEGORIES = ['discretionary', 'algorithmic'];
export const BOARD_SIZE = 1000;

// Until the placeholders above are replaced, the page shows sample data
// and runs are not submitted.
export const isConfigured = !SUPABASE_URL.includes('YOUR-PROJECT-REF');

let clientPromise = null;

function getClient() {
  if (!isConfigured) return Promise.resolve(null);
  clientPromise ??= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
    .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_KEY));
  return clientPromise;
}

// Every browser gets a silent anonymous account the first time it plays.
// The session persists in the browser, so a player keeps one leaderboard
// entry per category and their row is marked "(You)".
async function ensureSession(sb) {
  const { data } = await sb.auth.getSession();
  if (data.session) return;
  const { error } = await sb.auth.signInAnonymously();
  if (error) throw error;
}

/**
 * Call when a round starts, in every player's browser (single or multiplayer).
 * Returns a tracker whose finish() submits the result. Never throws: if the
 * leaderboard is unreachable, the game carries on and finish() returns null.
 *
 *   const run = createRunTracker({ mode: 'multi', durationMin: 10 });
 *   ...
 *   const result = await run.finish({ handle, category: 'algorithmic', pnl });
 *   // result?.rank -> 1..1000, or null if the score didn't make the board
 */
export function createRunTracker({ mode, durationMin }) {
  const ticket = (async () => {
    const sb = await getClient();
    if (!sb) return null;
    await ensureSession(sb);
    const { data, error } = await sb.rpc('start_run', {
      p_mode: mode === 'multi' ? 'multi' : 'single',
      p_duration_min: Math.round(durationMin),
    });
    if (error) throw error;
    return data;
  })().catch((err) => {
    console.warn('[leaderboard] could not start run:', err.message ?? err);
    return null;
  });

  let finished = false;

  return {
    async finish({ handle, category, pnl }) {
      if (finished) return null;
      finished = true;
      const runId = await ticket;
      if (!runId) return null;
      try {
        const sb = await getClient();
        const { data, error } = await sb.rpc('finish_run', {
          p_run_id: runId,
          p_handle: String(handle ?? '').trim(),
          p_category: category,
          p_pnl: Math.round(Number(pnl) * 100) / 100,
        });
        if (error) throw error;
        return data; // { rank: number | null, board_size: 1000 }
      } catch (err) {
        console.warn('[leaderboard] could not submit run:', err.message ?? err);
        return null;
      }
    },
  };
}

/**
 * Top 1000 for one category, best first.
 * Rows: { rank, handle, pnl, mode, duration_min, achieved_at, is_you }
 */
export async function fetchLeaderboard(category) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);
  const sb = await getClient();
  if (!sb) return sampleRows(category);

  const { data, error } = await sb
    .from('leaderboard_ranked')
    .select('rank, handle, pnl, mode, duration_min, achieved_at, is_you')
    .eq('category', category)
    .order('rank', { ascending: true })
    .limit(BOARD_SIZE);

  if (error) throw error;
  return data.map((row) => ({ ...row, pnl: Number(row.pnl) }));
}

// Sample data for previewing the page before Supabase is connected.
function sampleRows(category) {
  const names = ['Quanta', 'Mira_K', 'deltaHedge', 'Otto', 'Freya.v', 'Sol', 'north_star',
    'Juno', 'Tobias', 'Ines', 'meanrev', 'Kasper', 'Ada_L', 'pip', 'Noor', 'Lukas', 'Hana',
    'Theo', 'gamma_ray', 'Ida', 'Viggo', 'Rosa', 'Emil', 'bid_ask', 'Aksel'];
  let seed = category === 'algorithmic' ? 7 : 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let pnl = category === 'algorithmic' ? 48210.5 : 31875.25;
  const day = 86400000;
  return names.map((name, i) => {
    const row = {
      rank: i + 1,
      handle: category === 'algorithmic' ? `${name}_bot` : name,
      pnl: Math.round(pnl * 100) / 100,
      mode: rand() > 0.45 ? 'multi' : 'single',
      duration_min: [5, 10, 15, 20, 30][Math.floor(rand() * 5)],
      achieved_at: new Date(Date.now() - Math.floor(rand() * 40) * day).toISOString(),
      is_you: i === 11,
    };
    pnl *= 0.82 + rand() * 0.12;
    return row;
  });
}

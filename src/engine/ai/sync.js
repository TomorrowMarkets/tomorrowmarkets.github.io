// src/engine/ai/sync.js
// Sends each finished game's AI experience to the "experience inbox" so the
// nightly trainer can fold it into the long-term brain.
//
// Setup (once): create the table from supabase/ai_experience.sql in a free
// Supabase project, then paste the project URL and its public "anon" key
// below. The anon key is safe to publish: the table only accepts inserts from
// it, nobody can read or change anything with it. Leave these empty to keep
// uploads switched off (the AI still learns live in each game).

export const AI_SYNC = {
  supabaseUrl: 'https://iwmqwqguisduqwnsdbyj.supabase.co',  // e.g. 'https://abcdefghijklm.supabase.co'
  anonKey: 'sb_publishable_x-5rCxKoGiy7bGouB23uAQ_7w_eUMaW',      // Project settings -> API -> anon public key
  table: 'ai_experience'
};

export const syncEnabled = () => Boolean(AI_SYNC.supabaseUrl && AI_SYNC.anonKey);

export async function uploadExperience(experience, meta = {}) {
  if (!syncEnabled() || !experience || !experience.decisions) return false;
  try {
    const res = await fetch(`${AI_SYNC.supabaseUrl.replace(/\/$/, '')}/rest/v1/${AI_SYNC.table}`, {
      method: 'POST',
      headers: {
        apikey: AI_SYNC.anonKey,
        Authorization: `Bearer ${AI_SYNC.anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        generation: experience.generation,
        decisions: experience.decisions,
        pnl: experience.pnl,
        humans: meta.humans ?? null,
        payload: experience
      }),
      keepalive: false
    });
    return res.ok;
  } catch (err) {
    return false; // offline or blocked: the game carries on regardless
  }
}

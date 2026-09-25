// src/engine/ai/sync.js
// Sends each finished game's AI experience to the "experience inbox" so the
// nightly trainer can fold it into the long-term brain.
//
// Paste your project's PUBLISHABLE key below (Supabase: Project settings ->
// API Keys -> Publishable key, starts with sb_publishable_). It is safe to
// publish: the table only accepts new rows from it and nobody can read with
// it. Never put the SECRET key (sb_secret_...) here or anywhere in the site.
// Leave publishableKey empty to keep uploads switched off.

export const AI_SYNC = {
  supabaseUrl: 'https://iwmqwqguisduqwnsdbyj.supabase.co',
  publishableKey: '', // paste the full sb_publishable_... key here
  table: 'ai_experience'
};

export const syncEnabled = () => Boolean(AI_SYNC.supabaseUrl && AI_SYNC.publishableKey);

// New Supabase keys (sb_...) go only in the apikey header; sending them as a
// Bearer token too makes Supabase reject the request. Legacy JWT keys (eyJ...)
// need both headers.
export function supabaseHeaders(key) {
  const headers = { apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export async function uploadExperience(experience, meta = {}) {
  if (!syncEnabled() || !experience || !experience.decisions) return false;
  try {
    const res = await fetch(`${AI_SYNC.supabaseUrl.replace(/\/$/, '')}/rest/v1/${AI_SYNC.table}`, {
      method: 'POST',
      headers: {
        ...supabaseHeaders(AI_SYNC.publishableKey),
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        generation: experience.generation,
        decisions: experience.decisions,
        pnl: experience.pnl,
        humans: meta.humans ?? null,
        payload: experience
      })
    });
    if (!res.ok) console.warn('Tomorrow AI: upload refused', res.status, await res.text());
    return res.ok;
  } catch (err) {
    return false; // offline or blocked: the game carries on regardless
  }
}

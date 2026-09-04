/* lib/supabase.js
 *
 * Supabase client used for READ-ONLY queries via the publishable key.
 * All WRITES go through the secure mirror API (see MIRROR_API_BASE) — the
 * browser has no insert/update permission on Supabase anymore, which is what
 * stops forged leaderboard / prediction rows.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, MIRROR_API_BASE } from './config.js';
import { getActiveProvider } from './wallet.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false },
});

/* ---------- Users ---------- */

export async function getUsername(address) {
  if (!address) return null;
  const { data, error } = await sb
    .from('users')
    .select('username')
    .eq('user_address', address)
    .maybeSingle();
  if (error) {
    console.warn('getUsername:', error.message);
    return null;
  }
  return data?.username ?? null;
}

// Claim a username by SIGNING a message with the wallet — the /api/set-username
// endpoint verifies the signature server-side before writing. No direct insert.
export async function createUser(address, username) {
  const provider = getActiveProvider();
  if (!provider) throw new Error('Connect a wallet first.');
  const message = `UCL '27 Predict — claim username: ${username}`;
  const signature = await provider.request({
    method: 'personal_sign',
    params: [message, address],
  });
  const resp = await fetch(`${MIRROR_API_BASE}/api/set-username`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, username, signature }),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(out.error || 'Could not save username');
  return out;
}

export async function usernameExists(username) {
  const { data, error } = await sb
    .from('users')
    .select('user_address')
    .eq('username', username)
    .maybeSingle();
  if (error) {
    console.warn('usernameExists:', error.message);
    return false;
  }
  return Boolean(data);
}

/* ---------- Mirror API (chain-verified writes) ---------- */

// Ask the server to mirror the caller's on-chain state to Supabase. The
// endpoint reads the contract and only writes what's actually true, so this is
// safe to call optimistically after any predict/claim/refund tx.
export async function mirrorPrediction(matchId, address, action) {
  try {
    const resp = await fetch(`${MIRROR_API_BASE}/api/mirror-prediction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match_id: matchId, user_address: address, action }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: out.error || `mirror failed (${resp.status})` };
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------- Matches ---------- */

export async function getMatches() {
  const { data, error } = await sb
    .from('matches')
    .select(`
      match_id, contract_address, home, away, kickoff_ts, matchday,
      status, result, final_score, live_score_home, live_score_away, live_minute
    `)
    .order('kickoff_ts', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getMatch(matchId) {
  const { data, error } = await sb
    .from('matches')
    .select('*')
    .eq('match_id', matchId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* ---------- Pools ---------- */

export async function getPool(matchId) {
  const { data, error } = await sb
    .from('pools')
    .select('*')
    .eq('match_id', matchId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* ---------- Predictions ---------- */

export async function getMyPredictions(address) {
  if (!address) return [];
  const { data, error } = await sb
    .from('predictions')
    .select(`
      *, match:matches(home, away, kickoff_ts, status, result, final_score, matchday)
    `)
    .eq('user_address', address)
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/* ---------- Standings (UCL Table tab) ---------- */

export async function getStandings() {
  const { data, error } = await sb
    .from('standings')
    .select('*')
    .order('position', { ascending: true });
  if (error) throw error;
  return data || [];
}

/* ---------- AI Call (validators' own pick per fixture) ---------- */

export async function getAIPredictionsMap() {
  // Only 'stored' rows have a real pick to show.
  const { data, error } = await sb
    .from('ai_predictions')
    .select('match_id, pick, confidence, reason, status')
    .eq('status', 'stored');
  if (error) {
    console.warn('getAIPredictionsMap:', error.message);
    return {};
  }
  const byId = {};
  (data || []).forEach((r) => { byId[r.match_id] = r; });
  return byId;
}

export async function getAIPrediction(matchId) {
  const { data, error } = await sb
    .from('ai_predictions')
    .select('match_id, pick, confidence, reason, status')
    .eq('match_id', matchId)
    .maybeSingle();
  if (error) {
    console.warn('getAIPrediction:', error.message);
    return null;
  }
  return data && data.status === 'stored' ? data : null;
}

/* ---------- Leaderboard ---------- */

export async function getLeaderboard(limit = 50) {
  const { data, error } = await sb
    .from('leaderboard')
    .select('*')
    .order('wins', { ascending: false })
    .order('total_predictions', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

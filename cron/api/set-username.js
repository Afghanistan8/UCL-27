// api/set-username.js
//
// SECURE username creation. Usernames are off-chain (there's no contract for
// them), so we can't verify against GenLayer like predictions. Instead we
// require a WALLET SIGNATURE: the caller must sign a fixed message with the
// address they're claiming a name for. This proves ownership and stops anyone
// from squatting names or writing rows for addresses they don't control.
//
// POST body: { address, username, signature }
// The signed message is exactly: `UCL '27 Predict — claim username: <username>`
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { recoverMessageAddress } from 'viem';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'server misconfigured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { address, username, signature } = body || {};

  if (!isAddress(address)) return res.status(400).json({ error: 'bad address' });
  if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: '3-20 chars, letters/numbers/underscore' });
  if (!signature || typeof signature !== 'string') return res.status(400).json({ error: 'missing signature' });

  // 1. Verify the signature proves control of `address`.
  const message = `UCL '27 Predict — claim username: ${username}`;
  let recovered;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch {
    return res.status(401).json({ error: 'invalid signature' });
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return res.status(401).json({ error: 'signature does not match address' });
  }

  const sb = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 2. Enforce uniqueness (case-insensitive) without clobbering someone else's.
  const { data: taken } = await sb
    .from('users')
    .select('user_address')
    .ilike('username', username)
    .maybeSingle();
  if (taken && taken.user_address.toLowerCase() !== address.toLowerCase()) {
    return res.status(409).json({ error: 'username taken' });
  }

  // 3. Upsert the verified (address, username) pair.
  const { error } = await sb.from('users').upsert(
    { user_address: address, username },
    { onConflict: 'user_address' }
  );
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true, username });
}

// api/mirror-prediction.js
//
// SECURE write path for the prediction mirror. The frontend can no longer
// INSERT/UPDATE Supabase directly (that let anyone forge leaderboard rows).
// Instead it POSTs here AFTER its on-chain tx, and this endpoint VERIFIES the
// claim against the contract — the real source of truth — before mirroring.
//
// Because every field written here is read back from the chain, a caller
// cannot fake a prediction, inflate a stake, or mark someone else claimed:
// the contract state simply won't back the lie, and we reject it.
//
// POST body: { match_id, user_address, action: 'predict'|'claim'|'refund' }
// No CRON_SECRET — this is a public endpoint, but it only writes what the
// chain already proves true, so it needs no privileged caller.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (service key bypasses RLS)

import { createClient as createGenLayerClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// genlayer-js's calldata encoder for Address type arguments
import { abi } from 'genlayer-js';
const { calldata } = abi;

const PICKS = new Set(['home', 'draw', 'away']);

// genlayer-js encodes a plain hex string as a STRING, not an Address, so
// contract reads with an `Address` argument revert once the map is non-empty.
// Build the calldata's SPECIAL_ADDR form and decode it into a real
// CalldataAddress instance (the only thing the encoder treats as an address).
const SPECIAL_ADDR = (3 << 3) | 0; // 24
function glAddress(hex) {
  const h = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(21);
  bytes[0] = SPECIAL_ADDR;
  for (let i = 0; i < 20; i++) bytes[1 + i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return calldata.decode(bytes);
}

function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

export default async function handler(req, res) {
  // CORS — the frontend is served from a different Vercel domain.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'server misconfigured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { match_id, user_address, action } = body || {};

  if (!match_id || typeof match_id !== 'string') return res.status(400).json({ error: 'bad match_id' });
  if (!isAddress(user_address)) return res.status(400).json({ error: 'bad user_address' });
  if (!['predict', 'claim', 'refund'].includes(action)) return res.status(400).json({ error: 'bad action' });

  const sb = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const gl = createGenLayerClient({ chain: testnetBradbury });

  // 1. Resolve the match's contract from OUR mirror (we control this row via
  //    the deploy script; the caller cannot point us at an arbitrary address).
  const { data: match, error: mErr } = await sb
    .from('matches')
    .select('match_id, contract_address')
    .eq('match_id', match_id)
    .maybeSingle();
  if (mErr || !match?.contract_address) {
    return res.status(404).json({ error: 'unknown match' });
  }

  try {
    // 2. Read the caller's ACTUAL on-chain prediction. This is the gate:
    //    if they didn't stake, there is nothing to mirror. A read that reverts
    //    or hasn't finalized is treated the same as "no prediction" — we never
    //    write something the chain doesn't (yet) prove.
    let pred = null;
    try {
      pred = await gl.readContract({
        address: match.contract_address,
        functionName: 'get_my_prediction',
        args: [glAddress(user_address)],
      });
    } catch (readErr) {
      return res.status(409).json({ error: 'no verifiable on-chain prediction yet (may still be finalizing)' });
    }

    if (!pred?.has_predicted) {
      return res.status(409).json({ error: 'no on-chain prediction for this address' });
    }

    const pick = String(pred.pick);
    if (!PICKS.has(pick)) return res.status(422).json({ error: 'contract returned invalid pick' });
    const stakeWei = BigInt(pred.stake ?? 0).toString();
    const claimedOnChain = Boolean(pred.claimed);

    if (action === 'predict') {
      // Upsert the verified prediction. onConflict keeps it idempotent, so a
      // double-submit can't create duplicates or change the staked amount.
      const { error } = await sb.from('predictions').upsert(
        {
          match_id,
          user_address,
          pick,
          stake_wei: stakeWei,
          contract_address: match.contract_address,
        },
        { onConflict: 'match_id,user_address' }
      );
      if (error) throw new Error(`mirror insert: ${error.message}`);
      return res.status(200).json({ ok: true, pick, stake_wei: stakeWei });
    }

    // claim / refund: only reflect what the chain confirms.
    if (action === 'claim') {
      if (!claimedOnChain) return res.status(409).json({ error: 'not claimed on-chain yet' });
      const { error } = await sb.from('predictions').update({ claimed: true })
        .eq('match_id', match_id).ilike('user_address', user_address);
      if (error) throw new Error(error.message);
      return res.status(200).json({ ok: true, claimed: true });
    }

    if (action === 'refund') {
      if (!claimedOnChain) return res.status(409).json({ error: 'not refunded on-chain yet' });
      const { error } = await sb.from('predictions').update({ refunded: true })
        .eq('match_id', match_id).ilike('user_address', user_address);
      if (error) throw new Error(error.message);
      return res.status(200).json({ ok: true, refunded: true });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

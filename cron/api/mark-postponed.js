// api/mark-postponed.js
//
// A real, safe application path for mark_postponed() — the automation half of
// the flow the frontend exposes as a button. It submits mark_postponed(),
// waits for contract finality, and exposes refunds only after the contract
// itself reports refunding — an off-chain 'postponed' label can NEVER be
// mistaken for the on-chain refund state.
//
// This endpoint:
//   1. Finds matches an OFF-CHAIN source flagged as called off (mirror status
//      'postponed_pending'), or a single match_id passed explicitly.
//   2. Reads the CONTRACT: only proceeds if it is still 'open' and past the
//      kickoff + grace window (the contract enforces this too, and reverts
//      otherwise — this pre-check just avoids wasting a reverting tx).
//   3. Submits mark_postponed(), WAITS for finality (ACCEPTED), then RE-READS
//      the on-chain status.
//   4. Writes matches.status = 'refunding' to the mirror ONLY if the contract
//      now reports STATUS_REFUNDING. If the sources didn't confirm (the tx
//      reverted / stayed open), the mirror is NOT changed to a refund state.
//
// The mirror never invents 'refunding' from an off-chain hint — it is copied
// from the chain after this function verifies it there.
//
// Auth: Authorization: Bearer <CRON_SECRET>
// Env:  PRIVATE_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET

import { createClient as createGenLayerClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const POSTPONE_GRACE_SECS = 10800;      // must match the contract
const MAX_PER_TICK = 2;                  // pace on-chain submissions

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const account = createAccount(process.env.PRIVATE_KEY);
  const gl = createGenLayerClient({ chain: testnetBradbury, account });
  try { await gl.initializeConsensusSmartContract(); } catch {}

  const log = [];
  const result = { attempted: 0, opened_refunds: 0, still_open: 0, errors: [], log };

  // A specific match can be targeted (?match_id=… or JSON body); otherwise scan
  // the mirror for anything an off-chain source already flagged.
  const explicitId =
    (req.query && req.query.match_id) ||
    (req.body && (typeof req.body === 'string' ? JSON.parse(req.body || '{}').match_id : req.body.match_id));

  const nowSec = Math.floor(Date.now() / 1000);

  try {
    let candidates = [];
    if (explicitId) {
      const { data } = await sb
        .from('matches')
        .select('match_id, contract_address, home, away, kickoff_ts, status')
        .eq('match_id', explicitId)
        .limit(1);
      candidates = data || [];
    } else {
      const { data } = await sb
        .from('matches')
        .select('match_id, contract_address, home, away, kickoff_ts, status')
        .eq('status', 'postponed_pending')          // OFF-CHAIN hint only
        .not('contract_address', 'is', null)
        .lte('kickoff_ts', nowSec - POSTPONE_GRACE_SECS)
        .order('kickoff_ts', { ascending: true })
        .limit(MAX_PER_TICK);
      candidates = data || [];
    }

    if (!candidates.length) { log.push('no postponed_pending matches past grace'); return res.status(200).json(result); }

    for (const m of candidates) {
      if (!m.contract_address) continue;
      // 1. Read the CONTRACT — the only authority on whether refunds may open.
      let info;
      try {
        info = await gl.readContract({ address: m.contract_address, functionName: 'get_match_info', args: [] });
      } catch (e) {
        result.errors.push({ match_id: m.match_id, phase: 'read', error: e.message });
        continue;
      }
      if (info?.status === 'refunding') {
        // Already open on-chain — just make sure the mirror agrees.
        await sb.from('matches').update({ status: 'refunding', result: '', final_score: '' }).eq('match_id', m.match_id);
        result.opened_refunds++;
        log.push(`  ✓ ${m.match_id}: already refunding on-chain; mirror synced`);
        continue;
      }
      if (info?.status !== 'open') { log.push(`  · ${m.match_id}: on-chain status '${info?.status}', skipping`); continue; }
      if (nowSec < Number(info.kickoff_ts) + POSTPONE_GRACE_SECS) { log.push(`  · ${m.match_id}: still inside grace window`); continue; }

      // 2. Submit mark_postponed() and WAIT for finality.
      result.attempted++;
      try {
        log.push(`  → mark_postponed() ${m.match_id} (${m.home} vs ${m.away})`);
        const txHash = await gl.writeContract({ address: m.contract_address, functionName: 'mark_postponed', args: [], value: 0n });
        await gl.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.ACCEPTED, retries: 60, interval: 5000 });

        // 3. RE-READ on-chain status — refunds open only if the contract says so.
        const after = await gl.readContract({ address: m.contract_address, functionName: 'get_match_info', args: [] });
        if (after?.status === 'refunding') {
          await sb.from('matches').update({ status: 'refunding', result: '', final_score: '' }).eq('match_id', m.match_id);
          result.opened_refunds++;
          log.push(`    ✓ contract now REFUNDING — mirror updated (tx ${txHash})`);
        } else {
          // Sources didn't confirm (the tx may have reverted). Do NOT touch the
          // refund state; the off-chain 'postponed_pending' hint stays as-is.
          result.still_open++;
          log.push(`    · contract still '${after?.status}' — refunds NOT opened`);
        }
      } catch (e) {
        // mark_postponed reverts (e.g. a source shows a finished result, or the
        // secondary didn't confirm). That is a valid, safe outcome — leave the
        // mirror untouched so an off-chain hint never becomes a refund state.
        result.still_open++;
        result.errors.push({ match_id: m.match_id, phase: 'mark', error: e.message });
        log.push(`    · mark_postponed reverted/failed — refunds NOT opened (${e.message})`);
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    log.push(`fatal: ${err.message}`);
    return res.status(500).json({ ...result, fatal: err.message });
  }
}

// api/predict-matches.js
//
// Vercel serverless endpoint pinged by cron every ~30 minutes.
// The on-chain sibling of resolve-matches.js, but it fires BEFORE kickoff:
// GenLayer's validators make their own home/draw/away call on each upcoming
// fixture and store it on the single AIPredictor contract.
//
// Two phases per tick:
//   A. Poll pending predictions (read get_prediction; write the pick to
//      Supabase once it FINALIZES; retry submissions that truly died).
//   B. Submit new predictions for fixtures kicking off soon that have none.
//
// Auth: requires Authorization: Bearer <CRON_SECRET>
//
// Env vars required in Vercel:
//   PRIVATE_KEY            — the ADMIN wallet that deployed AIPredictor
//                            (predict() is admin-only; must be this wallet)
//   AI_PREDICTOR_ADDRESS   — the deployed AIPredictor contract address
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   CRON_SECRET

import { createClient as createGenLayerClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Constants
const MAX_NEW_PREDICTS_PER_TICK = 2;   // submit at most 2 new predict() per tick (gas pacing)
const MAX_POLLS_PER_TICK = 8;          // poll up to 8 pending predictions per tick
const PREDICT_LEAD_HOURS = 30;         // only predict fixtures kicking off within this window
const PREDICT_RETRY_HOURS = 8;         // Bradbury finality can be hours; only retry after this long

function toDateStr(kickoffTs) {
  // kickoff_ts is unix seconds -> YYYY-MM-DD (the date arg predict() stores)
  return new Date(kickoffTs * 1000).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  // ---------- Auth ----------
  const authHeader = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const aiAddress = process.env.AI_PREDICTOR_ADDRESS;
  if (!aiAddress) {
    return res.status(500).json({ error: 'missing AI_PREDICTOR_ADDRESS' });
  }

  // ---------- Clients ----------
  const sb = createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const account = createAccount(process.env.PRIVATE_KEY);
  const gl = createGenLayerClient({ chain: testnetBradbury, account });
  try { await gl.initializeConsensusSmartContract(); } catch {}

  const log = [];
  const result = {
    polled: 0,
    stored: 0,
    new_predicts: 0,
    errors: [],
    log,
  };

  try {
    // ============================================================
    // Phase A — Poll pending predictions
    // ============================================================
    log.push('--- Phase A: poll pending predictions ---');

    const { data: pending, error: pErr } = await sb
      .from('ai_predictions')
      .select('*')
      .eq('status', 'pending')
      .order('submitted_at', { ascending: true })
      .limit(MAX_POLLS_PER_TICK);

    if (pErr) {
      log.push(`ai_predictions query error: ${pErr.message}`);
    } else if (pending && pending.length) {
      log.push(`polling ${pending.length} pending prediction(s)`);
      for (const row of pending) {
        const matchId = row.match_id;
        result.polled++;
        try {
          const pred = await gl.readContract({
            address: aiAddress,
            functionName: 'get_prediction',
            args: [matchId],
          });

          if (pred?.has_prediction) {
            // FINALIZED & stored on-chain — mirror the pick to Supabase.
            await sb.from('ai_predictions').update({
              status: 'stored',
              pick: pred.pick,
              confidence: pred.confidence,
              reason: pred.reason,
              stored_at: new Date().toISOString(),
            }).eq('match_id', matchId);
            result.stored++;
            log.push(`  ✓ ${matchId}: ${pred.pick} (${pred.confidence}) — ${pred.reason}`);
          } else {
            // Not stored yet: either still finalizing (normal, hours) or the
            // submission died (undetermined/rolled back). Only retry after the
            // generous grace window so we don't double-submit a slow-but-fine tx.
            const submittedAt = new Date(row.submitted_at);
            const ageHours = (Date.now() - submittedAt.getTime()) / (1000 * 60 * 60);
            if (ageHours > PREDICT_RETRY_HOURS) {
              await sb.from('ai_predictions')
                .update({ status: 'failed', error: 'timeout — not stored after grace' })
                .eq('match_id', matchId);
              log.push(`  ✗ ${matchId}: not stored after ${ageHours.toFixed(1)}h, marking failed for retry`);
            } else {
              log.push(`  · ${matchId}: still finalizing (${ageHours.toFixed(1)}h ago)`);
            }
          }
        } catch (err) {
          log.push(`  ! ${matchId}: read error — ${err.message}`);
          result.errors.push({ phase: 'poll', match_id: matchId, error: err.message });
        }
      }
    } else {
      log.push('  nothing pending');
    }

    // ============================================================
    // Phase B — Submit new predictions
    // ============================================================
    log.push('--- Phase B: submit new predictions ---');

    const nowTs = Math.floor(Date.now() / 1000);
    const windowEndTs = nowTs + PREDICT_LEAD_HOURS * 3600;

    // Upcoming fixtures kicking off within the lead window (future only).
    const { data: candidates, error: cErr } = await sb
      .from('matches')
      .select('match_id, home, away, kickoff_ts')
      .gt('kickoff_ts', nowTs)
      .lte('kickoff_ts', windowEndTs)
      .order('kickoff_ts', { ascending: true })
      .limit(20);

    if (cErr) {
      log.push(`candidates query error: ${cErr.message}`);
    } else if (candidates && candidates.length) {
      // Skip fixtures that already have a prediction row that is pending or stored.
      const { data: existing } = await sb
        .from('ai_predictions')
        .select('match_id, status')
        .in('match_id', candidates.map(m => m.match_id))
        .in('status', ['pending', 'stored']);
      const blockedSet = new Set((existing || []).map(r => r.match_id));

      const toPredict = candidates
        .filter(c => !blockedSet.has(c.match_id))
        .slice(0, MAX_NEW_PREDICTS_PER_TICK);
      log.push(`${toPredict.length} fixture(s) eligible for new predict()`);

      for (const m of toPredict) {
        const dateStr = toDateStr(m.kickoff_ts);
        try {
          log.push(`  → predict() ${m.match_id} (${m.home} vs ${m.away}, ${dateStr})`);
          const txHash = await gl.writeContract({
            address: aiAddress,
            functionName: 'predict',
            args: [m.match_id, m.home, m.away, dateStr],
            value: 0n,
          });

          // Upsert so a prior 'failed' retry row is reused, not duplicated.
          await sb.from('ai_predictions').upsert({
            match_id: m.match_id,
            home: m.home,
            away: m.away,
            date: dateStr,
            status: 'pending',
            tx_hash: txHash,
            submitted_at: new Date().toISOString(),
            error: null,
          }, { onConflict: 'match_id' });
          result.new_predicts++;
          log.push(`    tx: ${txHash}`);
        } catch (err) {
          // Idempotent contract: a re-submit for an already-stored match reverts
          // with "already has an AI prediction" — treat that as success.
          if (/already has an AI prediction/i.test(err.message || '')) {
            await sb.from('ai_predictions')
              .update({ status: 'pending' })
              .eq('match_id', m.match_id);
            log.push(`    · already predicted on-chain; will pick up next poll`);
          } else {
            log.push(`    ✗ submit failed: ${err.message}`);
            result.errors.push({ phase: 'submit', match_id: m.match_id, error: err.message });
          }
        }
      }
    } else {
      log.push('  no upcoming fixtures in window');
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    log.push(`fatal: ${err.message}`);
    return res.status(500).json({ ...result, fatal: err.message });
  }
}

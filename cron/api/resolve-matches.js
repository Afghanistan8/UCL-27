// api/resolve-matches.js
//
// Vercel serverless endpoint pinged by cron on a schedule (~10 minutes when
// live matches are running). Same shape as the La Liga reference — the
// contract does the settlement work; this endpoint just triggers it.
//
// Two phases per tick:
//   A. Poll pending resolutions (read get_match_info, write result to Supabase if done)
//   B. Submit new resolutions for finished matches (kick off resolve() tx)
//
// Auth: requires Authorization: Bearer <CRON_SECRET>
//
// Env vars required in Vercel:
//   PRIVATE_KEY            — server wallet that pays gas for resolve() calls
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   CRON_SECRET

import { createClient as createGenLayerClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Constants
const MAX_NEW_RESOLUTIONS_PER_TICK = 2;   // submit at most 2 new resolves per cron tick (gas pacing)
const MAX_POLLS_PER_TICK = 8;             // check up to 8 pending resolutions per tick
const RESOLVE_GRACE_MINUTES = 110;        // wait this long after kickoff before resolving (full match + halftime + injury time)
const RESOLVE_RETRY_HOURS = 4;            // if a resolve tx is older than this and still pending, try again

export default async function handler(req, res) {
  // ---------- Auth ----------
  const authHeader = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ---------- Clients ----------
  const sb = createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const account = createAccount(process.env.PRIVATE_KEY);
  const gl = createGenLayerClient({
    chain: testnetBradbury,
    account,
  });
  try { await gl.initializeConsensusSmartContract(); } catch {}

  const log = [];
  const result = {
    polled: 0,
    completed: 0,
    new_resolves: 0,
    errors: [],
    log,
  };

  try {
    // ============================================================
    // Phase A — Poll pending resolutions
    // ============================================================
    log.push('--- Phase A: poll pending resolutions ---');

    const { data: pending, error: pErr } = await sb
      .from('resolutions_log')
      .select('*')
      .eq('status', 'pending')
      .order('submitted_at', { ascending: true })
      .limit(MAX_POLLS_PER_TICK);

    if (pErr) {
      log.push(`resolutions_log query error: ${pErr.message}`);
    } else if (pending && pending.length) {
      log.push(`polling ${pending.length} pending resolution(s)`);
      for (const row of pending) {
        const matchId = row.match_id;
        const contractAddress = row.contract_address;
        if (!contractAddress) {
          log.push(`  ${matchId}: no contract address, skipping`);
          continue;
        }
        result.polled++;
        try {
          const info = await gl.readContract({
            address: contractAddress,
            functionName: 'get_match_info',
            args: [],
          });
          const status = info?.status;
          const onchainResult = info?.result;
          const finalScore = info?.final_score;

          if (status === 'resolved' || status === 'refunding') {
            // Done — write to Supabase
            const matchUpdate = status === 'resolved'
              ? { status: 'resolved', result: onchainResult, final_score: finalScore }
              : { status: 'refunding', result: '', final_score: finalScore || '' };

            await sb.from('matches').update(matchUpdate).eq('match_id', matchId);
            await sb.from('resolutions_log')
              .update({ status: 'completed', completed_at: new Date().toISOString(), final_status: status, final_result: onchainResult || null, final_score: finalScore || null })
              .eq('id', row.id);

            result.completed++;
            log.push(`  ✓ ${matchId}: ${status}${onchainResult ? ` (${onchainResult} ${finalScore})` : ''}`);
          } else {
            // Still 'open' — LLM not done yet, or tx still in flight
            const submittedAt = new Date(row.submitted_at);
            const ageHours = (Date.now() - submittedAt.getTime()) / (1000 * 60 * 60);
            if (ageHours > RESOLVE_RETRY_HOURS) {
              // Resolve tx looks stuck. Mark this attempt as failed; Phase B will retry later.
              await sb.from('resolutions_log')
                .update({ status: 'failed', completed_at: new Date().toISOString(), error: 'timeout — match still open' })
                .eq('id', row.id);
              log.push(`  ✗ ${matchId}: stuck for ${ageHours.toFixed(1)}h, marking failed for retry`);
            } else {
              log.push(`  · ${matchId}: still pending (${ageHours.toFixed(1)}h ago)`);
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
    // Phase B — Submit new resolutions
    // ============================================================
    log.push('--- Phase B: submit new resolutions ---');

    // Cutoff: only resolve matches whose kickoff was >= RESOLVE_GRACE_MINUTES ago AND status is still 'live' or 'finished' AND result is null
    const cutoffTs = Math.floor(Date.now() / 1000) - RESOLVE_GRACE_MINUTES * 60;

    // Find candidates: matches past grace, with contract, no result yet, and no pending/completed resolutions log
    const { data: candidates, error: cErr } = await sb
      .from('matches')
      .select('match_id, contract_address, home, away, kickoff_ts, status')
      .lte('kickoff_ts', cutoffTs)
      .not('contract_address', 'is', null)
      .or('result.is.null,result.eq.')
      .in('status', ['live', 'finished', 'scheduled'])
      .order('kickoff_ts', { ascending: true })
      .limit(20);

    if (cErr) {
      log.push(`candidates query error: ${cErr.message}`);
    } else if (candidates && candidates.length) {
      // Filter out those that already have a pending or completed resolution log entry
      const { data: existingLogs } = await sb
        .from('resolutions_log')
        .select('match_id, status')
        .in('match_id', candidates.map(m => m.match_id))
        .in('status', ['pending', 'completed']);
      const blockedSet = new Set((existingLogs || []).map(l => l.match_id));

      const toResolve = candidates.filter(c => !blockedSet.has(c.match_id)).slice(0, MAX_NEW_RESOLUTIONS_PER_TICK);
      log.push(`${toResolve.length} match(es) eligible for new resolve()`);

      for (const m of toResolve) {
        try {
          log.push(`  → submitting resolve() for ${m.match_id} (${m.home} vs ${m.away})`);
          const txHash = await gl.writeContract({
            address: m.contract_address,
            functionName: 'resolve',
            args: [],
            value: 0n,
          });

          // Log it; we'll poll next tick
          await sb.from('resolutions_log').insert({
            match_id: m.match_id,
            contract_address: m.contract_address,
            tx_hash: txHash,
            status: 'pending',
            submitted_at: new Date().toISOString(),
          });
          result.new_resolves++;
          log.push(`    tx: ${txHash}`);
        } catch (err) {
          log.push(`    ✗ submit failed: ${err.message}`);
          result.errors.push({ phase: 'submit', match_id: m.match_id, error: err.message });
        }
      }
    } else {
      log.push('  no matches eligible');
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    log.push(`fatal: ${err.message}`);
    return res.status(500).json({ ...result, fatal: err.message });
  }
}

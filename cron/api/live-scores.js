// api/live-scores.js
// Vercel API route — called by Vercel Cron on a schedule.
// Polls football-data.org for live scores of UEFA Champions League fixtures
// that are close to (or in) their kickoff window, mirrors them to Supabase,
// and (optionally) broadcasts on an Ably channel for real-time UI.
//
// Off-chain only. It NEVER touches on-chain resolution or the refund state —
// see mark-postponed.js for the source-verified path that opens refunds.

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import Ably from 'ably';

// ---------- helpers ----------
function mapStatus(fd) {
  switch (fd) {
    case 'SCHEDULED':
    case 'TIMED':       return 'scheduled';
    case 'IN_PLAY':
    case 'PAUSED':      return 'live';
    case 'FINISHED':    return 'finished';
    // Off-chain postponement HINT only (from football-data). This must NOT be
    // confused with the on-chain 'refunding' state: 'postponed_pending' means
    // "a source says this was called off" — refunds are NOT claimable until
    // mark_postponed() runs on-chain and the contract itself reports
    // STATUS_REFUNDING. The mirror never writes 'refunding' from here.
    case 'POSTPONED':
    case 'CANCELLED':
    case 'SUSPENDED':   return 'postponed_pending';
    default:            return 'scheduled';
  }
}

function liveMinute(fd) {
  if (fd.status === 'IN_PLAY') {
    if (fd.minute) return String(fd.minute);
    return 'LIVE';
  }
  if (fd.status === 'PAUSED') return 'HT';
  if (fd.status === 'FINISHED') return 'FT';
  return null;
}

function isInWindow(now, kickoff_ts) {
  return now >= kickoff_ts - 4 * 3600 && now <= kickoff_ts + 5 * 3600;
}

// ---------- handler ----------
export default async function handler(req, res) {
  // Cron auth: Vercel sends a bearer token equal to CRON_SECRET env var
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    FOOTBALL_DATA_API_KEY,
    ABLY_API_KEY,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !FOOTBALL_DATA_API_KEY) {
    return res.status(500).json({ error: 'missing env vars' });
  }

  const sb = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  // Ably is optional — the pipeline works without it, we just skip the broadcast.
  const ably = ABLY_API_KEY ? new Ably.Rest(ABLY_API_KEY) : null;
  const channel = ably ? ably.channels.get('live-scores') : null;

  try {
    const now = Math.floor(Date.now() / 1000);

    // 1. Get matches with external IDs
    const { data: matches, error } = await sb
      .from('matches')
      .select('match_id, external_match_id, home, away, kickoff_ts, status, live_score_home, live_score_away, live_minute')
      .not('external_match_id', 'is', null);
    if (error) throw error;

    const candidates = matches.filter((m) => isInWindow(now, m.kickoff_ts));
    if (candidates.length === 0) {
      return res.status(200).json({ ok: true, message: 'no matches in window', changed: 0 });
    }

    // 2. Batch fetch from football-data
    const ids = candidates.map((m) => m.external_match_id).join(',');
    const fdRes = await fetch(
      `https://api.football-data.org/v4/matches?ids=${ids}`,
      { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY } }
    );
    if (!fdRes.ok) {
      const text = await fdRes.text();
      return res.status(502).json({ error: 'football-data fail', status: fdRes.status, body: text });
    }
    const fdData = await fdRes.json();
    const fdById = new Map(fdData.matches.map((m) => [String(m.id), m]));

    // 3. Diff + write changes
    let changed = 0;
    const updates = [];

    for (const ours of candidates) {
      // Supabase returns external_match_id as a NUMBER (bigint), but fdById is
      // keyed by String(m.id) — coerce so the lookup actually matches.
      const fd = fdById.get(String(ours.external_match_id));
      if (!fd) continue;

      const newScoreHome = fd.score?.fullTime?.home ?? null;
      const newScoreAway = fd.score?.fullTime?.away ?? null;
      const newMinute    = liveMinute(fd);
      const newStatus    = mapStatus(fd.status);

      const noChange =
        ours.live_score_home === (newScoreHome ?? 0) &&
        ours.live_score_away === (newScoreAway ?? 0) &&
        ours.live_minute === newMinute &&
        ours.status === newStatus;
      if (noChange) continue;

      const update = {
        live_score_home: newScoreHome ?? 0,
        live_score_away: newScoreAway ?? 0,
        live_minute:     newMinute,
        status:          newStatus,
        updated_at:      new Date().toISOString(),
      };

      const { error: upErr } = await sb
        .from('matches')
        .update(update)
        .eq('match_id', ours.match_id);
      if (upErr) continue;

      if (channel) {
        await channel.publish('score-update', {
          match_id: ours.match_id,
          home: ours.home,
          away: ours.away,
          ...update,
        });
      }

      updates.push({ match_id: ours.match_id, score: `${update.live_score_home}-${update.live_score_away}`, minute: update.live_minute, status: update.status });
      changed++;
    }

    return res.status(200).json({ ok: true, candidates: candidates.length, changed, updates });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

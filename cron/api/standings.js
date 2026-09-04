// api/standings.js
// Vercel API route — called by cron on a schedule.
// Scrapes the UEFA Champions League league-phase table from BBC Sport and
// mirrors it to Supabase, so the frontend "Table" tab reads sub-second from
// Postgres.
//
// BBC is the authoritative source — the same one the market contracts use for
// resolution — and it carries the correct 2026/27 UCL league-phase table
// (36 clubs). football-data.org's free tier lags the actual season.
//
// Pure-regex HTML parse: no jsdom / no new dependency. Crests are mapped to the
// football-data CDN so they match the crests used on the match cards.

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const BBC_TABLE_URL = 'https://www.bbc.com/sport/football/champions-league/table';

// team name (as BBC prints it) -> { id, crest, short } using football-data's
// stable CDN, so the Table tab crests match the rest of the app.
const CDN = 'https://crests.football-data.org';
const TEAM_META = {
  // England
  'Manchester City':      { id: 65,   crest: `${CDN}/65.png`,   short: 'Man City' },
  'Manchester United':    { id: 66,   crest: `${CDN}/66.png`,   short: 'Man Utd' },
  'Liverpool':            { id: 64,   crest: `${CDN}/64.png`,   short: 'Liverpool' },
  'Arsenal':              { id: 57,   crest: `${CDN}/57.png`,   short: 'Arsenal' },
  'Aston Villa':          { id: 58,   crest: `${CDN}/58.png`,   short: 'Aston Villa' },

  // Spain
  'Real Madrid':          { id: 86,   crest: `${CDN}/86.png`,   short: 'Real Madrid' },
  'Barcelona':            { id: 81,   crest: `${CDN}/81.png`,   short: 'Barcelona' },
  'Atletico Madrid':      { id: 78,   crest: `${CDN}/78.png`,   short: 'Atletico Madrid' },
  'Atlético Madrid':      { id: 78,   crest: `${CDN}/78.png`,   short: 'Atletico Madrid' },
  'Villarreal':           { id: 94,   crest: `${CDN}/94.png`,   short: 'Villarreal' },
  'Real Betis':           { id: 90,   crest: `${CDN}/90.png`,   short: 'Real Betis' },

  // Germany
  'Bayern Munich':        { id: 5,    crest: `${CDN}/5.png`,    short: 'Bayern' },
  'Borussia Dortmund':    { id: 4,    crest: `${CDN}/4.png`,    short: 'Dortmund' },
  'RB Leipzig':           { id: 721,  crest: `${CDN}/721.png`,  short: 'Leipzig' },
  'Stuttgart':            { id: 10,   crest: `${CDN}/10.png`,   short: 'Stuttgart' },

  // Italy
  'Inter Milan':          { id: 108,  crest: `${CDN}/108.png`,  short: 'Inter' },
  'Napoli':               { id: 113,  crest: `${CDN}/113.png`,  short: 'Napoli' },
  'Roma':                 { id: 100,  crest: `${CDN}/100.png`,  short: 'Roma' },
  'Como':                 { id: 604,  crest: `${CDN}/604.png`,  short: 'Como' },

  // France
  'Paris Saint-Germain':  { id: 524,  crest: `${CDN}/524.png`,  short: 'PSG' },
  'Paris St-Germain':     { id: 524,  crest: `${CDN}/524.png`,  short: 'PSG' },
  'Lille':                { id: 521,  crest: `${CDN}/521.png`,  short: 'Lille' },
  'Lens':                 { id: 546,  crest: `${CDN}/546.png`,  short: 'Lens' },

  // Portugal
  'Porto':                { id: 503,  crest: `${CDN}/503.png`,  short: 'Porto' },
  'Sporting CP':          { id: 498,  crest: `${CDN}/498.png`,  short: 'Sporting' },

  // Netherlands
  'PSV Eindhoven':        { id: 674,  crest: `${CDN}/674.png`,  short: 'PSV' },
  'Feyenoord':            { id: 675,  crest: `${CDN}/675.png`,  short: 'Feyenoord' },

  // Belgium
  'Club Brugge':          { id: 851,  crest: `${CDN}/851.png`,  short: 'Brugge' },

  // Turkey
  'Galatasaray':          { id: 645,  crest: `${CDN}/645.png`,  short: 'Galatasaray' },
  'Fenerbahce':           { id: 611,  crest: `${CDN}/611.png`,  short: 'Fenerbahce' },
  'Fenerbahçe':           { id: 611,  crest: `${CDN}/611.png`,  short: 'Fenerbahce' },

  // Greece
  'AEK Athens':           { id: 6969, crest: `${CDN}/6969.png`, short: 'AEK' },

  // Austria
  'LASK':                 { id: 2020, crest: `${CDN}/2020.png`, short: 'LASK' },

  // Norway
  'Bodo/Glimt':           { id: 1959, crest: `${CDN}/1959.png`, short: 'Bodo/Glimt' },
  'Bodø/Glimt':           { id: 1959, crest: `${CDN}/1959.png`, short: 'Bodo/Glimt' },
  'Viking':               { id: 1948, crest: `${CDN}/1948.png`, short: 'Viking' },

  // Czechia
  'Slavia Prague':        { id: 907,  crest: `${CDN}/907.png`,  short: 'Slavia' },

  // Slovakia
  'Slovan Bratislava':    { id: 7910, crest: `${CDN}/7910.png`, short: 'Slovan' },

  // Ukraine
  'Shakhtar Donetsk':     { id: 1887, crest: `${CDN}/1887.png`, short: 'Shakhtar' },

  // Azerbaijan
  'Sabah':                { id: 7995, crest: `${CDN}/7995.png`, short: 'Sabah' },
};

function metaFor(team) {
  if (TEAM_META[team]) return TEAM_META[team];
  // loose match (e.g. "Man City" vs "Manchester City")
  const key = Object.keys(TEAM_META).find(
    (k) => team.includes(k) || k.includes(team)
  );
  return key ? TEAM_META[key] : null;
}

// BBC's form cell strips to a run-on of result words + single-letter badges,
// e.g. "No ResultNo ResultNo ResultNo ResultNo ResultWResult Win". Extract just
// the real outcomes (Win/Draw/Loss/Defeat, ignoring "No Result" placeholders),
// map to W/D/L, keep the last 5, and return them comma-separated so the frontend
// can render one dot per result instead of the whole garbled string.
function parseForm(raw) {
  const words = String(raw || '').match(/Win|Draw|Loss|Defeat/gi) || [];
  const letters = words.map((w) => {
    const l = w.toLowerCase();
    if (l === 'win') return 'W';
    if (l === 'draw') return 'D';
    return 'L'; // loss / defeat
  });
  return letters.slice(-5).join(',');
}

// Decode the handful of HTML entities BBC emits in team names (accents, ampersands).
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'missing env vars' });
  }

  const sb = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // 1. Fetch the BBC table HTML
    const bbcRes = await fetch(BBC_TABLE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!bbcRes.ok) {
      return res.status(502).json({ error: 'bbc fetch fail', status: bbcRes.status });
    }
    const html = await bbcRes.text();

    // 2. Isolate the <table> and split into rows
    const tableMatch = html.match(/<table[\s\S]*?<\/table>/);
    if (!tableMatch) {
      return res.status(200).json({ ok: true, message: 'no table found', rows: 0 });
    }
    const trs = [...tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => m[0]);

    const now = new Date().toISOString();
    const parsed = [];

    // 3. Parse each data row (skip header)
    for (const tr of trs) {
      const cells = [...tr.matchAll(/<t[dh][\s\S]*?<\/t[dh]>/g)].map((c) =>
        c[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      );
      if (cells.length < 10) continue;
      if (/^team$/i.test(cells[0])) continue; // header row

      // First cell is "1Real Madrid" (position glued to team name)
      const posAndTeam = cells[0];
      const posMatch = posAndTeam.match(/^(\d+)/);
      if (!posMatch) continue;
      const position = Number(posMatch[1]);
      const team = decodeEntities(posAndTeam.slice(posMatch[1].length).trim());

      const meta = metaFor(team);

      parsed.push({
        team_id: meta ? meta.id : (position + 100000), // stable fallback id
        position,
        team,
        short_name: meta ? meta.short : team,
        crest: meta ? meta.crest : '',
        played:          Number(cells[1]) || 0,
        won:             Number(cells[2]) || 0,
        draw:            Number(cells[3]) || 0,
        lost:            Number(cells[4]) || 0,
        goals_for:       Number(cells[5]) || 0,
        goals_against:   Number(cells[6]) || 0,
        goal_difference: Number(cells[7]) || 0,
        points:          Number(cells[8]) || 0,
        form:            parseForm(cells[9]),
        updated_at:      now,
      });
    }

    if (parsed.length === 0) {
      return res.status(200).json({ ok: true, message: 'parsed 0 rows', rows: 0 });
    }

    // 4. Replace the table: clear stale rows, then insert the fresh set.
    // (team_id set changes between seasons, so upsert alone would leave last
    // season's dropped clubs behind — delete-then-insert keeps it exact.)
    await sb.from('standings').delete().neq('team_id', -1);
    const { error: insErr } = await sb.from('standings').insert(parsed);
    if (insErr) throw new Error(`supabase standings.insert: ${insErr.message}`);

    return res.status(200).json({ ok: true, rows: parsed.length, updated_at: now });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

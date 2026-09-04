// api/health.js
//
// Public, unauthenticated status page for the cron project.
//
// WHY THIS EXISTS: this Vercel project is serverless functions only — there is
// no page at `/`, so hitting the bare domain returned a raw 404: NOT_FOUND.
// That 404 was correct behaviour but indistinguishable from a broken deploy,
// so vercel.json rewrites `/` here instead.
//
// It reports only booleans about configuration — never a secret's value — and
// never triggers any on-chain write. Safe to expose publicly.

const ENDPOINTS = [
  { path: '/api/resolve-matches', auth: 'CRON_SECRET', cadence: '~10 min',
    does: 'Calls resolve() on markets past kickoff; mirrors settled status/score.' },
  { path: '/api/predict-matches', auth: 'CRON_SECRET', cadence: '~30 min',
    does: 'Calls predict() on the AI predictor for fixtures kicking off soon.' },
  { path: '/api/standings',       auth: 'CRON_SECRET', cadence: '~3 h',
    does: 'Scrapes the BBC UCL league-phase table into Supabase.' },
  { path: '/api/live-scores',     auth: 'CRON_SECRET', cadence: '~5 min',
    does: 'Mirrors football-data.org CL scores for the UI (never settles money).' },
  { path: '/api/mark-postponed',  auth: 'CRON_SECRET', cadence: 'on demand',
    does: 'Submits mark_postponed(); opens refunds ONLY if the contract confirms.' },
  { path: '/api/mirror-prediction', auth: 'public (chain-verified)', cadence: 'on demand',
    does: 'Mirrors a user stake AFTER verifying it against the contract.' },
  { path: '/api/set-username',    auth: 'public (signature-verified)', cadence: 'on demand',
    does: 'Stores a username after verifying a wallet signature.' },
];

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  // Booleans only. Never echo a secret's value.
  const configured = {
    PRIVATE_KEY: Boolean(process.env.PRIVATE_KEY),
    AI_PREDICTOR_ADDRESS: Boolean(process.env.AI_PREDICTOR_ADDRESS),
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_KEY: Boolean(process.env.SUPABASE_SERVICE_KEY),
    FOOTBALL_DATA_API_KEY: Boolean(process.env.FOOTBALL_DATA_API_KEY),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    ABLY_API_KEY: Boolean(process.env.ABLY_API_KEY),   // optional
  };

  // Everything except ABLY_API_KEY is required for the full pipeline.
  const missing = Object.entries(configured)
    .filter(([k, v]) => !v && k !== 'ABLY_API_KEY')
    .map(([k]) => k);

  const body = {
    service: "UCL '27 Predict — cron",
    ok: missing.length === 0,
    note: 'This project exposes serverless functions only. There is no UI here; '
        + 'the app itself is a separate Vercel project. A 404 on any path other '
        + 'than those listed below is expected.',
    network: {
      chain: 'GenLayer Bradbury',
      chainId: 4221,
      rpc: 'https://rpc-bradbury.genlayer.com',
      explorer: 'https://explorer-bradbury.genlayer.com',
    },
    ai_predictor: process.env.AI_PREDICTOR_ADDRESS || null,
    configured,
    missing_required: missing,
    endpoints: ENDPOINTS,
    time: new Date().toISOString(),
  };

  // Browsers get a readable page; curl/other clients get JSON.
  const wantsHtml = (req.headers.accept || '').includes('text/html');
  if (!wantsHtml) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify(body, null, 2));
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
  const statusColor = body.ok ? '#3fb950' : '#f85149';
  const rows = ENDPOINTS.map((e) => `
    <tr>
      <td><code>${esc(e.path)}</code></td>
      <td>${esc(e.cadence)}</td>
      <td>${esc(e.auth)}</td>
      <td>${esc(e.does)}</td>
    </tr>`).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UCL '27 Predict — cron status</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:2.5rem 1.25rem; background:#0a1428; color:#e8edf5;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  .wrap { max-width: 940px; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; letter-spacing:-.02em; }
  h1 .star { color:#f0b429; }
  .status { display:inline-flex; align-items:center; gap:.5rem; font-weight:600;
            color:${statusColor}; margin:.5rem 0 1.5rem; }
  .dot { width:9px; height:9px; border-radius:50%; background:${statusColor}; }
  .note { color:#93a4bd; background:#111d33; border:1px solid #1e2d48;
          border-radius:10px; padding:.85rem 1rem; margin:0 0 1.75rem; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th,td { text-align:left; padding:.6rem .7rem; border-bottom:1px solid #1e2d48;
          vertical-align:top; }
  th { color:#93a4bd; font-size:.72rem; text-transform:uppercase;
       letter-spacing:.09em; }
  code { background:#111d33; padding:.15rem .4rem; border-radius:5px;
         font-family:ui-monospace,monospace; font-size:.85em; color:#f0b429; }
  .miss { color:#f85149; font-weight:600; }
  footer { margin-top:2rem; color:#6b7c96; font-size:.82rem; }
  a { color:#f0b429; }
</style></head><body><div class="wrap">
<h1><span class="star">★</span> UCL '27 Predict — cron</h1>
<div class="status"><span class="dot"></span>${body.ok ? 'All required env vars configured' : 'Missing: ' + missing.join(', ')}</div>
<p class="note">${esc(body.note)}</p>
<table>
  <thead><tr><th>Endpoint</th><th>Cadence</th><th>Auth</th><th>What it does</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<footer>
  AI predictor: <code>${esc(body.ai_predictor || 'not set')}</code><br>
  GenLayer Bradbury (chain 4221) ·
  <a href="https://explorer-bradbury.genlayer.com" rel="noopener">Explorer</a> ·
  ${esc(body.time)}
</footer>
</div></body></html>`);
}

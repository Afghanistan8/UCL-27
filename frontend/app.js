/* UCL '27 Predict — main entrypoint */

import { showToast, attachAsyncSubmit } from './lib/ui.js';
import {
  subscribe as subscribeWallet,
  getState as getWalletState,
  connect as connectWallet,
  disconnect as disconnectWallet,
  switchToStudionet,
  trySilentReconnect,
  hasMetaMask,
  shortAddress,
  getDiscoveredWallets,
} from './lib/wallet.js';
import {
  sb,
  getUsername,
  createUser,
  usernameExists,
  getMatches,
  getMatch,
  getStandings,
  getAIPredictionsMap,
  getAIPrediction,
  mirrorPrediction,
} from './lib/supabase.js';
import {
  readPools,
  readMyPrediction,
  readMatchInfo,
  computeExpectedPayout,
  submitPrediction,
  claim,
  refund,
  markPostponed,
  toWei,
  formatGen,
} from './lib/contract.js';
import { MIN_STAKE_GEN } from './lib/config.js';
import { crestImg } from './lib/crests.js';

// ─────────────────────────────────────────────────────────── THEME

const root = document.documentElement;
function applyTheme(theme) {
  root.setAttribute('data-theme', theme);
  localStorage.setItem('ucl27-theme', theme);
}
(function initTheme() {
  const saved = localStorage.getItem('ucl27-theme');
  if (saved) applyTheme(saved);
  else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) applyTheme('light');
})();
document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = root.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ─────────────────────────────────────────────────────────── WALLET UI

const walletBtn = document.getElementById('wallet-button');
const walletLabel = walletBtn.querySelector('.wallet-label');
let currentUsername = null;

subscribeWallet(async (state) => {
  if (!state.address) {
    walletBtn.dataset.state = 'disconnected';
    walletLabel.textContent = 'Connect wallet';
    currentUsername = null;
    return;
  }
  if (!state.isStudionet) {
    walletBtn.dataset.state = 'connected';
    walletLabel.textContent = 'Wrong network';
    walletBtn.title = 'Click to switch to Bradbury';
    return;
  }
  walletBtn.dataset.state = 'connected';
  walletBtn.title = '';
  currentUsername = await getUsername(state.address);
  if (currentUsername) {
    walletLabel.textContent = currentUsername;
  } else {
    walletLabel.textContent = shortAddress(state.address);
    document.getElementById('username-modal').hidden = false;
  }
  render();
});

walletBtn.addEventListener('click', async () => {
  const state = getWalletState();
  if (!state.address) {
    openWalletChooser();
    return;
  }
  if (!state.isStudionet) {
    try { await switchToStudionet(); showToast('Switched to Bradbury'); }
    catch (err) { showToast('Network switch declined', 'error'); }
    return;
  }
  const ok = confirm(`Disconnect ${currentUsername || shortAddress(state.address)}?`);
  if (ok) { disconnectWallet(); showToast('Disconnected'); }
});

// ─────────────────────────────────────────────────────────── WALLET CHOOSER

const walletModal = document.getElementById('wallet-modal');
const walletListEl = document.getElementById('wallet-list');
const walletEmptyEl = document.getElementById('wallet-empty');

function closeWalletChooser() { walletModal.hidden = true; }

document.getElementById('wallet-modal-close')?.addEventListener('click', closeWalletChooser);
walletModal?.addEventListener('click', (e) => { if (e.target === walletModal) closeWalletChooser(); });

function openWalletChooser() {
  const wallets = getDiscoveredWallets();
  walletListEl.innerHTML = '';

  if (wallets.length === 0) {
    if (hasMetaMask()) {
      walletEmptyEl.hidden = true;
      connectChosen(null, 'your wallet');
      return;
    }
    walletEmptyEl.hidden = false;
    walletModal.hidden = false;
    return;
  }

  walletEmptyEl.hidden = true;
  wallets.forEach((w) => {
    const btn = document.createElement('button');
    btn.className = 'wallet-option';
    btn.innerHTML = `
      ${w.info?.icon ? `<img src="${w.info.icon}" alt="" class="wallet-option-icon" width="28" height="28">` : '<span class="wallet-option-icon"></span>'}
      <span class="wallet-option-name">${w.info?.name || 'Wallet'}</span>
    `;
    btn.addEventListener('click', () => connectChosen(w, w.info?.name || 'wallet'));
    walletListEl.appendChild(btn);
  });
  walletModal.hidden = false;
}

async function connectChosen(detail, label) {
  closeWalletChooser();
  try {
    await connectWallet(detail);
    showToast(`Connected ${label}`);
  } catch (err) {
    showToast(err.message || 'Connect rejected', 'error');
  }
}

// ─────────────────────────────────────────────────────────── USERNAME MODAL

const usernameForm = document.getElementById('username-form');
const usernameInput = document.getElementById('username-input');
const usernameError = document.getElementById('username-error');

attachAsyncSubmit(usernameForm, async () => {
  const value = usernameInput.value.trim();
  usernameError.hidden = true;
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(value)) {
    usernameError.textContent = '3–20 characters, letters/numbers/underscore only.';
    usernameError.hidden = false; return;
  }
  const taken = await usernameExists(value);
  if (taken) { usernameError.textContent = 'That username is taken.'; usernameError.hidden = false; return; }
  const state = getWalletState();
  if (!state.address) { usernameError.textContent = 'Wallet not connected.'; usernameError.hidden = false; return; }
  await createUser(state.address, value);
  currentUsername = value;
  walletLabel.textContent = value;
  document.getElementById('username-modal').hidden = true;
  showToast(`Welcome, ${value}`);
  render();
});

// ─────────────────────────────────────────────────────────── ROUTER

const routes = ['home', 'match', 'me', 'leaderboard', 'table'];
function parseRoute() {
  const hash = window.location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home', params: {} };
  if (parts[0] === 'match' && parts[1]) return { name: 'match', params: { id: parts[1] } };
  if (parts[0] === 'me') return { name: 'me', params: {} };
  if (parts[0] === 'leaderboard') return { name: 'leaderboard', params: {} };
  if (parts[0] === 'table') return { name: 'table', params: {} };
  return { name: 'home', params: {} };
}
function render() {
  const route = parseRoute();
  routes.forEach((name) => {
    const el = document.getElementById('page-' + name);
    if (el) el.hidden = name !== route.name;
  });
  document.querySelectorAll('[data-route]').forEach((el) => {
    if (el.tagName === 'A') el.classList.toggle('is-active', el.dataset.route === route.name);
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (route.name === 'home') renderHome();
  if (route.name === 'match') renderMatchDetail(route.params.id);
  if (route.name === 'me') renderMyPicks();
  if (route.name === 'leaderboard') renderLeaderboard();
  if (route.name === 'table') renderTable();
}
window.addEventListener('hashchange', render);

// ─────────────────────────────────────────────────────────── HOME

let cachedMatches = null;
let cachedAIPreds = {};
let currentFilter = 'upcoming';

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function loadMatches() {
  try {
    cachedMatches = await withTimeout(getMatches(), 8000, null);
    if (cachedMatches === null) throw new Error('timed out');
  } catch (e) {
    console.error('loadMatches:', e);
    cachedMatches = [];
    showToast("Couldn't load matches — retrying is safe", 'error');
  }
  return cachedMatches;
}

async function loadAIPreds() {
  // Decorative only — must never block or fail the match list.
  try { cachedAIPreds = (await withTimeout(getAIPredictionsMap(), 6000, {})) || {}; }
  catch (e) { console.warn('AI preds load failed:', e.message); cachedAIPreds = {}; }
  return cachedAIPreds;
}

function filterMatches(matches, filter) {
  const now = Math.floor(Date.now() / 1000);
  if (filter === 'today') {
    const s = new Date(); s.setHours(0,0,0,0);
    const e = new Date(); e.setHours(23,59,59,999);
    return matches.filter(m => m.kickoff_ts >= s.getTime()/1000 && m.kickoff_ts <= e.getTime()/1000);
  }
  if (filter === 'upcoming') return matches.filter(m => m.kickoff_ts > now && m.status === 'scheduled');
  if (filter === 'live') return matches.filter(m => m.status === 'live');
  if (filter === 'finished') return matches.filter(m => m.status === 'finished' || m.status === 'resolved');
  return matches;
}

async function renderHome() {
  const list = document.getElementById('match-list');
  try {
    if (!cachedMatches) await loadMatches();
    await loadAIPreds();
    const matches = cachedMatches || [];
    document.getElementById('stat-matches').textContent = matches.length || '0';
    try {
      const { count, error } = await withTimeout(
        sb.from('predictions').select('*', { count: 'exact', head: true }),
        5000, { count: null, error: true }
      );
      if (!error) document.getElementById('stat-predictions').textContent = count || '0';
    } catch {}
    document.getElementById('stat-volume').textContent = '0';

    const filtered = filterMatches(matches, currentFilter);
    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state">${emptyStateMessage(matches)}</div>`;
      return;
    }
    list.innerHTML = filtered.map(matchCardHtml).join('');
  } catch (e) {
    console.error('renderHome failed:', e);
    list.innerHTML = `<div class="empty-state">Couldn't load matches right now. Please refresh in a moment.</div>`;
  }
}

// Friendly, context-aware empty state (pre-season vs. a filter with no hits).
function emptyStateMessage(matches) {
  if (!matches.length) {
    return 'No markets are live yet — the 2026/27 league phase kicks off 8 Sep 2026. Check back soon.';
  }
  const labels = { today: 'today', upcoming: 'upcoming', live: 'live now', finished: 'finished' };
  return `No ${labels[currentFilter] || currentFilter} matches to show right now.`;
}

function aiBadgeHtml(m, { compact = false } = {}) {
  const ai = cachedAIPreds[m.match_id];
  if (!ai || !ai.pick) return '';
  const pickTeam = ai.pick === 'home' ? m.home : ai.pick === 'away' ? m.away : 'Draw';
  const conf = ai.confidence ? `<span class="ai-badge-conf">${ai.confidence}</span>` : '';
  return `
    <span class="ai-badge" data-pick="${ai.pick}" title="${ai.reason ? ai.reason.replace(/"/g, '&quot;') : 'GenLayer AI call'}">
      <span class="ai-badge-mark">AI</span>
      <span class="ai-badge-pick">${pickTeam}</span>
      ${compact ? '' : conf}
    </span>`;
}

function matchCardHtml(m) {
  const date = new Date(m.kickoff_ts * 1000);
  const dateLabel = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timeLabel = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const stageLabel = m.matchday ? `Matchday ${m.matchday}` : 'UCL 26/27';
  const homeScore = m.live_score_home ?? '—';
  const awayScore = m.live_score_away ?? '—';
  return `
    <a href="#/match/${m.match_id}" class="match-card" data-status="${m.status}">
      <div class="match-meta">
        <span class="match-stage">${stageLabel}</span>
        <span class="match-time">${dateLabel} · ${timeLabel}</span>
      </div>
      <div class="match-teams">
        <div class="match-team">${crestImg(m.home, 40, 'team-crest')}<span class="team-name">${m.home}</span><span class="team-score">${m.status === 'scheduled' ? '—' : homeScore}</span></div>
        <div class="match-team">${crestImg(m.away, 40, 'team-crest')}<span class="team-name">${m.away}</span><span class="team-score">${m.status === 'scheduled' ? '—' : awayScore}</span></div>
      </div>
      ${aiBadgeHtml(m, { compact: true }) ? `<div class="match-card-ai">${aiBadgeHtml(m, { compact: true })}</div>` : ''}
    </a>
  `;
}

document.getElementById('filter-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-tab');
  if (!btn) return;
  document.querySelectorAll('#filter-tabs .filter-tab').forEach((t) => t.classList.remove('is-active'));
  btn.classList.add('is-active');
  currentFilter = btn.dataset.filter;
  renderHome();
});

// ─────────────────────────────────────────────────────────── MATCH DETAIL

let currentMatch = null;
let currentPools = { home: 0n, draw: 0n, away: 0n, total: 0n };
let currentPick = null;
let myPrediction = null;

async function readMyPredictionFromSupabase(matchId, userAddress) {
  if (!userAddress) return null;
  try {
    const { data, error } = await sb
      .from('predictions')
      .select('*')
      .eq('match_id', matchId)
      .ilike('user_address', userAddress)
      .maybeSingle();
    if (error) {
      console.warn('readMyPredictionFromSupabase error:', error.message);
      return null;
    }
    if (!data) return null;
    return {
      pick: data.pick,
      stake: BigInt(data.stake_wei),
      claimed: Boolean(data.claimed),
      refunded: Boolean(data.refunded),
      tx_hash: data.tx_hash,
    };
  } catch (e) {
    console.warn('readMyPredictionFromSupabase exception:', e.message);
    return null;
  }
}

async function renderMatchDetail(matchId) {
  const el = document.getElementById('match-detail');
  el.innerHTML = '<div class="empty-state">Loading match…</div>';

  try {
    currentMatch = await getMatch(matchId);
    if (!currentMatch) {
      el.innerHTML = '<div class="empty-state">Match not found.</div>';
      return;
    }
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Couldn\'t load match.</div>';
    return;
  }

  try {
    currentPools = await readPools(currentMatch.contract_address);
  } catch (e) {
    console.warn('pool read failed:', e.message);
    currentPools = { home: 0n, draw: 0n, away: 0n, total: 0n };
  }

  // The mirror status may carry an OFF-CHAIN postponement hint from the
  // live-scores cron ('postponed_pending'). Preserve it separately: this is
  // NOT the refund state and must never enable refunds on its own.
  const mirrorStatus = currentMatch.status;
  currentMatch.offchain_postponed =
    mirrorStatus === 'postponed_pending' || mirrorStatus === 'postponed';
  currentMatch.onchain_kickoff_ts = Number(currentMatch.kickoff_ts || 0);

  // Authoritative status/result from the CONTRACT (not the mirror), so the
  // Claim/Refund buttons only enable when the chain actually says so — a stale
  // Supabase row can never surface a button that would revert.
  try {
    const info = await readMatchInfo(currentMatch.contract_address);
    if (info && info.status) {
      currentMatch.status = info.status;                 // AUTHORITATIVE on-chain status
      currentMatch.result = info.result || currentMatch.result;
      if (info.final_score) currentMatch.final_score = info.final_score;
      if (info.kickoff_ts) currentMatch.onchain_kickoff_ts = Number(info.kickoff_ts);
    }
  } catch (e) { console.warn('on-chain match info read failed:', e.message); }

  try {
    const ai = await getAIPrediction(matchId);
    if (ai) cachedAIPreds[matchId] = ai;
  } catch (e) { console.warn('AI pred read failed:', e.message); }

  // Read my prediction. The CHAIN is the source of truth; Supabase is a mirror.
  const state = getWalletState();
  myPrediction = null;
  if (state.address) {
    let onchain = null;
    try { onchain = await readMyPrediction(currentMatch.contract_address, state.address); }
    catch (e) { console.warn('on-chain prediction read failed:', e.message); }

    const mirrored = await readMyPredictionFromSupabase(matchId, state.address);

    if (onchain) {
      myPrediction = {
        pick: onchain.pick,
        stake: onchain.stake,
        claimed: onchain.claimed,
        refunded: mirrored?.refunded ?? false,
      };
      if (!mirrored) mirrorPrediction(matchId, state.address, 'predict').catch(() => {});
    } else {
      myPrediction = mirrored;
    }
  }

  el.innerHTML = matchDetailHtml(currentMatch, currentPools, myPrediction, state);
  attachMatchDetailEvents();
}

function aiCallPanelHtml(m) {
  const ai = cachedAIPreds[m.match_id];
  if (!ai || !ai.pick) return '';
  const pickTeam = ai.pick === 'home' ? m.home : ai.pick === 'away' ? m.away : 'Draw';
  return `
    <div class="ai-call-panel" data-pick="${ai.pick}">
      <div class="ai-call-head">
        <span class="ai-call-mark">AI</span>
        <p class="eyebrow" style="margin:0;">GenLayer's call</p>
        ${ai.confidence ? `<span class="ai-badge-conf">${ai.confidence} confidence</span>` : ''}
      </div>
      <div class="ai-call-pick">${pickTeam}</div>
      ${ai.reason ? `<p class="ai-call-reason">"${ai.reason}"</p>` : ''}
      <p class="ai-call-foot">The validators' own pre-match forecast, reached by consensus on-chain — separate from the crowd's pools below.</p>
    </div>`;
}

function matchDetailHtml(m, pools, mine, state) {
  const date = new Date(m.kickoff_ts * 1000);
  const dateLabel = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const timeLabel = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const stageLabel = m.matchday ? `Matchday ${m.matchday}` : 'UCL 26/27';

  const POSTPONE_GRACE_SECS = 10800; // 3h — matches the contract
  const total = Number(pools.total) || 0;
  const isResolved = m.status === 'resolved' || m.status === 'finished';
  const isRefunding = m.status === 'refunding';
  const isPostponedPending = m.offchain_postponed && m.status === 'open';
  const nowSec = Math.floor(Date.now() / 1000);
  const kickoff = Number(m.onchain_kickoff_ts || m.kickoff_ts || 0);
  const canMarkPostponed = m.status === 'open' && nowSec >= kickoff + POSTPONE_GRACE_SECS;
  const canPredict = (m.status === 'scheduled' || m.status === 'open') && !mine
    && nowSec < kickoff;
  const liveScore = (m.status === 'live' || m.status === 'finished' || m.status === 'resolved')
    ? `<span class="live-score-display">${m.live_score_home ?? 0} <span class="live-score-sep">·</span> ${m.live_score_away ?? 0}</span>`
    : '';
  const statusBadge = m.status === 'live'
    ? `<span class="status-badge is-live">LIVE${m.live_minute ? ` · ${m.live_minute}` : ''}</span>`
    : isResolved
      ? `<span class="status-badge is-resolved">FT · ${m.result?.toUpperCase()}</span>`
      : isRefunding
        ? `<span class="status-badge is-warning">REFUNDING · claim your stake</span>`
        : isPostponedPending
          ? `<span class="status-badge is-muted">POSTPONED · awaiting on-chain confirmation</span>`
          : `<span class="status-badge">${dateLabel} · ${timeLabel}</span>`;

  return `
    <div class="match-detail">
      <div class="match-detail-header">
        <p class="eyebrow">${stageLabel}</p>
        <div class="match-detail-teams">
          <div class="match-detail-team">
            ${crestImg(m.home, 120, 'match-detail-crest')}
            <h2 class="match-detail-team-name">${m.home}</h2>
          </div>
          ${liveScore || '<span class="match-detail-vs">vs</span>'}
          <div class="match-detail-team">
            ${crestImg(m.away, 120, 'match-detail-crest')}
            <h2 class="match-detail-team-name">${m.away}</h2>
          </div>
        </div>
        <div class="match-detail-meta">${statusBadge}</div>
      </div>

      ${aiCallPanelHtml(m)}

      ${mine ? renderMyPredictionPanel(mine, m) : ''}

      ${canPredict ? renderPredictForm(m, pools, state) : ''}

      ${postponePanelHtml(m, state, canMarkPostponed, isPostponedPending)}

      ${!canPredict && !mine && !isPostponedPending && !canMarkPostponed ? `
        <div class="empty-state" style="margin-top: var(--sp-8);">
          ${m.status === 'live' ? 'Predictions are closed — match is live.' :
            isResolved ? 'Predictions are closed — match has ended.' :
            isRefunding ? 'This match is being refunded — claim your stake below.' :
            'Predictions are not currently open.'}
        </div>
      ` : ''}

      <div class="pools-display">
        <p class="eyebrow" style="margin-bottom: var(--sp-3);">Current pools</p>
        <div class="pools-bars">
          ${poolBar('Home', m.home, pools.home, total)}
          ${poolBar('Draw', null, pools.draw, total)}
          ${poolBar('Away', m.away, pools.away, total)}
        </div>
        <p class="pools-total">Total staked: <strong>${formatGen(pools.total)} GEN</strong></p>
      </div>
    </div>
  `;
}

function poolBar(label, team, value, total) {
  const pctNum = total === 0 ? 0 : Number(value) * 100 / total;
  return `
    <div class="pool-bar">
      <div class="pool-bar-header">
        <span class="pool-bar-label">${label}${team ? ` · ${team}` : ''}</span>
        <span class="pool-bar-value">${formatGen(value)} GEN</span>
      </div>
      <div class="pool-bar-track"><div class="pool-bar-fill" style="width: ${pctNum}%"></div></div>
      <span class="pool-bar-pct">${total === 0 ? '—' : pctNum.toFixed(1) + '%'}</span>
    </div>
  `;
}

// Permissionless postponement panel — the real application path for
// mark_postponed(). Shown only while the market is OPEN on-chain; it can
// never appear over a resolved or already-refunding market. It opens refunds
// by asking the CONTRACT to verify — it never flips the UI to a refund state
// by itself.
function postponePanelHtml(m, state, canMarkPostponed, isPostponedPending) {
  if (m.status !== 'open') return '';
  if (!canMarkPostponed && !isPostponedPending) return '';
  const connected = Boolean(state.address);
  const onNet = state.isStudionet;
  const hint = isPostponedPending
    ? `A results source lists this fixture as <strong>postponed / called off</strong>. That is an off-chain signal only — <strong>refunds are not open yet</strong>. Confirm it on-chain to open refunds.`
    : `This match is past kickoff + 3h and still isn't settled. If it was postponed or abandoned, anyone can open the refund path — it's permissionless.`;
  const label = !connected ? 'Connect wallet to confirm'
    : !onNet ? 'Switch to Bradbury'
    : !canMarkPostponed ? 'Available 3h after kickoff'
    : 'Confirm postponement on-chain';
  const disabled = !connected || !onNet || !canMarkPostponed;
  return `
    <div class="postpone-panel">
      <p class="eyebrow">Postponement</p>
      <p class="postpone-hint">${hint}</p>
      <button class="secondary-button" id="mark-postponed-btn"${disabled ? ' disabled' : ''}>${label}</button>
      <p class="predict-disclaimer">
        Runs <code>mark_postponed()</code>: the contract re-checks BBC + ESPN under consensus and opens
        refunds <strong>only</strong> if both confirm the game wasn't played. Any finished result blocks it.
      </p>
    </div>`;
}

function renderMyPredictionPanel(mine, m) {
  const isResolved = m.status === 'resolved' || m.status === 'finished';
  const isRefunding = m.status === 'refunding';
  const won = isResolved && m.result === mine.pick;
  const lost = isResolved && m.result && m.result !== mine.pick;

  let actionBtn = '';
  if (isResolved && won && !mine.claimed) {
    actionBtn = `<button class="primary-button" id="claim-btn">Claim winnings</button>`;
  } else if (isRefunding && !mine.refunded) {
    actionBtn = `<button class="secondary-button" id="refund-btn">Claim refund</button>`;
  } else if (mine.claimed || mine.refunded) {
    actionBtn = `<span class="status-badge is-claimed">${mine.claimed ? 'Claimed' : 'Refunded'}</span>`;
  }

  return `
    <div class="my-prediction-panel">
      <p class="eyebrow">Your pick</p>
      <div class="my-prediction-content">
        <div>
          <div class="my-prediction-pick">${mine.pick.toUpperCase()}</div>
          <div class="my-prediction-stake">${formatGen(mine.stake)} GEN staked</div>
        </div>
        <div>
          ${won ? '<div class="pick-status pick-won">✓ Won</div>' : ''}
          ${lost ? '<div class="pick-status pick-lost">Lost</div>' : ''}
          ${!isResolved && !isRefunding ? '<div class="pick-status pick-pending">Pending</div>' : ''}
          ${actionBtn}
        </div>
      </div>
    </div>
  `;
}

function renderPredictForm(m, pools, state) {
  const connected = Boolean(state.address);
  const onCorrectNet = state.isStudionet;
  return `
    <div class="predict-form">
      <p class="eyebrow">Make your pick</p>
      <div class="pick-buttons">
        <button class="pick-button" data-pick="home">
          ${crestImg(m.home, 40, 'pick-crest')}
          <span class="pick-button-label">${m.home}</span>
          <span class="pick-button-meta">Home</span>
        </button>
        <button class="pick-button" data-pick="draw">
          <span class="pick-draw-icon">⚖</span>
          <span class="pick-button-label">Draw</span>
          <span class="pick-button-meta">—</span>
        </button>
        <button class="pick-button" data-pick="away">
          ${crestImg(m.away, 40, 'pick-crest')}
          <span class="pick-button-label">${m.away}</span>
          <span class="pick-button-meta">Away</span>
        </button>
      </div>

      <div class="stake-row">
        <label class="stake-input-wrap">
          <span class="stake-label">Stake</span>
          <input type="number" id="stake-input" min="${MIN_STAKE_GEN}" step="0.1" placeholder="${MIN_STAKE_GEN}" inputmode="decimal">
          <span class="stake-suffix">GEN</span>
        </label>
        <div class="payout-display">
          <span class="payout-label">Expected payout</span>
          <span class="payout-value" id="expected-payout">— GEN</span>
        </div>
      </div>

      <button class="primary-button" id="submit-prediction-btn" disabled>
        ${!connected ? 'Connect wallet to predict' : !onCorrectNet ? 'Switch to Bradbury' : 'Pick a side'}
      </button>

      <p class="predict-disclaimer">
        Minimum ${MIN_STAKE_GEN} GEN. Pool splits among winning predictors when the match resolves.
      </p>
    </div>
  `;
}

function attachMatchDetailEvents() {
  const pickBtns = document.querySelectorAll('.pick-button');
  const stakeInput = document.getElementById('stake-input');
  const submitBtn = document.getElementById('submit-prediction-btn');
  const payoutEl = document.getElementById('expected-payout');

  pickBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      pickBtns.forEach((b) => b.classList.remove('is-selected'));
      btn.classList.add('is-selected');
      currentPick = btn.dataset.pick;
      updatePayout();
      updateSubmitState();
    });
  });

  stakeInput?.addEventListener('input', () => {
    updatePayout();
    updateSubmitState();
  });

  function updatePayout() {
    if (!currentPick || !stakeInput?.value) { payoutEl.textContent = '— GEN'; return; }
    const stake = parseFloat(stakeInput.value);
    if (!isFinite(stake) || stake < MIN_STAKE_GEN) { payoutEl.textContent = '— GEN'; return; }
    const stakeWei = toWei(stake);
    const pickPool = currentPools[currentPick];
    const expected = computeExpectedPayout(stakeWei, pickPool, currentPools.total);
    payoutEl.textContent = `~${formatGen(expected, 2)} GEN`;
  }

  function updateSubmitState() {
    const state = getWalletState();
    if (!state.address) { submitBtn.disabled = true; submitBtn.textContent = 'Connect wallet to predict'; return; }
    if (!state.isStudionet) { submitBtn.disabled = true; submitBtn.textContent = 'Switch to Bradbury'; return; }
    if (!currentPick) { submitBtn.disabled = true; submitBtn.textContent = 'Pick a side'; return; }
    const stake = parseFloat(stakeInput?.value || 0);
    if (!isFinite(stake) || stake < MIN_STAKE_GEN) { submitBtn.disabled = true; submitBtn.textContent = `Min ${MIN_STAKE_GEN} GEN`; return; }
    submitBtn.disabled = false;
    submitBtn.textContent = `Predict ${currentPick.toUpperCase()} · ${stake} GEN`;
  }

  submitBtn?.addEventListener('click', async () => {
    if (submitBtn.disabled) return;
    const state = getWalletState();
    const stake = parseFloat(stakeInput.value);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Confirming in wallet…';
    try {
      await submitPrediction(currentMatch.contract_address, currentPick, stake);
      submitBtn.textContent = 'Submitting…';

      const mirror = await mirrorPrediction(currentMatch.match_id, state.address, 'predict');
      if (!mirror.ok) {
        console.error('mirror error:', mirror.error);
        showToast(`Prediction is on-chain; the mirror will catch up shortly.`, 'error');
      } else {
        showToast(`Prediction submitted: ${currentPick.toUpperCase()} · ${stake} GEN`);
      }

      await renderMatchDetail(currentMatch.match_id);
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Prediction failed', 'error');
      submitBtn.disabled = false;
      updateSubmitState();
    }
  });

  document.getElementById('claim-btn')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Claiming…';
    try {
      await claim(currentMatch.contract_address);
      await mirrorPrediction(currentMatch.match_id, getWalletState().address, 'claim');
      showToast('Winnings claimed! 🎉');
      await renderMatchDetail(currentMatch.match_id);
    } catch (err) { showToast(err.message || 'Claim failed', 'error'); e.target.disabled = false; e.target.textContent = 'Claim winnings'; }
  });

  document.getElementById('refund-btn')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Refunding…';
    try {
      await refund(currentMatch.contract_address);
      await mirrorPrediction(currentMatch.match_id, getWalletState().address, 'refund');
      showToast('Refund claimed');
      await renderMatchDetail(currentMatch.match_id);
    } catch (err) { showToast(err.message || 'Refund failed', 'error'); e.target.disabled = false; e.target.textContent = 'Claim refund'; }
  });

  document.getElementById('mark-postponed-btn')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Confirming on-chain…';
    try {
      await markPostponed(currentMatch.contract_address);
      await renderMatchDetail(currentMatch.match_id);
      if (currentMatch.status === 'refunding') {
        showToast('Postponement confirmed on-chain — refunds are now open.');
      } else {
        showToast('Submitted, but the sources did not confirm a postponement. The market stays open.', 'error');
      }
    } catch (err) {
      showToast(err.message || 'mark_postponed failed', 'error');
      e.target.disabled = false; e.target.textContent = 'Confirm postponement on-chain';
    }
  });
}

// ─────────────────────────────────────────────────────────── MY PICKS

async function renderMyPicks() {
  const el = document.getElementById('my-predictions');
  const state = getWalletState();
  if (!state.address) {
    el.innerHTML = '<div class="empty-state"><p>Connect your wallet to see your predictions.</p></div>';
    return;
  }

  el.innerHTML = '<div class="empty-state">Loading your picks…</div>';

  try {
    const { data, error } = await sb
      .from('predictions')
      .select('*')
      .ilike('user_address', state.address)
      .order('submitted_at', { ascending: false });

    if (error) {
      console.error(error);
      el.innerHTML = `<div class="empty-state">Couldn't load picks: ${error.message}</div>`;
      return;
    }
    if (!data || data.length === 0) {
      el.innerHTML = `
        <div class="empty-state">
          <p>You haven't made any predictions yet.</p>
          <p style="margin-top: var(--sp-3);"><a href="#/" class="link-accent">Browse matches →</a></p>
        </div>`;
      return;
    }

    const matchIds = [...new Set(data.map((p) => p.match_id))];
    const { data: matchRows } = await sb
      .from('matches')
      .select('match_id, home, away, kickoff_ts, status, result, matchday')
      .in('match_id', matchIds);
    const matchById = {};
    (matchRows || []).forEach((m) => { matchById[m.match_id] = m; });
    data.forEach((p) => { p.matches = matchById[p.match_id] || null; });

    let totalStaked = 0n;
    let wonCount = 0;
    let lostCount = 0;
    let pendingCount = 0;
    let claimedCount = 0;
    data.forEach((p) => {
      totalStaked += BigInt(p.stake_wei);
      const m = p.matches;
      const isResolved = m?.status === 'resolved' || m?.status === 'finished';
      if (isResolved && m.result === p.pick) wonCount++;
      else if (isResolved && m.result && m.result !== p.pick) lostCount++;
      else pendingCount++;
      if (p.claimed) claimedCount++;
    });

    el.innerHTML = `
      <div class="my-picks-stats">
        <div class="my-picks-stat">
          <div class="my-picks-stat-value">${data.length}</div>
          <div class="my-picks-stat-label">Total picks</div>
        </div>
        <div class="my-picks-stat">
          <div class="my-picks-stat-value">${formatGen(totalStaked)}</div>
          <div class="my-picks-stat-label">GEN staked</div>
        </div>
        <div class="my-picks-stat">
          <div class="my-picks-stat-value pick-won">${wonCount}</div>
          <div class="my-picks-stat-label">Won</div>
        </div>
        <div class="my-picks-stat">
          <div class="my-picks-stat-value pick-lost">${lostCount}</div>
          <div class="my-picks-stat-label">Lost</div>
        </div>
        <div class="my-picks-stat">
          <div class="my-picks-stat-value">${pendingCount}</div>
          <div class="my-picks-stat-label">Pending</div>
        </div>
      </div>

      <div class="my-picks-list">
        ${data.map(myPickCardHtml).join('')}
      </div>
    `;
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="empty-state">Couldn't load picks: ${e.message}</div>`;
  }
}

function myPickCardHtml(p) {
  const m = p.matches || {};
  const date = new Date((m.kickoff_ts || 0) * 1000);
  const dateLabel = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const stageLabel = m.matchday ? `Matchday ${m.matchday}` : 'UCL 26/27';
  const isResolved = m.status === 'resolved' || m.status === 'finished';
  const won = isResolved && m.result === p.pick;
  const lost = isResolved && m.result && m.result !== p.pick;

  let statusBadge;
  if (won) statusBadge = '<span class="pick-status pick-won">✓ Won</span>';
  else if (lost) statusBadge = '<span class="pick-status pick-lost">Lost</span>';
  else statusBadge = '<span class="pick-status pick-pending">Pending</span>';

  const pickedTeam = p.pick === 'home' ? m.home : p.pick === 'away' ? m.away : 'Draw';

  return `
    <a href="#/match/${p.match_id}" class="my-pick-card">
      <div class="my-pick-card-header">
        <span class="my-pick-stage">${stageLabel}</span>
        <span class="my-pick-date">${dateLabel}</span>
      </div>
      <div class="my-pick-teams">
        ${crestImg(m.home, 40, 'my-pick-crest')}<span>${m.home || '?'}</span>
        <span class="my-pick-vs">vs</span>
        ${crestImg(m.away, 40, 'my-pick-crest')}<span>${m.away || '?'}</span>
      </div>
      <div class="my-pick-detail">
        <div>
          <div class="my-pick-label">Your pick</div>
          <div class="my-pick-value">${pickedTeam}</div>
        </div>
        <div>
          <div class="my-pick-label">Stake</div>
          <div class="my-pick-value">${formatGen(BigInt(p.stake_wei))} GEN</div>
        </div>
        <div>${statusBadge}</div>
      </div>
    </a>
  `;
}

// ─────────────────────────────────────────────────────────── LEADERBOARD

async function renderLeaderboard() {
  const el = document.getElementById('leaderboard-list');
  el.innerHTML = '<div class="empty-state">Loading leaderboard…</div>';

  try {
    const { data: preds, error: pErr } = await sb
      .from('predictions')
      .select('user_address, pick, stake_wei, match_id');

    if (pErr) {
      console.error(pErr);
      el.innerHTML = `<div class="empty-state">Couldn't load leaderboard: ${pErr.message}</div>`;
      return;
    }

    if (!preds || preds.length === 0) {
      el.innerHTML = `<div class="empty-state">No predictions yet. Be the first to predict!</div>`;
      return;
    }

    const matchIds = [...new Set(preds.map((p) => p.match_id))];
    const { data: matchRows } = await sb
      .from('matches')
      .select('match_id, status, result')
      .in('match_id', matchIds);
    const matchById = {};
    (matchRows || []).forEach((m) => { matchById[m.match_id] = m; });
    preds.forEach((p) => { p.matches = matchById[p.match_id] || null; });

    const { data: users } = await sb.from('users').select('user_address, username');
    const usernameByAddr = {};
    (users || []).forEach((u) => { usernameByAddr[(u.user_address || '').toLowerCase()] = u.username; });

    const byUser = {};
    preds.forEach((p) => {
      const addr = (p.user_address || '').toLowerCase();
      if (!byUser[addr]) {
        byUser[addr] = {
          address: addr,
          username: usernameByAddr[addr] || null,
          total: 0,
          won: 0,
          lost: 0,
          pending: 0,
          stakedWei: 0n,
          wonStakeWei: 0n,
        };
      }
      const u = byUser[addr];
      u.total++;
      const stake = BigInt(p.stake_wei || 0);
      u.stakedWei += stake;
      const m = p.matches;
      const isResolved = m?.status === 'resolved' || m?.status === 'finished';
      if (isResolved && m.result === p.pick) { u.won++; u.wonStakeWei += stake; }
      else if (isResolved && m.result && m.result !== p.pick) u.lost++;
      else u.pending++;
    });

    const rows = Object.values(byUser)
      .sort((a, b) => {
        if (b.won !== a.won) return b.won - a.won;
        if (b.wonStakeWei !== a.wonStakeWei) return b.wonStakeWei > a.wonStakeWei ? 1 : -1;
        return b.total - a.total;
      })
      .slice(0, 50);

    el.innerHTML = `
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th class="num">Picks</th>
            <th class="num">Won</th>
            <th class="num">Lost</th>
            <th class="num">Staked</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td class="rank">${i + 1}</td>
              <td class="player">
                <span class="player-name">${r.username || (r.address.slice(0, 6) + '…' + r.address.slice(-4))}</span>
              </td>
              <td class="num">${r.total}</td>
              <td class="num pick-won">${r.won}</td>
              <td class="num pick-lost">${r.lost}</td>
              <td class="num mono">${formatGen(r.stakedWei)} GEN</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="empty-state">Couldn't load leaderboard: ${e.message}</div>`;
  }
}

// ─────────────────────────────────────────────────────────── TABLE

async function renderTable() {
  const el = document.getElementById('table-list');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Loading table…</div>';

  try {
    const rows = await getStandings();
    if (!rows.length) {
      el.innerHTML = `<div class="empty-state">The Champions League table is empty — league phase hasn't started yet. Check back after 8 Sep 2026.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="standings-wrap">
        <table class="standings-table">
          <thead>
            <tr>
              <th class="col-pos">#</th>
              <th class="col-team">Club</th>
              <th class="col-num" title="Played">P</th>
              <th class="col-num" title="Won">W</th>
              <th class="col-num" title="Drawn">D</th>
              <th class="col-num" title="Lost">L</th>
              <th class="col-num" title="Goals For">GF</th>
              <th class="col-num" title="Goals Against">GA</th>
              <th class="col-num" title="Goal Difference">GD</th>
              <th class="col-pts" title="Points">Pts</th>
              <th class="col-form" title="Last 5">Form</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(standingsRowHtml).join('')}
          </tbody>
        </table>
        <p class="standings-foot">Via BBC Sport · Updated every ~3 hours · Top 8 advance to R16 · 9–24 play-off · 25–36 out</p>
      </div>
    `;
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="empty-state">Couldn't load table: ${e.message}</div>`;
  }
}

function standingsRowHtml(r) {
  const gd = r.goal_difference >= 0 ? `+${r.goal_difference}` : `${r.goal_difference}`;
  const formDots = (r.form || '')
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter((f) => f === 'W' || f === 'D' || f === 'L')
    .slice(-5)
    .map((f) => {
      const cls = f === 'W' ? 'form-w' : f === 'L' ? 'form-l' : 'form-d';
      return `<span class="form-dot ${cls}" title="${f === 'W' ? 'Win' : f === 'L' ? 'Loss' : 'Draw'}">${f}</span>`;
    }).join('');

  // Qualification band — top 8 auto R16, 9-24 knockout play-off, 25-36 out.
  const band = r.position <= 8 ? 'band-r16'
    : r.position <= 24 ? 'band-playoff'
    : 'band-out';

  return `
    <tr class="${band}">
      <td class="col-pos">${r.position}</td>
      <td class="col-team">
        <div class="team-cell">
          ${r.crest ? `<img src="${r.crest}" alt="${r.team}" class="standings-crest" width="20" height="20" loading="lazy">` : ''}
          <span class="standings-name">${r.team}</span>
          <span class="standings-short">${r.short_name || ''}</span>
        </div>
      </td>
      <td class="col-num">${r.played}</td>
      <td class="col-num">${r.won}</td>
      <td class="col-num">${r.draw}</td>
      <td class="col-num">${r.lost}</td>
      <td class="col-num">${r.goals_for}</td>
      <td class="col-num">${r.goals_against}</td>
      <td class="col-num ${r.goal_difference > 0 ? 'gd-pos' : r.goal_difference < 0 ? 'gd-neg' : ''}">${gd}</td>
      <td class="col-pts">${r.points}</td>
      <td class="col-form"><div class="form-cell">${formDots}</div></td>
    </tr>
  `;
}

// ─────────────────────────────────────────────────────────── BOOT

window.addEventListener('DOMContentLoaded', async () => {
  render();
  await trySilentReconnect();
});

window.showToast = showToast;

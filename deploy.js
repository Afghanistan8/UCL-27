// deploy.js
// Deploy PredictionMarket contracts to GenLayer Bradbury for the 2026/27
// UEFA Champions League league phase. Deploys every fixture in fixtures.json
// by default; pass --matchday N to deploy just one matchday's fixtures at a
// time (keeps each run comfortably short — a full matchday is 18 markets).
//
// Run: node deploy.js               (all fixtures in fixtures.json)
//      node deploy.js --matchday 1  (only matchday 1)
//
// Resumable: if interrupted, re-running skips matches already deployed
// (uses deploy_checkpoint.json as a local log). The checkpoint records the
// contract address the moment it's deployed - BEFORE the Supabase mirror - so
// a transient Supabase error can never cause a duplicate contract deploy.

import { createClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import 'dotenv/config';


// ----------------------------------------------------- env
const { PRIVATE_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!PRIVATE_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing env vars. Copy .env.example to .env and fill in.');
  process.exit(1);
}

// ----------------------------------------------------- optional matchday filter
const mdArgIdx = process.argv.indexOf('--matchday');
const onlyMatchday = mdArgIdx !== -1 ? Number(process.argv[mdArgIdx + 1]) : null;

// ----------------------------------------------------- inputs
const contractCode = readFileSync('./prediction_market.py', 'utf-8');
let fixtures = JSON.parse(readFileSync('./fixtures.json', 'utf-8'));
if (onlyMatchday !== null) {
  fixtures = fixtures.filter((f) => f.matchday === onlyMatchday);
  console.log(`Filtered to matchday ${onlyMatchday}: ${fixtures.length} fixtures`);
}
console.log(`Loaded ${fixtures.length} fixtures and contract source\n`);

// ----------------------------------------------------- clients
const account = createAccount(PRIVATE_KEY);
console.log(`Deploying from: ${account.address}`);

const client = createClient({
  chain: testnetBradbury,
  account,
});

const sb = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ----------------------------------------------------- checkpoint
const checkpointPath = './deploy_checkpoint.json';
let deployed = {};
if (existsSync(checkpointPath)) {
  deployed = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
  console.log(`Resuming: ${Object.keys(deployed).length} already deployed\n`);
}
const saveCheckpoint = () =>
  writeFileSync(checkpointPath, JSON.stringify(deployed, null, 2));

// ----------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dateFromKickoff(kickoff_ts) {
  // YYYY-MM-DD in UTC - what the contract uses to build the BBC URL
  return new Date(kickoff_ts * 1000).toISOString().slice(0, 10);
}

function extractContractAddress(receipt) {
  return (
    receipt?.data?.contract_address ||
    receipt?.contract_address ||
    receipt?.contractAddress ||
    receipt?.recipient ||
    receipt?.to ||
    receipt?.tx_data_decoded?.contract_address ||
    receipt?.tx_data?.contract_address ||
    null
  );
}

// ----------------------------------------------------- main loop
let okCount = 0;
let skipCount = 0;
let failCount = 0;
const failures = [];
const mirrorFailures = [];

// Mirror one match's metadata + zeroed pools to Supabase. Called for freshly
// deployed AND already-checkpointed matches, so a re-run after the tables are
// created backfills any mirror that failed the first time. Best-effort.
async function mirrorToSupabase(f, contractAddress) {
  try {
    const { error: mErr } = await sb.from('matches').upsert({
      match_id: f.match_id,
      contract_address: contractAddress,
      home: f.home,
      away: f.away,
      kickoff_ts: f.kickoff_ts,
      matchday: f.matchday,
      external_match_id: f.external_match_id ?? null,
      status: 'scheduled',
    });
    if (mErr) throw new Error(`matches.upsert: ${mErr.message}`);

    const { error: pErr } = await sb.from('pools').upsert({
      match_id: f.match_id,
      pool_home_wei: 0,
      pool_draw_wei: 0,
      pool_away_wei: 0,
      total_wei: 0,
    });
    if (pErr) throw new Error(`pools.upsert: ${pErr.message}`);
    return true;
  } catch (sbErr) {
    mirrorFailures.push({ match_id: f.match_id, contract_address: contractAddress, error: sbErr.message });
    return false;
  }
}

// The betting deadline is the kickoff itself (submit_prediction reverts at/after
// kickoff_ts), so a market for a match that has ALREADY started can never take a
// bet. Skip any such fixture entirely — don't deploy it and don't re-mirror it.
const nowSec = Math.floor(Date.now() / 1000);

for (let i = 0; i < fixtures.length; i++) {
  const f = fixtures[i];
  const game_date = dateFromKickoff(f.kickoff_ts);
  const label = `[${i + 1}/${fixtures.length}] ${f.match_id} ${f.home} vs ${f.away} (${game_date})`;

  if (f.kickoff_ts <= nowSec) {
    console.log(`- ${label}  ->  SKIPPED (kickoff already passed; betting is closed)`);
    skipCount++;
    continue;
  }

  if (deployed[f.match_id]) {
    const ok = await mirrorToSupabase(f, deployed[f.match_id]);
    console.log(`= ${label}  ->  ${deployed[f.match_id]}  (already deployed${ok ? ', mirror ok' : ', mirror failed'})`);
    skipCount++;
    continue;
  }

  console.log(`\n-> ${label}`);

  try {
    // Deploy the contract. Constructor: (team1, team2, game_date, kickoff_ts).
    // kickoff_ts (Unix epoch seconds) is the on-chain betting deadline:
    // submit_prediction() reverts at/after it, so no stake lands post-kickoff.
    const txHash = await client.deployContract({
      code: contractCode,
      args: [f.home, f.away, game_date, f.kickoff_ts],
      leaderOnly: false,
    });
    console.log(`  tx: ${txHash}`);

    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      status: TransactionStatus.ACCEPTED,
      retries: 60,    // up to ~5 min
      interval: 5000,
    });

    const contractAddress = extractContractAddress(receipt);
    if (!contractAddress) {
      console.error('  receipt:', JSON.stringify(receipt, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2).slice(0, 2000));
      throw new Error('No contract_address in receipt');
    }
    console.log(`  OK ${contractAddress}`);

    // Record the address IMMEDIATELY, before the Supabase mirror. A Supabase
    // hiccup must never make us redeploy a contract that already exists.
    deployed[f.match_id] = contractAddress;
    saveCheckpoint();
    okCount++;

    const ok = await mirrorToSupabase(f, contractAddress);
    if (!ok) console.error(`  ! deployed OK but Supabase mirror failed (will retry on re-run)`);

    // Small pause between deploys (be gentle to the network)
    await sleep(2000);
  } catch (err) {
    console.error(`  x FAILED: ${err.message}`);
    failures.push({ match_id: f.match_id, error: err.message });
    failCount++;
  }
}

// ----------------------------------------------------- summary
console.log('\n========== DEPLOY COMPLETE ==========');
console.log(`Deployed:  ${okCount}`);
console.log(`Skipped:   ${skipCount}  (already in checkpoint or kicked off)`);
console.log(`Failed:    ${failCount}`);
console.log(`Total:     ${fixtures.length}`);

if (mirrorFailures.length) {
  console.log('\nSupabase mirror failures (contracts ARE deployed; re-run to retry mirrors once tables exist):');
  mirrorFailures.forEach((f) => console.log(`  ${f.match_id}: ${f.contract_address} - ${f.error}`));
}

if (failures.length) {
  console.log('\nFailed deploys:');
  failures.forEach((f) => console.log(`  ${f.match_id}: ${f.error}`));
  console.log('\nRe-run this script to retry failed deploys (checkpoint prevents duplicates).');
  process.exit(1);
}

if (!mirrorFailures.length && !failures.length) {
  console.log('\nAll matches deployed and indexed in Supabase.');
}

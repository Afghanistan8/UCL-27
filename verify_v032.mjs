// verify_v032.mjs — prove the deployed markets are the HARDENED v0.3.2.
//
// THE FINGERPRINT: resolve_attempts after a pre-kickoff resolve().
//
//   v0.3.1:  status check -> resolve_attempts += 1 -> render web -> LLM
//            A pre-kickoff call is ACCEPTED and the counter becomes 1.
//   v0.3.2:  status check -> TIME GATE (revert) -> resolve_attempts += 1
//            A pre-kickoff call REVERTS, so the counter stays 0.
//
// The counter is a public view, so this is verifiable by anyone, read-only,
// after a single cheap write. It does not depend on parsing a revert string
// out of the consensus receipt (which Bradbury does not surface in plain text).
//
// Run: node verify_v032.mjs [match_id]        # defaults to ucl2027_md1_02
//      node verify_v032.mjs --ab              # A/B the new vs old contract
import { createClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { readFileSync, existsSync } from 'fs';
import 'dotenv/config';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THROTTLE = /rate limit|capacity|exceeds defined limit|fetch failed|econnreset/i;

const account = createAccount(process.env.PRIVATE_KEY);
const client = createClient({ chain: testnetBradbury, account });

async function readInfo(address) {
  return client.readContract({ address, functionName: 'get_match_info', args: [] });
}

// Submit resolve(), tolerating Bradbury's throttle. Returns true if the tx was
// accepted by the node, false if the node itself rejected the call.
async function tryResolve(address) {
  for (let i = 1; i <= 10; i++) {
    try {
      const txHash = await client.writeContract({
        address, functionName: 'resolve', args: [], value: 0n,
      });
      await client.waitForTransactionReceipt({
        hash: txHash, status: 'ACCEPTED', retries: 60, interval: 5000,
      });
      return true;
    } catch (err) {
      const msg = err?.message || String(err);
      if (THROTTLE.test(msg)) {
        await sleep(2000 * i);
        continue;
      }
      return false;
    }
  }
  return false;
}

async function probe(label, address) {
  const before = await readInfo(address);
  const kickoffMs = Number(before.kickoff_ts) * 1000;
  if (Date.now() >= kickoffMs) {
    console.log(`${label}: INCONCLUSIVE — kickoff already passed`);
    return null;
  }

  console.log(`${label}`);
  console.log(`  address          : ${address}`);
  console.log(`  ${before.team1} vs ${before.team2}`);
  console.log(`  kickoff          : ${new Date(kickoffMs).toISOString()}`);
  console.log(`  attempts BEFORE  : ${before.resolve_attempts}`);

  await tryResolve(address);

  const after = await readInfo(address);
  console.log(`  attempts AFTER   : ${after.resolve_attempts}`);
  console.log(`  status           : ${after.status}`);
  console.log(`  result           : "${after.result}"`);

  const bumped = Number(after.resolve_attempts) > Number(before.resolve_attempts);
  const verdict = bumped ? 'v0.3.1 (no time gate — call was accepted)'
                         : 'v0.3.2 (time gate reverted before the counter)';
  console.log(`  => ${verdict}\n`);
  return { bumped, before, after };
}

const ab = process.argv.includes('--ab');
const matchId = process.argv.find((a) => a.startsWith('ucl2027_')) || 'ucl2027_md1_02';

const cp = JSON.parse(readFileSync('./deploy_checkpoint.json', 'utf-8'));
const newAddr = cp[matchId];
if (!newAddr) { console.error(`no checkpoint address for ${matchId}`); process.exit(1); }

console.log(`now: ${new Date().toISOString()}\n`);
const fresh = await probe('NEW contract (expected v0.3.2)', newAddr);

if (ab && existsSync('./deploy_checkpoint.v0.3.1.json')) {
  const oldCp = JSON.parse(readFileSync('./deploy_checkpoint.v0.3.1.json', 'utf-8'));
  const oldAddr = oldCp[matchId];
  if (oldAddr) {
    const stale = await probe('OLD contract (known v0.3.1, control)', oldAddr);
    if (fresh && stale) {
      console.log('==================================================');
      if (!fresh.bumped && stale.bumped) {
        console.log('A/B CONFIRMED: identical call, opposite behaviour.');
        console.log('  old v0.3.1 accepted the pre-kickoff resolve()  -> counter moved');
        console.log('  new v0.3.2 refused it at the time gate         -> counter unchanged');
      } else {
        console.log('A/B INCONCLUSIVE — see the two probes above.');
      }
    }
  }
}

if (fresh && !fresh.bumped) {
  console.log('\nRESULT: v0.3.2 CONFIRMED on the deployed contract.');
} else if (fresh) {
  console.log('\nRESULT: FAILED — the deployed contract behaves like v0.3.1.');
  process.exit(1);
}

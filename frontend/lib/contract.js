/* lib/contract.js
 *
 * Reads + writes against PredictionMarket contracts via genlayer-js on Bradbury.
 */

import { createClient, abi } from 'https://esm.sh/genlayer-js@1.1.8';
import { testnetBradbury } from 'https://esm.sh/genlayer-js@1.1.8/chains';
import { STUDIONET, MIN_STAKE_GEN } from './config.js';
import { ensureStudionet } from './wallet.js';

/* ---------- client ---------- */

// genlayer-js encodes a plain hex string as a STRING, not an Address, so a
// contract read with an `Address` argument (get_my_prediction) reverts once
// the picks map is non-empty. Decode the calldata SPECIAL_ADDR form to a real
// CalldataAddress so the argument is typed correctly.
const SPECIAL_ADDR = (3 << 3) | 0; // 24
function glAddress(hex) {
  const h = String(hex).replace(/^0x/, '');
  const bytes = new Uint8Array(21);
  bytes[0] = SPECIAL_ADDR;
  for (let i = 0; i < 20; i++) bytes[1 + i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return abi.calldata.decode(bytes);
}

let _readClient = null;
function readClient() {
  if (_readClient) return _readClient;
  _readClient = createClient({ chain: testnetBradbury });
  return _readClient;
}

async function writeClient() {
  // Hard gate: guarantee the wallet is on Bradbury before signing, so a stale
  // chain flag can never let a tx reach genlayer-js on the wrong network.
  const provider = await ensureStudionet();
  if (!provider) throw new Error('No wallet provider available.');
  // eth_requestAccounts (not eth_accounts): re-authorizes this origin and
  // prompts if the wallet locked, instead of silently returning [] and
  // hanging the write with no popup.
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const addr = accounts?.[0];
  if (!addr) throw new Error('Wallet not connected.');
  // CRITICAL: genlayer-js reads `config.provider` (top-level) — it builds its
  // OWN transport and IGNORES a viem `transport` key. Passing the chosen
  // provider here makes genlayer-js run its chain check AND sign through the
  // exact wallet the user picked (not window.ethereum, which may be a
  // different extension on the wrong chain).
  return createClient({
    chain: testnetBradbury,
    account: addr,
    provider,
  });
}

/* ---------- helpers ---------- */

// Extract a readable revert reason from a GenLayer tx error. The contract
// raises gl.vm.UserError with a message; this tries to surface it cleanly.
function extractRevertReason(err) {
  const msg = err?.message || String(err);
  const match = msg.match(/(?:reverted:|UserError:)\s*(.+?)(?:\n|$)/i) || msg.match(/^(.+?)$/);
  return match ? match[1].trim() : 'Transaction failed';
}

const GEN_DECIMALS = 18n;
const ONE_GEN = 10n ** GEN_DECIMALS;

export function toWei(genAmount) {
  const [whole, frac = ''] = String(genAmount).split('.');
  const fracPadded = (frac + '0'.repeat(Number(GEN_DECIMALS))).slice(0, Number(GEN_DECIMALS));
  return BigInt(whole || '0') * ONE_GEN + BigInt(fracPadded || '0');
}

export function fromWei(wei) {
  if (typeof wei !== 'bigint') wei = BigInt(wei || 0);
  const whole = wei / ONE_GEN;
  const frac = wei % ONE_GEN;
  return Number(whole) + Number(frac) / Number(ONE_GEN);
}

export function formatGen(wei, digits = 2) {
  return fromWei(wei).toFixed(digits);
}

/* ---------- contract reads ---------- */

export async function readPools(contractAddress) {
  try {
    const c = readClient();
    const result = await c.readContract({
      address: contractAddress,
      functionName: 'get_pools',
      args: [],
    });
    return {
      home: BigInt(result?.home ?? 0),
      draw: BigInt(result?.draw ?? 0),
      away: BigInt(result?.away ?? 0),
      total: BigInt(result?.total ?? 0),
    };
  } catch (e) {
    console.warn('readPools error:', e.message);
    return { home: 0n, draw: 0n, away: 0n, total: 0n };
  }
}

export async function readMyPrediction(contractAddress, userAddress) {
  if (!userAddress) return null;
  try {
    const c = readClient();
    const result = await c.readContract({
      address: contractAddress,
      functionName: 'get_my_prediction',
      args: [glAddress(userAddress)],
    });
    if (!result?.has_predicted) return null;
    return {
      pick: result.pick,
      stake: BigInt(result.stake ?? 0),
      claimed: Boolean(result.claimed),
    };
  } catch (e) {
    console.warn('readMyPrediction error:', e.message);
    return null;
  }
}

export async function readMatchInfo(contractAddress) {
  try {
    const c = readClient();
    return await c.readContract({
      address: contractAddress,
      functionName: 'get_match_info',
      args: [],
    });
  } catch (e) {
    console.warn('readMatchInfo error:', e.message);
    return null;
  }
}

/* Expected payout formula */
export function computeExpectedPayout(stakeWei, pickPoolWei, totalPoolWei) {
  const stake = BigInt(stakeWei || 0);
  const pickPool = BigInt(pickPoolWei || 0);
  const totalPool = BigInt(totalPoolWei || 0);
  if (stake === 0n) return 0n;
  const newPick = pickPool + stake;
  const newTotal = totalPool + stake;
  if (newPick === 0n) return stake;
  return (stake * newTotal) / newPick;
}

/* ---------- contract writes ---------- */

export async function submitPrediction(contractAddress, pick, stakeGenAmount) {
  if (!['home', 'draw', 'away'].includes(pick)) {
    throw new Error('pick must be home / draw / away');
  }
  const stakeNum = Number(stakeGenAmount);
  if (!isFinite(stakeNum) || stakeNum < MIN_STAKE_GEN) {
    throw new Error(`Minimum stake is ${MIN_STAKE_GEN} GEN.`);
  }

  const value = toWei(stakeGenAmount);
  const c = await writeClient();

  const txHash = await c.writeContract({
    address: contractAddress,
    functionName: 'submit_prediction',
    args: [pick],
    value,
  });

  const receipt = await c.waitForTransactionReceipt({
    hash: txHash,
    status: 'ACCEPTED',
    retries: 60,
    interval: 5000,
  });

  return { txHash, receipt };
}

export async function claim(contractAddress) {
  const c = await writeClient();
  try {
    const txHash = await c.writeContract({
      address: contractAddress,
      functionName: 'claim',
      args: [],
    });
    const receipt = await c.waitForTransactionReceipt({
      hash: txHash,
      status: 'ACCEPTED',
      retries: 60,
      interval: 5000,
    });
    return { txHash, receipt };
  } catch (err) {
    throw new Error(extractRevertReason(err));
  }
}

export async function refund(contractAddress) {
  const c = await writeClient();
  try {
    const txHash = await c.writeContract({
      address: contractAddress,
      functionName: 'refund',
      args: [],
    });
    const receipt = await c.waitForTransactionReceipt({
      hash: txHash,
      status: 'ACCEPTED',
      retries: 60,
      interval: 5000,
    });
    return { txHash, receipt };
  } catch (err) {
    throw new Error(extractRevertReason(err));
  }
}

// Permissionless, source-verified postponement. This is the real application
// path for mark_postponed(): anyone can submit it, we WAIT for finality
// (ACCEPTED), and the caller then re-reads get_match_info to decide what to
// show. Crucially, this does NOT itself open refunds — it only asks the
// contract to verify the postponement against BBC + ESPN. Refunds are exposed
// by the UI only once the contract's OWN status becomes 'refunding'.
export async function markPostponed(contractAddress) {
  const c = await writeClient();
  try {
    const txHash = await c.writeContract({
      address: contractAddress,
      functionName: 'mark_postponed',
      args: [],
    });
    const receipt = await c.waitForTransactionReceipt({
      hash: txHash,
      status: 'ACCEPTED',
      retries: 60,
      interval: 5000,
    });
    return { txHash, receipt };
  } catch (err) {
    throw new Error(extractRevertReason(err));
  }
}

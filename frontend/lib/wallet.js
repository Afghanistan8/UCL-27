/* lib/wallet.js
 *
 * Wallet integration (works with OKX, MetaMask, or anything that injects an EVM provider).
 *   - connect / disconnect
 *   - detect & switch to Bradbury (chain 4221 / 0x107d)
 *   - emit address change events
 *   - persist last connected address for reconnect on reload
 */

import { STUDIONET } from './config.js';

/* ---------- provider discovery (EIP-6963) ---------- */

// Wallets announce themselves per EIP-6963. We collect them (deduped by rdns)
// so the user can pick which one to use instead of us guessing.
const announced = [];
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = event.detail;
    if (!detail?.provider) return;
    const rdns = detail.info?.rdns;
    const dup = announced.some((a) => (rdns ? a.info?.rdns === rdns : a.provider === detail.provider));
    if (!dup) announced.push(detail);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/* The wallet the user actually chose. All reads/writes use this exact provider
 * so a multi-wallet setup never sends a tx from the wrong account. */
let activeProvider = null;

// Returns the list of discovered wallets: [{ info: {name, icon, rdns}, provider }]
export function getDiscoveredWallets() {
  return announced.slice();
}

// Fallback provider when EIP-6963 found nothing (single legacy injected wallet).
function legacyProvider() {
  if (typeof window === 'undefined') return null;
  if (window.okxwallet) return window.okxwallet;
  if (window.ethereum?.providers?.length) {
    return window.ethereum.providers.find((p) => p.isMetaMask) || window.ethereum.providers[0];
  }
  return window.ethereum || null;
}

// The provider to use for the current session (chosen > legacy fallback).
export function getActiveProvider() {
  return activeProvider || legacyProvider();
}

export function hasMetaMask() {
  return announced.length > 0 || legacyProvider() !== null;
}

/* ---------- internal state + subscribers ---------- */

let state = {
  address: null,
  chainId: null,
  isStudionet: false,
};

const subs = new Set();

export function subscribe(cb) {
  subs.add(cb);
  cb(state);
  return () => subs.delete(cb);
}

function setState(patch) {
  state = { ...state, ...patch };
  state.isStudionet = toHexChainId(state.chainId) === STUDIONET.chainId.toLowerCase();
  if (state.address) localStorage.setItem('ucl27-last-address', state.address);
  else localStorage.removeItem('ucl27-last-address');
  subs.forEach((cb) => cb(state));
}

export function getState() { return state; }

/* ---------- connect / disconnect ---------- */

// Connect using a specific discovered wallet (from the chooser). Pass the
// EIP-6963 `detail` object, or nothing to use the legacy single-wallet path.
export async function connect(detail) {
  const provider = detail?.provider || getActiveProvider();
  if (!provider) {
    throw new Error('No wallet detected. Install MetaMask, OKX, or another wallet and refresh.');
  }
  activeProvider = provider;
  if (detail?.info?.rdns) localStorage.setItem('ucl27-wallet-rdns', detail.info.rdns);
  attachListeners(provider);

  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const chainId = await provider.request({ method: 'eth_chainId' });
  setState({ address: accounts[0]?.toLowerCase() ?? null, chainId });

  // Nudge onto Bradbury now, but don't fail the connection if the user
  // declines — the write path re-checks and blocks there (ensureStudionet).
  if (toHexChainId(chainId) !== TARGET_CHAIN) {
    await switchToStudionet().catch((e) => console.warn('network switch declined:', e.message));
  }
  return state;
}

export function disconnect() {
  activeProvider = null;
  localStorage.removeItem('ucl27-wallet-rdns');
  setState({ address: null, chainId: null });
}

/* ---------- Bradbury switching ---------- */

// Normalize any chainId shape (0x107d, 0x107D, 4221 decimal, '4221') to lower hex.
function toHexChainId(id) {
  if (id == null) return null;
  const s = String(id);
  if (s.startsWith('0x') || s.startsWith('0X')) return s.toLowerCase();
  const n = Number(s);
  return Number.isFinite(n) ? '0x' + n.toString(16) : s.toLowerCase();
}

const TARGET_CHAIN = STUDIONET.chainId.toLowerCase(); // Bradbury 0x107d (4221)

/* Switch the wallet to Bradbury and VERIFY it landed there.
 *
 * Robustness (see EIP-3326 + wallet quirks): we don't trust the switch promise
 * resolving — wallets can resolve without switching, or report "chain missing"
 * with different codes. We handle 4902 AND -32603 (Coinbase/others) plus the
 * "Unrecognized chain" message, add the chain if needed, then re-read
 * eth_chainId and throw if we're not actually on Bradbury. */
export async function switchToStudionet() {
  const provider = getActiveProvider();
  if (!provider) throw new Error('No wallet available.');

  const already = toHexChainId(await provider.request({ method: 'eth_chainId' }));
  if (already === TARGET_CHAIN) {
    setState({ chainId: already });
    return state;
  }

  const addParams = {
    chainId: STUDIONET.chainId,
    chainName: STUDIONET.chainName,
    rpcUrls: STUDIONET.rpcUrls,
    nativeCurrency: STUDIONET.nativeCurrency,
    blockExplorerUrls: STUDIONET.blockExplorerUrls,
  };

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: STUDIONET.chainId }],
    });
  } catch (err) {
    const missing =
      err?.code === 4902 ||
      err?.code === -32603 ||
      err?.data?.originalError?.code === 4902 ||
      /Unrecognized chain|not.*added|add.*network/i.test(err?.message ?? '');
    if (missing) {
      // Add, then explicitly switch again — adding does not reliably activate.
      await provider.request({ method: 'wallet_addEthereumChain', params: [addParams] });
      await provider
        .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: STUDIONET.chainId }] })
        .catch(() => {});
    } else {
      throw err;
    }
  }

  // Verify — do not trust resolution alone.
  const nowHex = toHexChainId(await provider.request({ method: 'eth_chainId' }));
  setState({ chainId: nowHex });
  if (nowHex !== TARGET_CHAIN) {
    throw new Error(
      `Wallet is still on chain ${parseInt(nowHex, 16)}. Please switch to ${STUDIONET.chainName} (chain ${STUDIONET.chainIdDecimal}) to continue.`
    );
  }
  return state;
}

/* Hard gate for writes: guarantees the wallet is on Bradbury or throws.
 * Called by contract.js before every signed transaction so a stale chain
 * flag can never let a tx reach genlayer-js on the wrong network. */
export async function ensureStudionet() {
  const provider = getActiveProvider();
  if (!provider) throw new Error('No wallet available.');
  const live = toHexChainId(await provider.request({ method: 'eth_chainId' }));
  setState({ chainId: live });
  if (live !== TARGET_CHAIN) {
    await switchToStudionet();
  }
  return getActiveProvider();
}

/* ---------- provider event listeners ---------- */

let listenersAttachedTo = null;
function attachListeners(provider) {
  if (!provider?.on || listenersAttachedTo === provider) return;
  listenersAttachedTo = provider;
  provider.on('accountsChanged', (accounts) => {
    setState({ address: accounts[0]?.toLowerCase() ?? null });
  });
  provider.on('chainChanged', (chainId) => {
    setState({ chainId });
  });
}

/* ---------- silent reconnect on page load ---------- */

export async function trySilentReconnect() {
  const stored = localStorage.getItem('ucl27-last-address');
  if (!stored) return;

  // Prefer the same wallet the user chose last time (by rdns).
  const rdns = localStorage.getItem('ucl27-wallet-rdns');
  const chosen = rdns ? announced.find((a) => a.info?.rdns === rdns) : null;
  const provider = chosen?.provider || getActiveProvider();
  if (!provider) return;

  try {
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (accounts?.[0]) {
      activeProvider = provider;
      attachListeners(provider);
      const chainId = await provider.request({ method: 'eth_chainId' });
      setState({ address: accounts[0].toLowerCase(), chainId });
    }
  } catch (e) {
    console.warn('silent reconnect failed:', e.message);
  }
}

/* ---------- helpers ---------- */

export function shortAddress(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

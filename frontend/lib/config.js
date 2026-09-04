/* lib/config.js — Bradbury testnet + UCL '27 Supabase config */

// UCL '27 Predict uses its OWN dedicated Supabase project (not shared with
// laliga27-predict). Project ref: qahjpnaahmfxqjsizxkh
export const SUPABASE_URL = 'https://qahjpnaahmfxqjsizxkh.supabase.co';

// Supabase publishable key (formerly the anon key) — safe in the browser
// because RLS restricts it to public reads. Writes go through the mirror
// endpoints below, which use the SERVICE key (never exposed here).
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_64SZAwqHWIHcAFrmvyyfEQ_s-jw9qKq';

// GenLayer Bradbury testnet — DO NOT CHANGE
export const STUDIONET = {
  chainId: '0x107d',
  chainIdDecimal: 4221,
  chainName: 'GenLayer Bradbury',
  rpcUrls: ['https://rpc-bradbury.genlayer.com'],
  blockExplorerUrls: ['https://explorer-bradbury.genlayer.com'],
  nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
};

export const MIN_STAKE_GEN = 2;

// Secure mirror API (Vercel cron project). Writes to Supabase are no longer
// done from the browser — they go through these endpoints, which verify the
// claim against the contract (or a wallet signature) before writing. This is
// what stops anyone forging leaderboard / prediction rows with the public key.
export const MIRROR_API_BASE = 'https://ucl27-predict-cron.vercel.app';

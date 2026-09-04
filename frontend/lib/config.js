/* lib/config.js — Bradbury testnet + UCL '27 Supabase config */

// UCL '27 Predict uses its OWN dedicated Supabase project (not shared with
// laliga27-predict). Fill these in for the new project after you create it.
export const SUPABASE_URL = 'https://YOUR_UCL_PROJECT.supabase.co';

// ⚠️ PASTE THE UCL '27 PROJECT'S *PUBLISHABLE* KEY HERE (starts with sb_publishable_).
// Supabase dashboard → your UCL project → Settings → API keys →
// "Publishable" (the renamed anon key). This is safe to ship in the browser;
// RLS restricts it to public reads. The secret key stays server-side only.
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_REPLACE_ME';

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

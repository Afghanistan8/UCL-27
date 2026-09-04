// deploy-ai.js
// Deploy the single AIPredictor contract to GenLayer Bradbury.
// Modeled on deploy.js — same imports, same client, same address extraction.
//
// Run: node deploy-ai.js
// Prints the deployed address and writes it to ai_predictor_address.txt

import { createClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';
import { readFileSync, writeFileSync } from 'fs';
import 'dotenv/config';

const { PRIVATE_KEY } = process.env;
if (!PRIVATE_KEY) {
  console.error('Missing PRIVATE_KEY. Add it to .env');
  process.exit(1);
}

const contractCode = readFileSync('./ai_predictor.py', 'utf-8');

const account = createAccount(PRIVATE_KEY);
console.log(`Deploying AIPredictor from: ${account.address}`);

const client = createClient({ chain: testnetBradbury, account });
await client.initializeConsensusSmartContract();
console.log('Consensus contract initialized');

// Same finicky receipt shape as deploy.js — reuse the exact helper
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

try {
  const txHash = await client.deployContract({
    code: contractCode,
    args: [],            // AIPredictor.__init__ takes no constructor arguments
    leaderOnly: false,
  });
  console.log(`tx: ${txHash}`);

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
    retries: 60,        // up to ~5 min
    interval: 5000,
  });

  const address = extractContractAddress(receipt);
  if (!address) {
    console.error(
      'receipt:',
      JSON.stringify(receipt, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2).slice(0, 2000)
    );
    throw new Error('No contract_address in receipt');
  }

  console.log(`\n✓ AIPredictor deployed at: ${address}`);
  writeFileSync('./ai_predictor_address.txt', address);
  console.log('Saved to ai_predictor_address.txt');
  console.log('Next: add it to .env as  AI_PREDICTOR_ADDRESS=' + address);
} catch (err) {
  console.error(`✗ FAILED: ${err.message}`);
  process.exit(1);
}

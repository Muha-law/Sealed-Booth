/**
 * Step 2: open the relayer's EVM authorisation window and deploy Booth.
 *
 *   node scripts/02-deploy.mjs
 *
 * The window is sized for the whole election that follows, so step 3 does not
 * have to stop and open another one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadEnv, NETWORK, requireEnv, formatQor } from './lib/env.mjs';
import { unifiedAccount } from './lib/chain.mjs';
import { ensureWindow, publicClient, walletClient, receipt, maxFeePerGas } from './lib/evm.mjs';
import { recordProof } from './lib/proof.mjs';

const env = loadEnv();
const relayer = await unifiedAccount(requireEnv(env, 'BOOTH_RELAYER_MNEMONIC'));
const artifact = JSON.parse(readFileSync('build/Booth.json', 'utf8'));

if (env.BOOTH_CONTRACT_ADDRESS) {
  const code = await publicClient().getCode({ address: env.BOOTH_CONTRACT_ADDRESS });
  if (code && code !== '0x') {
    console.log(`Booth already deployed at ${env.BOOTH_CONTRACT_ADDRESS} (${(code.length - 2) / 2} bytes).`);
    console.log('Delete BOOTH_CONTRACT_ADDRESS from .env to deploy a fresh one.');
    process.exit(0);
  }
}

console.log(`relayer ${relayer.cosmos}`);
console.log(`        ${relayer.evm}\n`);

// One deploy + createElection + registerVoters + 5 ballots + 1 refused ballot
// + 3 reveals, with room to spare.
console.log('--- EVM authorisation window ---');
const opened = await ensureWindow(relayer, { txs: 40, gasEach: 3_000_000 });
if (opened) {
  recordProof({
    proves:
      'relayer opened a bounded EVM authorisation window from the native lane ' +
      `(hybrid-signed; 40 txs, ${formatQor(opened.needed)} cap) — without this the EVM lane refuses every transaction`,
    txHash: opened.result.transactionHash,
    gasUsed: opened.result.gasUsed,
    lane: 'native',
  });
}

console.log('\n--- deploying Booth ---');
const client = publicClient();
const wallet = walletClient(relayer.privateKey);

// Opening the window advanced the nonce, so read it now, not before.
const nonce = await client.getTransactionCount({ address: relayer.evm });
const fee = await maxFeePerGas(client);
console.log(`  nonce ${nonce}, maxFeePerGas ${fee} wei`);
console.log(`  bytecode ${(artifact.bytecode.length - 2) / 2} bytes`);

const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [],
  nonce,
  maxFeePerGas: fee,
  maxPriorityFeePerGas: 0n,
  gas: 3_000_000n,
});
console.log(`  tx ${hash}`);

const r = await receipt(client, hash);
if (!r.contractAddress) throw new Error(`deployment produced no contract address: ${JSON.stringify(r)}`);

console.log(`  deployed at ${r.contractAddress}`);
console.log(`  gas used ${r.gasUsed}`);

const onChainCode = await client.getCode({ address: r.contractAddress });
console.log(`  on-chain runtime ${(onChainCode.length - 2) / 2} bytes`);

recordProof({
  proves: `Booth contract deployed on EVM chain ${NETWORK.evmChainId} at ${r.contractAddress} — only ciphertext is ever stored in it`,
  txHash: hash,
  gasUsed: r.gasUsed,
  lane: 'evm',
});

// Persist the address for the next step.
const current = readFileSync('.env', 'utf8');
writeFileSync(
  '.env',
  current.includes('BOOTH_CONTRACT_ADDRESS=')
    ? current.replace(/BOOTH_CONTRACT_ADDRESS=.*/g, `BOOTH_CONTRACT_ADDRESS=${r.contractAddress}`)
    : `${current.trimEnd()}\nBOOTH_CONTRACT_ADDRESS=${r.contractAddress}\n`,
  'utf8',
);
console.log('\nWrote BOOTH_CONTRACT_ADDRESS to .env');
console.log('Next: node scripts/03-run-election.mjs');

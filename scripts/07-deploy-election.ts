/**
 * Deploy Election.sol (the Foundry artifact) to qorechain-diana.
 *
 *   npx tsx scripts/07-deploy-election.ts
 *
 * Deployment goes through the relayer's EVM authorisation window, which is the
 * only way an EVM transaction is admitted on this chain: the sender needs a
 * registered ML-DSA-87 key AND a live window opened by a hybrid-signed message
 * on the native lane. See docs/VERIFIED-FACTS.md.
 *
 * The artifact comes from `forge build` (out/), not from the solc-js pipeline,
 * so what lands on chain is exactly what `forge test` exercised.
 *
 * Why not `forge create`: it takes the private key as a command-line argument,
 * which puts it in the process table. This reads the mnemonic from .env
 * instead, so no key is ever printed or passed in argv.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Abi, Hex } from 'viem';

// @ts-expect-error - .mjs helper
import { loadEnv, NETWORK, requireEnv, formatQor } from './lib/env.mjs';
// @ts-expect-error - .mjs helper
import { unifiedAccount } from './lib/chain.mjs';
// @ts-expect-error - .mjs helper, no type declarations
import { ensureWindow, publicClient, walletClient, receipt, maxFeePerGas, runtimeMatches } from './lib/evm.mjs';
// @ts-expect-error - .mjs helper
import { recordProof } from './lib/proof.mjs';

const env = loadEnv();
const relayer = await unifiedAccount(requireEnv(env, 'BOOTH_RELAYER_MNEMONIC'));

const artifact = JSON.parse(readFileSync('out/Election.sol/Election.json', 'utf8'));
const abi = artifact.abi as Abi;
const bytecode = artifact.bytecode.object as Hex;
const runtime = artifact.deployedBytecode.object as Hex;

const client = publicClient();

const redeploy = process.argv.includes('--redeploy');

if (env.ELECTION_CONTRACT_ADDRESS && !redeploy) {
  const code = await client.getCode({ address: env.ELECTION_CONTRACT_ADDRESS as Hex });
  if (code && code !== '0x') {
    console.log(`Election already deployed at ${env.ELECTION_CONTRACT_ADDRESS}.`);
    console.log('Pass --redeploy to deploy a new one. The current address is kept as');
    console.log('ELECTION_V1_CONTRACT_ADDRESS so earlier elections stay citable.');
    process.exit(0);
  }
}
if (redeploy && env.ELECTION_CONTRACT_ADDRESS) {
  console.log(`redeploying — previous contract ${env.ELECTION_CONTRACT_ADDRESS}`);
  console.log('  kept as ELECTION_V1_CONTRACT_ADDRESS (election 5 lives there)\n');
}

console.log(`relayer  ${relayer.cosmos}`);
console.log(`         ${relayer.evm}`);
console.log(`creation ${(bytecode.length - 2) / 2} bytes, runtime ${(runtime.length - 2) / 2} bytes`);
console.log(`solc     ${JSON.parse(JSON.stringify(artifact.metadata)).compiler.version}\n`);

console.log('--- EVM authorisation window ---');
const opened = await ensureWindow(relayer, { txs: 20, gasEach: 3_000_000 });
if (opened) {
  recordProof({
    proves:
      'relayer opened a fresh EVM authorisation window from the native lane (hybrid-signed) ' +
      `to deploy Election: 20 txs, ${formatQor(opened.needed)} cap`,
    txHash: opened.result.transactionHash,
    gasUsed: opened.result.gasUsed,
    lane: 'native',
  });
}

console.log('\n--- deploying Election ---');
const wallet = walletClient(relayer.privateKey);
const fee = await maxFeePerGas(client);

// Honest gas figure: the receipt will report half the limit (see
// docs/VERIFIED-FACTS.md), so estimate the real cost before sending.
const estimated = await client.estimateGas({ account: relayer.evm, data: bytecode });
console.log(`  eth_estimateGas: ${estimated} (the real execution cost)`);

// Opening a window advances the nonce, so read it after.
const nonce = await client.getTransactionCount({ address: relayer.evm });
const hash = await wallet.deployContract({
  abi,
  bytecode,
  args: [],
  nonce,
  gas: 3_000_000n,
  maxFeePerGas: fee,
  maxPriorityFeePerGas: 0n,
});
console.log(`  tx ${hash}`);

const r = await receipt(client, hash);
const address = r.contractAddress as Hex;
if (!address) throw new Error(`deployment produced no contract address: ${JSON.stringify(r)}`);

const onChain = await client.getCode({ address });
// `admin` is immutable, so Solidity patches it into the runtime at deployment.
// Compare with those windows masked out.
const check = runtimeMatches(artifact, onChain);

console.log(`  deployed at ${address}`);
console.log(`  receipt gasUsed ${r.gasUsed}`);
console.log(`  on-chain runtime ${(onChain!.length - 2) / 2} bytes`);
console.log(
  `  matches the forge artifact outside its ${check.maskedBytes} immutable bytes: ${check.match}`,
);

if (!check.match) {
  throw new Error(
    `deployed runtime differs from the forge artifact at ${check.diffs.length} non-immutable byte(s) — refusing to record it`,
  );
}

// Sanity: the admin really is the relayer, and the contract answers.
const admin = (await client.readContract({ address, abi, functionName: 'admin' })) as Hex;
const count = await client.readContract({ address, abi, functionName: 'electionCount' });
console.log(`  admin() = ${admin}  (relayer: ${admin.toLowerCase() === relayer.evm.toLowerCase()})`);
console.log(`  electionCount() = ${count}`);

recordProof({
  proves:
    `Election.sol deployed on EVM chain ${NETWORK.evmChainId} at ${address} through the relayer's ` +
    `EVM authorisation window. Runtime matches the forge artifact byte for byte (${(runtime.length - 2) / 2} B). ` +
    `Real deployment cost ${estimated} gas by eth_estimateGas`,
  txHash: hash,
  gasUsed: r.gasUsed,
  lane: 'evm',
});

let current = readFileSync('.env', 'utf8');
const previous = env.ELECTION_CONTRACT_ADDRESS;
// Keep the superseded address so PROOF.md rows for earlier elections stay citable.
if (redeploy && previous && !current.includes('ELECTION_V1_CONTRACT_ADDRESS=')) {
  current = `${current.trimEnd()}\nELECTION_V1_CONTRACT_ADDRESS=${previous}\n`;
}
current = current.includes('ELECTION_CONTRACT_ADDRESS=')
  ? current.replace(/^ELECTION_CONTRACT_ADDRESS=.*$/m, `ELECTION_CONTRACT_ADDRESS=${address}`)
  : `${current.trimEnd()}\nELECTION_CONTRACT_ADDRESS=${address}\n`;
writeFileSync('.env', current, 'utf8');
console.log('\nWrote ELECTION_CONTRACT_ADDRESS to .env');

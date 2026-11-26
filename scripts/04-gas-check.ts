/**
 * LEGACY (Booth v1). Operates on legacy/Booth.sol, whose `revealShare`
 * published plaintext shares on chain. Kept because it produced PROOF.md rows
 * that are cited; it is NOT the current path. Election.sol keeps shares off
 * chain — see docs/ARCHITECTURE.md.
 *
 * Every receipt in the run above reported gasUsed as exactly half the gas
 * limit. That pattern says the figure is not execution gas, so this measures
 * what is actually consumed before PROOF.md claims anything.
 *
 * Trustee 3 reveals its share too (one more than the threshold needs), which
 * gives a live call to estimate and send at a much tighter limit. If gasUsed
 * tracks the new limit rather than the work, the figure is a chain artifact.
 *
 *   npx tsx scripts/04-gas-check.ts
 */
import { readFileSync } from 'node:fs';
import { decodeEventLog, toHex, type Abi, type Hex } from 'viem';
import { open } from '@qorechain/qoreseal';

// @ts-expect-error - .mjs helper
import { loadEnv, NETWORK, requireEnv } from './lib/env.mjs';
// @ts-expect-error - .mjs helper
import { trusteeAccount, TRUSTEE_ENV_KEYS } from './lib/accounts.mjs';
// @ts-expect-error - .mjs helper
import { unifiedAccount } from './lib/chain.mjs';
// @ts-expect-error - .mjs helper
import { publicClient, walletClient, receipt, maxFeePerGas } from './lib/evm.mjs';
// @ts-expect-error - .mjs helper
import { recordProof } from './lib/proof.mjs';
import { SHARE_PURPOSE } from '../src/core/constants.js';

const env = loadEnv();
const CONTRACT = requireEnv(env, 'BOOTH_CONTRACT_ADDRESS') as Hex;
const abi = JSON.parse(readFileSync('build/Booth.json', 'utf8')).abi as Abi;

const client = publicClient();
const relayer = await unifiedAccount(requireEnv(env, 'BOOTH_RELAYER_MNEMONIC'));
const wallet = walletClient(relayer.privateKey);
const fee = await maxFeePerGas(client);

const electionId = (await client.readContract({
  address: CONTRACT,
  abi,
  functionName: 'electionCount',
})) as bigint;

// Find trustee 3's sealed share in the log. This node caps eth_getLogs at a
// 10,000-block range, so never ask for 'earliest'.
const head = await client.getBlockNumber();
const logs = await client.getLogs({
  address: CONTRACT,
  fromBlock: head > 9_000n ? head - 9_000n : 0n,
  toBlock: 'latest',
});
let sealedShare: Uint8Array | undefined;
for (const log of logs) {
  try {
    const parsed = decodeEventLog({ abi, data: log.data, topics: log.topics });
    if (parsed.eventName !== 'ShareSealed') continue;
    const a = parsed.args as unknown as { electionId: bigint; trusteeIndex: number; sealedShare: Hex };
    if (a.electionId === electionId && Number(a.trusteeIndex) === 2) {
      sealedShare = Uint8Array.from(Buffer.from(a.sealedShare.slice(2), 'hex'));
    }
  } catch {
    /* not ours */
  }
}
if (!sealedShare) throw new Error('no sealed share on chain for trustee 3');

const trustee3 = trusteeAccount(requireEnv(env, TRUSTEE_ENV_KEYS[2]));
const share = open({
  chainId: NETWORK.chainId,
  purpose: SHARE_PURPOSE,
  envelope: sealedShare,
  keys: trustee3.sealKeys,
});

const args = [electionId, 2, toHex(share)] as const;

const estimate = await client.estimateContractGas({
  address: CONTRACT,
  abi,
  functionName: 'revealShare',
  args,
  account: relayer.evm,
});
console.log(`eth_estimateGas for revealShare : ${estimate}`);

const LIMIT = 260_000n;
console.log(`sending with a tight gas limit  : ${LIMIT}`);

const hash = await wallet.writeContract({
  address: CONTRACT,
  abi,
  functionName: 'revealShare',
  args,
  gas: LIMIT,
  maxFeePerGas: fee,
  maxPriorityFeePerGas: 0n,
});
const r = await receipt(client, hash);

console.log(`receipt gasUsed                 : ${r.gasUsed}`);
console.log(`half of the limit               : ${LIMIT / 2n}`);
console.log(`effectiveGasPrice               : ${r.effectiveGasPrice} wei`);
console.log('');

const tracksLimit = r.gasUsed === LIMIT / 2n;
if (tracksLimit) {
  console.log('CONFIRMED: gasUsed is exactly half the gas LIMIT, not the work done.');
  console.log('So receipt gas on this chain reports what was charged, not what executed.');
  console.log(`Real execution cost for revealShare is about ${estimate} gas (eth_estimateGas).`);
} else {
  console.log('gasUsed does NOT track the limit here — the earlier halves were coincidence.');
  console.log(`estimate ${estimate} vs actual ${r.gasUsed}`);
}

recordProof({
  proves:
    `trustee 3 also revealed its share (3 of 3, one more than the ${2}-of-3 threshold needed). ` +
    `Sent with a ${LIMIT} gas limit: receipt reported ${r.gasUsed}` +
    (tracksLimit
      ? ', exactly half the limit, which shows receipt gas on this chain is what was charged, not what executed'
      : ''),
  txHash: hash,
  gasUsed: r.gasUsed,
  lane: 'evm',
});

console.log(`\nestimateGas values worth recording:`);
for (const fn of ['tallyUnlocked', 'votingOpen'] as const) {
  const v = await client.readContract({ address: CONTRACT, abi, functionName: fn, args: [electionId] });
  console.log(`  ${fn}(${electionId}) = ${v}`);
}

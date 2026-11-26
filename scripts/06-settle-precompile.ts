/**
 * Deploy PqcProbe for real and settle the precompile question.
 *
 * The earlier finding — that `0x…0a01` answers a direct `eth_call` but returns
 * nothing when called from contract code — was measured through an `eth_call`
 * state override. That left one doubt worth removing: the override address has
 * no real Cosmos account, and QoreChain's precompiles are stateful.
 *
 * This deploys the probe, so the caller is a genuine on-chain contract.
 *
 *   npx tsx scripts/06-settle-precompile.ts
 */
import { readFileSync } from 'node:fs';
import { encodeFunctionData, toHex, type Abi, type Hex } from 'viem';
import { mldsa } from '@qorechain/pqc';

// @ts-expect-error - .mjs helper
import { loadEnv, NETWORK, requireEnv } from './lib/env.mjs';
// @ts-expect-error - .mjs helper
import { unifiedAccount } from './lib/chain.mjs';
// @ts-expect-error - .mjs helper
import { publicClient, walletClient, receipt, maxFeePerGas } from './lib/evm.mjs';
// @ts-expect-error - .mjs helper
import { recordProof } from './lib/proof.mjs';

const env = loadEnv();
const artifact = JSON.parse(readFileSync('build/PqcProbe.json', 'utf8'));
const abi = artifact.abi as Abi;

const client = publicClient();
const relayer = await unifiedAccount(requireEnv(env, 'BOOTH_RELAYER_MNEMONIC'));
const wallet = walletClient(relayer.privateKey);
const fee = await maxFeePerGas(client);

console.log('deploying PqcProbe…');
const hash = await wallet.deployContract({
  abi,
  bytecode: artifact.bytecode as Hex,
  args: [],
  gas: 800_000n,
  maxFeePerGas: fee,
  maxPriorityFeePerGas: 0n,
});
const r = await receipt(client, hash);
const probe = r.contractAddress as Hex;
console.log(`  deployed at ${probe}\n`);

// A real ML-DSA-87 signature the precompile should accept.
const { publicKey, secretKey } = mldsa.keygen();
const message = new TextEncoder().encode('booth-settles-the-precompile-question');
const signature = mldsa.sign(secretKey, message);
console.log(`local mldsa.verify: ${mldsa.verify(publicKey, message, signature)}`);

const pqcPayload = encodeFunctionData({
  abi: [
    {
      type: 'function',
      name: 'pqcVerify',
      stateMutability: 'view',
      inputs: [
        { name: 'pubkey', type: 'bytes' },
        { name: 'signature', type: 'bytes' },
        { name: 'message', type: 'bytes' },
      ],
      outputs: [{ name: 'valid', type: 'bool' }],
    },
  ],
  functionName: 'pqcVerify',
  args: [toHex(publicKey), toHex(signature), toHex(message)],
});

const PQC = '0x0000000000000000000000000000000000000a01' as Hex;
const SHA = '0x0000000000000000000000000000000000000002' as Hex;

async function probeVia(fn: 'probeStatic' | 'probeCall', target: Hex, payload: Hex, label: string) {
  const [ok, len, data] = (await client.readContract({
    address: probe,
    abi,
    functionName: fn,
    args: [target, payload],
    account: relayer.evm,
  })) as [boolean, bigint, Hex];
  console.log(`${label.padEnd(34)} ${fn.padEnd(12)} ok=${ok} bytes=${len} ${data.slice(0, 68)}`);
  return { ok, len, data };
}

console.log('\n--- from a REAL deployed contract ---');
const staticPqc = await probeVia('probeStatic', PQC, pqcPayload, 'pqcVerify 0x..0a01');
const callPqc = await probeVia('probeCall', PQC, pqcPayload, 'pqcVerify 0x..0a01');
const staticSha = await probeVia('probeStatic', SHA, '0xdeadbeef', 'sha256 0x..02 (control)');

console.log('\n--- direct eth_call to the same precompile (no contract in between) ---');
const direct = await client.call({ to: PQC, data: pqcPayload });
const directBytes = direct.data ? (direct.data.length - 2) / 2 : 0;
console.log(`direct eth_call returned ${directBytes} bytes: ${direct.data}`);

const unreachable = Number(staticPqc.len) === 0 && Number(callPqc.len) === 0;
const controlWorks = Number(staticSha.len) === 32;
const directWorks = directBytes === 32;

console.log('\n================ VERDICT ================');
if (unreachable && controlWorks && directWorks) {
  console.log('CONFIRMED with a deployed contract:');
  console.log('  pqcVerify answers a direct eth_call (32 bytes) …');
  console.log('  … but returns 0 bytes to a deployed contract, via CALL and STATICCALL.');
  console.log('  sha256 returns 32 bytes to the same contract, so the contract is fine.');
  console.log('Booth therefore cannot verify ML-DSA-87 on chain. The design is right.');
} else {
  console.log('DIFFERENT RESULT from the state-override measurement:');
  console.log(`  pqc staticcall bytes = ${staticPqc.len}`);
  console.log(`  pqc call bytes       = ${callPqc.len}`);
  console.log(`  sha256 control bytes = ${staticSha.len}`);
  console.log(`  direct eth_call bytes= ${directBytes}`);
  console.log('docs/VERIFIED-FACTS.md and the architecture need revisiting.');
}
console.log('=========================================');

recordProof({
  proves:
    `PqcProbe deployed at ${probe} to settle the precompile question from a REAL contract: ` +
    (unreachable
      ? `pqcVerify 0x..0a01 returns 0 bytes to a deployed contract (CALL and STATICCALL) while sha256 returns 32 to the same contract and a direct eth_call returns 32 — so ML-DSA-87 cannot be verified on chain, which is why Booth verifies it at tally`
      : `result differed from the state-override measurement (static ${staticPqc.len} B, call ${callPqc.len} B) — see the script output`),
  txHash: hash,
  gasUsed: r.gasUsed,
  lane: 'evm',
});

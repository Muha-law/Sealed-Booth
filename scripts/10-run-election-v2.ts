/**
 * A full live election on the Election.sol that has releaseShare, with the
 * trustees running as three SEPARATE processes.
 *
 *   npx tsx scripts/10-run-election-v2.ts
 *
 *   create -> 5 ballots -> refused double vote -> refused early tally
 *          -> close -> spawn 3 trustee processes -> result
 *
 * Each trustee is spawned with BOOTH_ONLY_TRUSTEE=<index>, which makes
 * loadEnv strip every other secret. So no process in this run holds more than
 * one trustee key — the gap the earlier single-process run left open.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  encodeFunctionData,
  keccak256,
  toHex,
  type Abi,
  type Hex,
} from 'viem';
import { fetchKemKey } from '@qorechain/qoreseal/network';
import { seal, verifyRecipientCard } from '@qorechain/qoreseal';
import { fetchPqcStatus, msg } from '@qorechain/sdk';
import { buildRegisterPqKeyMessage, fromBase64 } from '@qorechain/qoresign';

// @ts-expect-error - .mjs helper
import { loadEnv, NETWORK, requireEnv, formatQor } from './lib/env.mjs';
// @ts-expect-error - .mjs helper
import { trusteeAccount, TRUSTEE_ENV_KEYS, VOTER_ENV_KEYS } from './lib/accounts.mjs';
// @ts-expect-error - .mjs helper
import { sendNative, unifiedAccount, anyToEncodeObject, classicalPublicKeyBytes } from './lib/chain.mjs';
// @ts-expect-error - .mjs helper, no type declarations
import { ensureWindow, publicClient, walletClient, maxFeePerGas } from './lib/evm.mjs';
// @ts-expect-error - .mjs helper
import { recordProof } from './lib/proof.mjs';
import { setUpElection } from '../src/core/election.js';
import { ballotAad, ballotPlaintext } from '../src/core/ballot.js';
import { BALLOT_PURPOSE } from '../src/core/constants.js';

const env = loadEnv();
const CONTRACT = requireEnv(env, 'ELECTION_CONTRACT_ADDRESS') as Hex;
const abi = JSON.parse(readFileSync('out/Election.sol/Election.json', 'utf8')).abi as Abi;

const THRESHOLD = 2;
const QUESTION = 'Which animal guards the ballot box?';
const OPTIONS = ['hedgehog', 'badger', 'otter'];
const CHOICES = ['hedgehog', 'badger', 'hedgehog', 'otter', 'hedgehog'];
const VOTING_SECONDS = 240;
const VOTER_FUNDING_UQOR = 1_200_000n;

const client = publicClient();
const relayer = await unifiedAccount(requireEnv(env, 'BOOTH_RELAYER_MNEMONIC'));
const fee = await maxFeePerGas(client);

function calldataFloorGas(data: Hex): bigint {
  const body = data.slice(2);
  let tokens = 0n;
  for (let i = 0; i < body.length; i += 2) tokens += body.slice(i, i + 2) === '00' ? 1n : 4n;
  return 21_000n + 10n * tokens;
}

async function sendFrom(privateKey: Hex, account: Hex, fn: string, args: readonly unknown[]) {
  const estimate = await client.estimateContractGas({
    address: CONTRACT,
    abi,
    functionName: fn,
    args,
    account,
  });
  const floor = calldataFloorGas(encodeFunctionData({ abi, functionName: fn, args }));
  const withMargin = (estimate * 112n) / 100n;
  const limit = withMargin > floor ? withMargin : (floor * 102n) / 100n;

  const hash = await walletClient(privateKey).writeContract({
    address: CONTRACT,
    abi,
    functionName: fn,
    args,
    gas: limit,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: 0n,
  });
  const r = await client.waitForTransactionReceipt({ hash, timeout: 240_000 });
  if (r.status !== 'success') throw new Error(`${fn} reverted: ${hash}`);
  return { hash: hash as Hex, estimate, floor, limit, gasUsed: r.gasUsed as bigint, block: r.blockNumber };
}

async function expectRevert(
  privateKey: Hex,
  account: Hex,
  fn: string,
  args: readonly unknown[],
  expected: string,
  executionGas: bigint,
) {
  const floor = calldataFloorGas(encodeFunctionData({ abi, functionName: fn, args }));
  const limit = executionGas > floor ? executionGas : (floor * 102n) / 100n;

  let reason = '';
  try {
    await client.simulateContract({ address: CONTRACT, abi, functionName: fn, args, account });
    throw new Error(`${fn} was accepted but must revert with ${expected}`);
  } catch (err) {
    const m = new RegExp(expected).exec(err instanceof Error ? err.message : String(err));
    if (!m) throw err;
    reason = m[0];
  }

  const hash = await walletClient(privateKey).writeContract({
    address: CONTRACT,
    abi,
    functionName: fn,
    args,
    gas: limit,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: 0n,
  });
  const r = await client.waitForTransactionReceipt({ hash, timeout: 240_000 });
  if (r.status === 'success') throw new Error(`${fn} succeeded on chain but must fail`);
  return { hash: hash as Hex, reason, gasUsed: r.gasUsed as bigint };
}

const read = (fn: string, args: readonly unknown[] = []) =>
  client.readContract({ address: CONTRACT, abi, functionName: fn, args });

async function balanceUqor(bech32: string) {
  const res = await fetch(`${NETWORK.rest}/cosmos/bank/v1beta1/balances/${bech32}`);
  const j = await res.json();
  return BigInt((j.balances ?? []).find((b: { denom: string }) => b.denom === 'uqor')?.amount ?? 0);
}

console.log(`Election ${CONTRACT}`);
console.log(`admin    ${relayer.evm}\n`);

console.log('--- admin window ---');
await ensureWindow(relayer, { txs: 4, gasEach: 900_000, blocks: 17_280 });

console.log('\n--- voters ---');
const voters = [];
for (const [i, key] of VOTER_ENV_KEYS.entries()) {
  const v = await unifiedAccount(requireEnv(env, key));
  const have = await balanceUqor(v.cosmos);
  if (have < VOTER_FUNDING_UQOR) {
    const amount = (VOTER_FUNDING_UQOR - have).toString();
    await sendNative(
      relayer,
      [msg.bank.send({ fromAddress: relayer.cosmos, toAddress: v.cosmos, amount: [{ denom: 'uqor', amount }] })],
      { gas: 220_000, memo: 'booth: fund voter' },
    );
    console.log(`  voter ${i + 1}: funded ${formatQor(amount)}`);
  }
  const pqc = (await fetchPqcStatus({ rest: NETWORK.rest, address: v.cosmos })) as {
    registered?: boolean;
    found?: boolean;
  };
  if (!(pqc.registered ?? pqc.found)) {
    await sendNative(
      v,
      [
        anyToEncodeObject(
          buildRegisterPqKeyMessage({
            chainId: NETWORK.chainId,
            account: v.cosmos,
            pqKey: v.pqc,
            classicalPublicKey: classicalPublicKeyBytes(v),
          }),
        ),
      ],
      { bootstrap: true, gas: 320_000, memo: 'booth: voter ML-DSA-87 identity' },
    );
    console.log(`  voter ${i + 1}: ML-DSA-87 key registered`);
  }
  await ensureWindow(v, { txs: i === 0 ? 4 : 2, gasEach: 400_000, blocks: 17_280 });
  voters.push({ label: `voter ${i + 1}`, account: v, choice: CHOICES[i]! });
}

console.log('\n--- trustee recipient keys ---');
const cards = JSON.parse(readFileSync('build/trustee-cards.json', 'utf8')) as {
  address: string;
  card: Parameters<typeof verifyRecipientCard>[0]['card'];
}[];
const trustees = [];
for (const [i, key] of TRUSTEE_ENV_KEYS.entries()) {
  const local = trusteeAccount(requireEnv(env, key));
  const uni = await unifiedAccount(requireEnv(env, key));
  const kem = await fetchKemKey({ rest: NETWORK.rest, address: local.bech32 });
  if (!kem.registered) throw new Error(`trustee ${i + 1} has no registered ML-KEM key`);
  const status = (await fetchPqcStatus({ rest: NETWORK.rest, address: local.bech32 })) as {
    pubkey: string;
  };
  const recipient = verifyRecipientCard({
    card: cards.find((c) => c.address === local.bech32)!.card,
    chainId: NETWORK.chainId,
    pqPublicKey: fromBase64(status.pubkey),
    mlkemPublicKey: kem.publicKey!,
  });
  trustees.push({ account: uni, recipient, keyRef: keccak256(kem.publicKey!) });
  console.log(`  trustee ${i + 1}: card verified, keyRef ${keccak256(kem.publicKey!).slice(0, 18)}…`);
}

console.log('\n--- createElection ---');
const setup = await setUpElection({
  chainId: NETWORK.chainId,
  trustees: trustees.map((t) => t.recipient),
  threshold: THRESHOLD,
});
const head = await client.getBlock();
const openAt = BigInt(head.timestamp);
const closeAt = openAt + BigInt(VOTING_SECONDS);

const created = await sendFrom(relayer.privateKey, relayer.evm, 'createElection', [
  QUESTION,
  OPTIONS,
  openAt,
  closeAt,
  THRESHOLD,
  voters.map((v) => v.account.evm as Hex),
  trustees.map((t) => t.account.evm as Hex),
  trustees.map((t) => t.keyRef),
  toHex(setup.electionPublicKey),
  setup.shareCommitments,
  setup.sealedShares.map((s: Uint8Array) => toHex(s)),
]);
const electionId = (await read('electionCount')) as bigint;
console.log(`  election ${electionId}, closes in ${VOTING_SECONDS}s, charged ${created.gasUsed}`);
recordProof({
  proves:
    `Election.sol (with releaseShare) election ${electionId} created: 3 options, 5-address allowlist, ` +
    `3 trustees referenced by the keccak256 of their REGISTERED ML-KEM-1024 keys, threshold ${THRESHOLD}`,
  txHash: created.hash,
  gasUsed: created.gasUsed,
  lane: 'evm',
});

const ref = { evmChainId: NETWORK.evmChainId, contract: CONTRACT, electionId };
const aad = ballotAad(ref);
const recipient = {
  mlkemPublicKey: setup.electionPublicKey.slice(1, 1569),
  x25519PublicKey: setup.electionPublicKey.slice(1569),
};

console.log('\n--- 5 ballots ---');
const receipts: { label: string; voter: Hex; ballotId: bigint; hash: Hex }[] = [];
for (const v of voters) {
  const envelope = seal({
    chainId: NETWORK.chainId,
    purpose: BALLOT_PURPOSE,
    mode: 'hybrid',
    recipients: [recipient],
    plaintext: ballotPlaintext(v.choice),
    aad,
  });
  const sent = await sendFrom(v.account.privateKey, v.account.evm, 'castBallot', [
    electionId,
    toHex(envelope),
  ]);
  const e = (await read('getElection', [electionId])) as { ballotCount: number };
  receipts.push({
    label: v.label,
    voter: v.account.evm,
    ballotId: BigInt(e.ballotCount),
    hash: keccak256(envelope),
  });
  console.log(`  ${v.label}: ballot ${e.ballotCount}, ${envelope.length} B, charged ${sent.gasUsed}`);
}

console.log('\n--- double vote (expect AlreadyVoted) ---');
const dupEnvelope = seal({
  chainId: NETWORK.chainId,
  purpose: BALLOT_PURPOSE,
  mode: 'hybrid',
  recipients: [recipient],
  plaintext: ballotPlaintext('otter'),
  aad,
});
const dup = await expectRevert(
  voters[0]!.account.privateKey,
  voters[0]!.account.evm,
  'castBallot',
  [electionId, toHex(dupEnvelope)],
  'AlreadyVoted',
  60_000n,
);
console.log(`  refused with ${dup.reason}, charged ${dup.gasUsed}`);
recordProof({
  proves: `a second ballot from voter 1 was REFUSED on chain with ${dup.reason}`,
  txHash: dup.hash,
  gasUsed: dup.gasUsed,
  lane: 'evm',
});

console.log('\n--- early tally (expect StillOpen) ---');
const early = await expectRevert(
  trustees[0]!.account.privateKey,
  trustees[0]!.account.evm,
  'submitTally',
  [electionId, [0n, 0n, 0n], keccak256(toHex('premature'))],
  'StillOpen',
  60_000n,
);
console.log(`  refused with ${early.reason}, charged ${early.gasUsed}`);
recordProof({
  proves: `a tally submitted before the close was REFUSED on chain with ${early.reason}`,
  txHash: early.hash,
  gasUsed: early.gasUsed,
  lane: 'evm',
});

console.log('\n--- waiting for the close ---');
for (;;) {
  const b = await client.getBlock();
  const left = Number(closeAt) - Number(b.timestamp);
  if (left <= 0) break;
  console.log(`  ${left}s`);
  await new Promise((r) => setTimeout(r, Math.min(left, 25) * 1000));
}
console.log(`  isOpen = ${await read('isOpen', [electionId])}`);

// ---- the point of this script: three separate trustee processes ----
console.log('\n--- spawning 3 trustee processes (each with ONE key) ---');
const runTrustee = (index: number) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      'npx',
      ['tsx', 'scripts/09-trustee.ts', String(index), String(electionId)],
      {
        stdio: 'inherit',
        shell: true, // resolves npx.cmd on Windows
        // loadEnv strips every other mnemonic when this is set, so this child
        // genuinely cannot read another trustee's key.
        env: { ...process.env, BOOTH_ONLY_TRUSTEE: String(index) },
      },
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`trustee ${index + 1} exited with ${code}`)),
    );
    child.on('error', reject);
  });

await Promise.all([0, 1, 2].map(runTrustee));

console.log('\n--- final result ---');
const [totals, counted, agreements] = (await read('finalResult', [electionId])) as [
  readonly bigint[],
  Hex,
  number,
];
const [released, , enough] = (await read('releaseStatus', [electionId])) as [number, number, boolean];

console.log('\n================ RESULT ================');
OPTIONS.forEach((o, i) => {
  console.log(`  ${o.padEnd(10)} ${String(totals[i]).padStart(2)}  ${'#'.repeat(Number(totals[i]))}`);
});
console.log(`  agreements ${agreements}, shares released ${released} (enough: ${enough})`);
console.log(`  countedBallotIdsHash ${counted}`);
console.log('========================================');

const expected = CHOICES.reduce<Record<string, number>>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), {});
OPTIONS.forEach((o, i) => {
  if (Number(totals[i]) !== (expected[o] ?? 0)) throw new Error(`result disagrees for ${o}`);
});
console.log('\nResult matches the five ballots cast.');

console.log('\n--- voter receipts ---');
for (const r of receipts) {
  const stored = (await read('ballotHash', [electionId, r.ballotId])) as Hex;
  const ok = stored === r.hash && (await read('hasVoted', [electionId, r.voter])) === true;
  console.log(`  ${r.label}: ballot ${r.ballotId} included = ${ok}`);
  if (!ok) throw new Error(`${r.label} cannot verify inclusion`);
}

console.log(`\nElection ${electionId} complete, tallied by three separate trustee processes.`);

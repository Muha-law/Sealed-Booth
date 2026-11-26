/**
 * Step 3: one whole election on qorechain-diana.
 *
 *   create -> register voters -> 5 ballots -> refused double vote
 *          -> close -> 2 of 3 trustees reveal -> tally
 *
 *   npx tsx scripts/03-run-election.ts
 *
 * Everything the tally needs is read back FROM THE CHAIN — the trustees' KEM
 * keys, the sealed shares, the ballots, the revealed shares. Nothing is carried
 * over in memory from the setup, because the point is that any observer with
 * the same public data computes the same result.
 */
import { readFileSync } from 'node:fs';
import { decodeEventLog, keccak256, toHex, type Abi, type Hex } from 'viem';
import { fetchKemKey } from '@qorechain/qoreseal/network';
import { open, verifyRecipientCard, type RecipientCard } from '@qorechain/qoreseal';
import { fetchPqcStatus } from '@qorechain/sdk';
import { fromBase64 } from '@qorechain/qoresign';

// @ts-expect-error - .mjs helpers, no type declarations
import { loadEnv, NETWORK, requireEnv } from './lib/env.mjs';
// @ts-expect-error - .mjs helpers
import { trusteeAccount, TRUSTEE_ENV_KEYS, VOTER_ENV_KEYS } from './lib/accounts.mjs';
// @ts-expect-error - .mjs helpers
import { unifiedAccount } from './lib/chain.mjs';
// @ts-expect-error - .mjs helpers
import { publicClient, walletClient, receipt, maxFeePerGas } from './lib/evm.mjs';
// @ts-expect-error - .mjs helpers
import { recordProof } from './lib/proof.mjs';

import { setUpElection } from '../src/core/election.js';
import { voterFromMnemonic, type VoterIdentity } from '../src/core/identity.js';
import { castBallot, type ElectionRef } from '../src/core/ballot.js';
import { recoverElectionKeys, tallyBallots, type OnChainBallot } from '../src/core/tally.js';
import { SHARE_PURPOSE } from '../src/core/constants.js';

const env = loadEnv();
const CONTRACT = requireEnv(env, 'BOOTH_CONTRACT_ADDRESS') as Hex;
const abi = (JSON.parse(readFileSync('build/Booth.json', 'utf8')).abi) as Abi;

const THRESHOLD = 2;
const TITLE = 'Booth demo: which animal guards the ballot box?';
const OPTIONS = ['hedgehog', 'badger', 'otter'];
const CHOICES = ['hedgehog', 'badger', 'hedgehog', 'otter', 'hedgehog'];
const VOTING_SECONDS = 150;

const client = publicClient();
const relayer = await unifiedAccount(requireEnv(env, 'BOOTH_RELAYER_MNEMONIC'));
const wallet = walletClient(relayer.privateKey);
const fee = await maxFeePerGas(client);

/** Send one EVM transaction from the relayer, with explicit gas (no estimation). */
async function send(functionName: string, args: unknown[], gas: bigint) {
  const hash = await wallet.writeContract({
    address: CONTRACT,
    abi,
    functionName,
    args,
    gas,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: 0n,
  });
  const r = await receipt(client, hash);
  return { hash: hash as Hex, gasUsed: r.gasUsed as bigint, blockNumber: r.blockNumber as bigint };
}

const read = (functionName: string, args: unknown[] = []) =>
  client.readContract({ address: CONTRACT, abi, functionName, args });

console.log(`Booth   ${CONTRACT}`);
console.log(`relayer ${relayer.evm}\n`);

// ---------------------------------------------------------------- trustees

console.log('--- trustee recipient keys, read from the chain ---');
const cardsFile = JSON.parse(readFileSync('build/trustee-cards.json', 'utf8')) as {
  index: number;
  address: string;
  card: RecipientCard;
}[];

const trustees = [];
for (const [i, key] of TRUSTEE_ENV_KEYS.entries()) {
  const local = trusteeAccount(requireEnv(env, key));
  const kem = await fetchKemKey({ rest: NETWORK.rest, address: local.bech32 });
  if (!kem.registered) throw new Error(`trustee ${i + 1} has no ML-KEM key on chain`);

  const status = await fetchPqcStatus({ rest: NETWORK.rest, address: local.bech32 });
  const pqPublicKey = fromBase64((status as { pubkey: string }).pubkey);

  // Verify the card against the on-chain ML-DSA-87 key AND the on-chain ML-KEM
  // key. This is the ML-DSA key binding: the recipient key is only trusted
  // because the account's post-quantum identity signed for it.
  const card = cardsFile.find((c) => c.address === local.bech32)!.card;
  const recipient = verifyRecipientCard({
    card,
    chainId: NETWORK.chainId,
    pqPublicKey,
    mlkemPublicKey: kem.publicKey!,
  });

  console.log(`  trustee ${i + 1}: card verified against on-chain keys, ML-KEM from registry`);
  trustees.push({ label: `trustee ${i + 1}`, index: i, local, recipient });
}

// ---------------------------------------------------------------- create

console.log('\n--- create election ---');
const setup = await setUpElection({
  chainId: NETWORK.chainId,
  trustees: trustees.map((t) => t.recipient),
  threshold: THRESHOLD,
});
console.log(`  election key blob ${setup.electionPublicKey.length} bytes (ML-KEM-1024 + X25519)`);
console.log(`  ${THRESHOLD} of ${setup.trusteeCount} trustees needed to open the ballots`);
console.log('  the creator holds no election key: it was split and discarded');

const latest = await client.getBlock();
const closesAt = BigInt(latest.timestamp) + BigInt(VOTING_SECONDS);

const created = await send(
  'createElection',
  [
    TITLE,
    OPTIONS,
    closesAt,
    THRESHOLD,
    toHex(setup.electionPublicKey),
    setup.shareCommitments,
    setup.sealedShares.map((s: Uint8Array) => toHex(s)),
  ],
  2_500_000n,
);
const electionId = (await read('electionCount')) as bigint;
console.log(`  election ${electionId}, closes at ${closesAt} (${VOTING_SECONDS}s)`);
recordProof({
  proves: `election ${electionId} created: ML-KEM-1024 election key published on chain, seed Shamir-split ${THRESHOLD}-of-${setup.trusteeCount}, one sealed share per trustee`,
  txHash: created.hash,
  gasUsed: created.gasUsed,
  lane: 'evm',
});

const ref: ElectionRef = { evmChainId: NETWORK.evmChainId, contract: CONTRACT, electionId };

// ---------------------------------------------------------------- roll

console.log('\n--- register voters ---');
const voters: VoterIdentity[] = (VOTER_ENV_KEYS as string[]).map((k) =>
  voterFromMnemonic(requireEnv(env, k)),
);
const registered = await send(
  'registerVoters',
  [electionId, voters.map((v) => v.evmAddress), voters.map((v) => keccak256(v.mldsaPublicKey))],
  1_500_000n,
);
console.log(`  ${voters.length} voters on the roll, each bound to its ML-DSA-87 key hash`);
recordProof({
  proves: `${voters.length} voters registered, each bound to the keccak256 of their ML-DSA-87 public key`,
  txHash: registered.hash,
  gasUsed: registered.gasUsed,
  lane: 'evm',
});

// ---------------------------------------------------------------- vote

console.log('\n--- cast 5 ballots ---');
const receipts: { voter: Hex; envelopeHash: Hex }[] = [];
let ballotGasTotal = 0n;

for (const [i, voter] of voters.entries()) {
  const args = {
    ...ref,
    chainId: NETWORK.chainId,
    electionPublicKey: setup.electionPublicKey,
    choice: CHOICES[i]!,
    voter,
  };
  const sealed = await castBallot(args);

  const sent = await send(
    'castBallot',
    [
      electionId,
      toHex(sealed.envelope),
      toHex(sealed.mldsaPublicKey),
      toHex(sealed.mldsaSignature),
      sealed.secpSignature,
    ],
    2_500_000n,
  );
  ballotGasTotal += sent.gasUsed;
  receipts.push({ voter: voter.evmAddress, envelopeHash: sealed.envelopeHash });
  console.log(
    `  voter ${i + 1}: sealed ${sealed.envelope.length} B, ` +
      `ML-DSA-87 sig ${sealed.mldsaSignature.length} B, gas ${sent.gasUsed}`,
  );

  if (i === 0) {
    recordProof({
      proves: `voter 1 cast an ML-KEM-1024 sealed ballot via the relayer; the contract admitted it on the voter's own secp256k1 signature, not the relayer's`,
      txHash: sent.hash,
      gasUsed: sent.gasUsed,
      lane: 'evm',
    });
  }
}
console.log(`  5 ballots, ${ballotGasTotal} gas total`);

// ---------------------------------------------------------------- double vote

console.log('\n--- attempt a double vote (must be refused) ---');
const repeatArgs = {
  ...ref,
  chainId: NETWORK.chainId,
  electionPublicKey: setup.electionPublicKey,
  choice: 'otter', // a different choice, same voter
  voter: voters[0]!,
};
const repeat = await castBallot(repeatArgs);
const repeatCall = [
  electionId,
  toHex(repeat.envelope),
  toHex(repeat.mldsaPublicKey),
  toHex(repeat.mldsaSignature),
  repeat.secpSignature,
] as const;

let refusedWith = '(not refused)';
try {
  await client.simulateContract({
    address: CONTRACT,
    abi,
    functionName: 'castBallot',
    args: repeatCall,
    account: relayer.evm,
  });
  throw new Error('the contract ACCEPTED a second ballot from the same voter — this is a bug');
} catch (err) {
  const text = err instanceof Error ? err.message : String(err);
  const match = /AlreadyVoted|RollMismatch|VotingClosed/.exec(text);
  if (!match) throw err;
  refusedWith = match[0];
  console.log(`  simulation reverted with ${refusedWith}`);
}

// Put it on chain too, so the refusal is a matter of public record.
const repeatHash = await wallet.writeContract({
  address: CONTRACT,
  abi,
  functionName: 'castBallot',
  args: repeatCall,
  gas: 2_500_000n,
  maxFeePerGas: fee,
  maxPriorityFeePerGas: 0n,
});
const repeatReceipt = await client.waitForTransactionReceipt({ hash: repeatHash, timeout: 180_000 });
console.log(`  on chain: status ${repeatReceipt.status}, gas ${repeatReceipt.gasUsed}`);
if (repeatReceipt.status === 'success') {
  throw new Error('the double vote succeeded on chain — this is a bug');
}
const ballotCountAfter = (await read('getElection', [electionId])) as { ballotCount: number };
console.log(`  ballotCount still ${ballotCountAfter.ballotCount}`);
recordProof({
  proves: `a second ballot from voter 1 was REFUSED on chain with ${refusedWith} — one registered voter, one vote, enforced by the contract`,
  txHash: repeatHash,
  gasUsed: repeatReceipt.gasUsed,
  lane: 'evm',
});

// ---------------------------------------------------------------- close

console.log('\n--- wait for voting to close ---');
for (;;) {
  const block = await client.getBlock();
  const left = Number(closesAt) - Number(block.timestamp);
  if (left <= 0) break;
  console.log(`  ${left}s to go (block ${block.number})`);
  await new Promise((r) => setTimeout(r, Math.min(left, 20) * 1000));
}
console.log(`  voting closed. votingOpen() = ${await read('votingOpen', [electionId])}`);

// ---------------------------------------------------------------- reveal

console.log('\n--- trustees reveal their shares (read sealed shares from chain) ---');
const sealedLogs = await client.getLogs({
  address: CONTRACT,
  fromBlock: created.blockNumber,
  toBlock: 'latest',
});

const sealedByIndex = new Map<number, Uint8Array>();
for (const log of sealedLogs) {
  try {
    const parsed = decodeEventLog({ abi, data: log.data, topics: log.topics });
    if (parsed.eventName !== 'ShareSealed') continue;
    const a = parsed.args as unknown as { electionId: bigint; trusteeIndex: number; sealedShare: Hex };
    if (a.electionId !== electionId) continue;
    sealedByIndex.set(Number(a.trusteeIndex), Uint8Array.from(Buffer.from(a.sealedShare.slice(2), 'hex')));
  } catch {
    // not one of ours
  }
}
console.log(`  found ${sealedByIndex.size} sealed shares in the event log`);

for (const t of trustees.slice(0, THRESHOLD)) {
  const envelope = sealedByIndex.get(t.index);
  if (!envelope) throw new Error(`no sealed share on chain for ${t.label}`);

  // Only this trustee's ML-KEM decapsulation key can open this.
  const share = open({
    chainId: NETWORK.chainId,
    purpose: SHARE_PURPOSE,
    envelope,
    keys: t.local.sealKeys,
  });

  const sent = await send('revealShare', [electionId, t.index, toHex(share)], 1_000_000n);
  console.log(`  ${t.label}: opened its share and revealed it (gas ${sent.gasUsed})`);
  recordProof({
    proves: `${t.label} opened its QoreSeal-sealed share with its ML-KEM-1024 key and revealed it; the contract checked it against the commitment made at creation`,
    txHash: sent.hash,
    gasUsed: sent.gasUsed,
    lane: 'evm',
  });
}

console.log(`  tallyUnlocked() = ${await read('tallyUnlocked', [electionId])}`);

// ---------------------------------------------------------------- tally

console.log('\n--- tally, from chain data only ---');
const [indexes, shareHexes] = (await read('getRevealedShares', [electionId])) as [
  readonly number[],
  readonly Hex[],
];
console.log(`  ${indexes.length} shares on chain from trustees ${indexes.map((i) => i + 1).join(', ')}`);

const electionKeyHash = ((await read('getElection', [electionId])) as { electionKeyHash: Hex })
  .electionKeyHash;
const keys = await recoverElectionKeys(
  shareHexes.map((h) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'))),
  electionKeyHash,
);
console.log('  recombined shares rebuild the election key the chain committed to');

const ballotLogs = await client.getLogs({
  address: CONTRACT,
  fromBlock: created.blockNumber,
  toBlock: 'latest',
});
const ballots: OnChainBallot[] = [];
for (const log of ballotLogs) {
  try {
    const parsed = decodeEventLog({ abi, data: log.data, topics: log.topics });
    if (parsed.eventName !== 'BallotCast') continue;
    const a = parsed.args as unknown as {
      electionId: bigint;
      voter: Hex;
      envelope: Hex;
      mldsaPublicKey: Hex;
      mldsaSignature: Hex;
    };
    if (a.electionId !== electionId) continue;
    const bytes = (h: Hex) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
    ballots.push({
      voter: a.voter,
      envelope: bytes(a.envelope),
      mldsaPublicKey: bytes(a.mldsaPublicKey),
      mldsaSignature: bytes(a.mldsaSignature),
    });
  } catch {
    // not one of ours
  }
}
console.log(`  ${ballots.length} ballots read from the event log`);

const roll = new Map<string, Hex>(
  voters.map((v) => [v.evmAddress.toLowerCase(), keccak256(v.mldsaPublicKey)]),
);
const result = tallyBallots({
  ...ref,
  chainId: NETWORK.chainId,
  options: OPTIONS,
  ballots,
  roll,
  keys,
});

console.log('\n================ RESULT ================');
for (const [option, count] of result.counts) {
  console.log(`  ${option.padEnd(10)} ${String(count).padStart(2)}  ${'#'.repeat(count)}`);
}
console.log(`  counted ${result.counted}, rejected ${result.rejected.length}`);
for (const r of result.rejected) console.log(`    rejected ${r.voter}: ${r.reason} ${r.detail ?? ''}`);
console.log('========================================');

const expected = CHOICES.reduce<Record<string, number>>((acc, c) => {
  acc[c] = (acc[c] ?? 0) + 1;
  return acc;
}, {});
const got = Object.fromEntries(result.counts);
const matches = OPTIONS.every((o) => (got[o] ?? 0) === (expected[o] ?? 0));
if (!matches) {
  throw new Error(`tally does not match the ballots cast: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}
console.log('\nTally matches the five ballots cast.');

console.log('\n--- voter receipt checks ---');
for (const [i, r] of receipts.entries()) {
  const ok = await read('verifyReceipt', [electionId, r.voter, r.envelopeHash]);
  console.log(`  voter ${i + 1}: ballot present on chain = ${ok}`);
  if (!ok) throw new Error(`voter ${i + 1} cannot verify their ballot`);
}

console.log(`\nElection ${electionId} complete.`);

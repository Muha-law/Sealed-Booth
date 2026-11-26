/**
 * ONE trustee, as its own OS process.
 *
 *   npx tsx scripts/09-trustee.ts <index 0-based> <electionId>
 *
 * This process reads exactly one mnemonic — its own. It never sees another
 * trustee's key, which is the point: the earlier live run combined shares in a
 * single process holding all three keys, so it proved nothing about separation.
 *
 * After the close it:
 *   1. opens its OWN sealed share (from the ShareSealed event) with its own
 *      ML-KEM-1024 decapsulation key;
 *   2. re-seals that share once per trustee, to each trustee's REGISTERED
 *      ML-KEM-1024 key, and publishes the envelopes via releaseShare;
 *   3. collects shares released to it, checking each against the commitment the
 *      contract fixed at creation;
 *   4. once it holds k, recombines the seed, decrypts the ballots and submits
 *      totals.
 *
 * Nothing readable about a share ever reaches the chain.
 */
import { readFileSync } from 'node:fs';
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  toHex,
  type Abi,
  type Hex,
} from 'viem';
import { fetchKemKey } from '@qorechain/qoreseal/network';
import { open, seal, sealKeysFromSeed, verifyRecipientCard } from '@qorechain/qoreseal';
import { fetchPqcStatus } from '@qorechain/sdk';
import { fromBase64 } from '@qorechain/qoresign';
import { combine } from 'shamir-secret-sharing';

// @ts-expect-error - .mjs helper
import { loadEnv, NETWORK, requireEnv } from './lib/env.mjs';
// @ts-expect-error - .mjs helper
import { trusteeAccount, TRUSTEE_ENV_KEYS } from './lib/accounts.mjs';
// @ts-expect-error - .mjs helper
import { unifiedAccount } from './lib/chain.mjs';
// @ts-expect-error - .mjs helper, no type declarations
import { ensureWindow, publicClient, walletClient, maxFeePerGas } from './lib/evm.mjs';
// @ts-expect-error - .mjs helper
import { recordProof } from './lib/proof.mjs';
import { BALLOT_PURPOSE, SHARE_PURPOSE, BALLOT_PLAINTEXT_VERSION } from '../src/core/constants.js';
import { ballotAad } from '../src/core/ballot.js';
import { packElectionKey } from '../src/core/electionKey.js';

const ME = Number(process.argv[2]);
const ELECTION_ID = BigInt(process.argv[3] ?? '0');
if (!Number.isInteger(ME) || ME < 0 || ELECTION_ID === 0n) {
  throw new Error('usage: npx tsx scripts/09-trustee.ts <trusteeIndex> <electionId>');
}

const env = loadEnv();
const CONTRACT = requireEnv(env, 'ELECTION_CONTRACT_ADDRESS') as Hex;
const abi = JSON.parse(readFileSync('out/Election.sol/Election.json', 'utf8')).abi as Abi;
const log = (m: string) => console.log(`[trustee ${ME + 1}] ${m}`);
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));

// ---- the ONLY secret this process touches ----
const myEnvKey = TRUSTEE_ENV_KEYS[ME] as string;
const me = trusteeAccount(requireEnv(env, myEnvKey));
const myUnified = await unifiedAccount(requireEnv(env, myEnvKey));
log(`acting as ${me.bech32} / ${myUnified.evm}`);

const client = publicClient();
const fee = await maxFeePerGas(client);
const read = (fn: string, args: readonly unknown[] = []) =>
  client.readContract({ address: CONTRACT, abi, functionName: fn, args });

/** EIP-7623 calldata floor. The chain refuses to broadcast below it. */
function calldataFloorGas(data: Hex): bigint {
  const body = data.slice(2);
  let tokens = 0n;
  for (let i = 0; i < body.length; i += 2) tokens += body.slice(i, i + 2) === '00' ? 1n : 4n;
  return 21_000n + 10n * tokens;
}

/**
 * submitTally has two very different costs and an estimate cannot tell which
 * one you will pay. The first submission just records a hash; the k-th one also
 * writes the whole Result struct, including the totals array, and costs roughly
 * 2.6x more. Trustees run concurrently and land in the same block, so a trustee
 * that estimated as "not the k-th" can execute as the k-th and run out of gas.
 *
 * Measured: a 77,574-gas first submission vs a 199,874-gas finalising one. An
 * 86,882 limit from a 1.12x margin was consumed entirely — on this chain an
 * out-of-gas looks like `status: reverted` with gasUsed == the limit and no
 * revert data, and replaying at the parent block succeeds.
 *
 * So floor submitTally high enough to cover the finalising branch.
 */
const MIN_GAS: Record<string, bigint> = { submitTally: 320_000n };

async function send(fn: string, args: readonly unknown[]) {
  const estimate = await client.estimateContractGas({
    address: CONTRACT,
    abi,
    functionName: fn,
    args,
    account: myUnified.evm,
  });
  const floor = calldataFloorGas(encodeFunctionData({ abi, functionName: fn, args }));
  const withMargin = (estimate * 112n) / 100n;
  const branchFloor = MIN_GAS[fn] ?? 0n;
  const lower = floor > branchFloor ? floor : branchFloor;
  const limit = withMargin > lower ? withMargin : (lower * 102n) / 100n;

  const wallet = walletClient(myUnified.privateKey);
  const hash = await wallet.writeContract({
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
  return { hash: hash as Hex, estimate, floor, limit, gasUsed: r.gasUsed as bigint };
}

const election = (await read('getElection', [ELECTION_ID])) as {
  trusteeCount: number;
  threshold: number;
  closeAt: bigint;
  electionKeyHash: Hex;
};
const options = (await read('getOptions', [ELECTION_ID])) as readonly string[];
const n = Number(election.trusteeCount);
const k = Number(election.threshold);
log(`election ${ELECTION_ID}: ${k} of ${n} trustees`);

// ---- everything else comes from the chain, all of it public ----
const head = await client.getBlockNumber();
const fromBlock = head > 9_000n ? head - 9_000n : 0n;
const logs = await client.getLogs({ address: CONTRACT, fromBlock, toBlock: 'latest' });

let trusteeAddresses: Hex[] = [];
let keyRefs: Hex[] = [];
const sealedByIndex = new Map<number, Uint8Array>();
const ballots: { ballotId: bigint; ciphertext: Uint8Array }[] = [];

for (const l of logs) {
  let parsed;
  try {
    parsed = decodeEventLog({ abi, data: l.data, topics: l.topics });
  } catch {
    continue;
  }
  const a = parsed.args as unknown as Record<string, unknown>;
  if (a.electionId !== ELECTION_ID) continue;

  if (parsed.eventName === 'ElectionCreated') {
    trusteeAddresses = a.trustees as Hex[];
    keyRefs = a.trusteeKeyRefs as Hex[];
  } else if (parsed.eventName === 'ShareSealed') {
    sealedByIndex.set(Number(a.trusteeIndex), bytes(a.sealedShare as string));
  } else if (parsed.eventName === 'BallotCast') {
    ballots.push({ ballotId: a.ballotId as bigint, ciphertext: bytes(a.ciphertext as string) });
  }
}
if (trusteeAddresses.length !== n) throw new Error('could not read the panel from the chain');
log(`read the panel and ${ballots.length} ballots from the event log`);

/**
 * The panel's recipients, each resolved from the on-chain KEM registry and
 * verified two ways: the card must be signed by that account's registered
 * ML-DSA-87 key, and the registered ML-KEM key must match the keyRef the
 * contract stored at creation.
 */
const cards = JSON.parse(readFileSync('build/trustee-cards.json', 'utf8')) as {
  address: string;
  card: Parameters<typeof verifyRecipientCard>[0]['card'];
}[];

const panel = [];
for (let i = 0; i < n; i++) {
  const card = cards[i]!;
  const kem = await fetchKemKey({ rest: NETWORK.rest, address: card.address });
  if (!kem.registered) throw new Error(`trustee ${i + 1} has no registered ML-KEM key`);
  if (keccak256(kem.publicKey!) !== keyRefs[i]) {
    throw new Error(`trustee ${i + 1}: registered ML-KEM key does not match the on-chain keyRef`);
  }
  const status = (await fetchPqcStatus({ rest: NETWORK.rest, address: card.address })) as {
    pubkey: string;
  };
  panel.push(
    verifyRecipientCard({
      card: card.card,
      chainId: NETWORK.chainId,
      pqPublicKey: fromBase64(status.pubkey),
      mlkemPublicKey: kem.publicKey!,
    }),
  );
}
log(`verified ${panel.length} recipient keys against the registry and the on-chain refs`);

await ensureWindow(myUnified, { txs: 4, gasEach: 700_000, blocks: 17_280 });

// ---- 1 + 2: open my own share, re-seal it to the panel, release ----
const alreadyReleased = (await read('shareReleased', [ELECTION_ID, ME])) as boolean;
if (alreadyReleased) {
  log('already released in an earlier run, skipping');
} else {
  const mySealed = sealedByIndex.get(ME);
  if (!mySealed) throw new Error(`no sealed share on chain for trustee index ${ME}`);

  const myShare = open({
    chainId: NETWORK.chainId,
    purpose: SHARE_PURPOSE,
    envelope: mySealed,
    keys: me.sealKeys,
  });

  // Sanity: my own share must match the commitment the contract holds.
  const myCommitment = (await read('shareCommitment', [ELECTION_ID, ME])) as Hex;
  if (keccak256(myShare) !== myCommitment) {
    throw new Error('my own share does not match its on-chain commitment');
  }
  log(`opened my share (${myShare.length} B), matches its commitment`);

  const envelopes = panel.map((recipient) =>
    toHex(
      seal({
        chainId: NETWORK.chainId,
        purpose: SHARE_PURPOSE,
        mode: 'hybrid',
        recipients: [recipient],
        plaintext: myShare,
      }),
    ),
  );

  const sent = await send('releaseShare', [ELECTION_ID, envelopes]);
  log(`released to all ${n} trustees — gas estimate ${sent.estimate}, floor ${sent.floor}, charged ${sent.gasUsed}`);
  recordProof({
    proves:
      `trustee ${ME + 1} released its share to the panel on Election.sol: its own share re-sealed with QoreSeal ` +
      `once per trustee to each trustee's REGISTERED ML-KEM-1024 key, so nothing readable touches the chain. ` +
      `Sent from a process holding only trustee ${ME + 1}'s key`,
    txHash: sent.hash,
    gasUsed: sent.gasUsed,
    lane: 'evm',
  });
}

// ---- 3: collect k shares released to me ----
log(`waiting for ${k} released shares...`);
const collected = new Map<number, Uint8Array>();

for (let attempt = 0; attempt < 60; attempt++) {
  const since = await client.getBlockNumber();
  const releaseLogs = await client.getLogs({
    address: CONTRACT,
    fromBlock: since > 9_000n ? since - 9_000n : 0n,
    toBlock: 'latest',
  });

  for (const l of releaseLogs) {
    let parsed;
    try {
      parsed = decodeEventLog({ abi, data: l.data, topics: l.topics });
    } catch {
      continue;
    }
    if (parsed.eventName !== 'ShareReleased') continue;
    const a = parsed.args as unknown as {
      electionId: bigint;
      trusteeIndex: number;
      sealedToTrustees: readonly Hex[];
    };
    if (a.electionId !== ELECTION_ID) continue;

    const from = Number(a.trusteeIndex);
    if (collected.has(from)) continue;

    // Only the envelope addressed to ME is openable by me.
    const mine = a.sealedToTrustees[ME];
    if (!mine) continue;
    let share: Uint8Array;
    try {
      share = open({
        chainId: NETWORK.chainId,
        purpose: SHARE_PURPOSE,
        envelope: bytes(mine),
        keys: me.sealKeys,
      });
    } catch (err) {
      log(`could not open the envelope trustee ${from + 1} addressed to me: ${String(err)}`);
      continue;
    }

    // The commitment check: a trustee cannot release junk undetected.
    const commitment = (await read('shareCommitment', [ELECTION_ID, from])) as Hex;
    if (keccak256(share) !== commitment) {
      log(`REJECTED trustee ${from + 1}: share does not match its on-chain commitment`);
      continue;
    }
    collected.set(from, share);
    log(`accepted a share from trustee ${from + 1} (${collected.size}/${k})`);
  }

  if (collected.size >= k) break;
  await new Promise((r) => setTimeout(r, 5000));
}

if (collected.size < k) {
  throw new Error(`only collected ${collected.size} of ${k} shares; cannot tally`);
}

// ---- 4: recombine, decrypt, submit ----
const seed = await combine([...collected.values()].slice(0, k));
const keys = sealKeysFromSeed(seed);

// The rebuilt key must be the one the contract committed to at creation.
// Catches too-few shares and shares from a different election.
const rebuiltHash = keccak256(packElectionKey(keys.mlkemPublicKey, keys.x25519PublicKey));
if (rebuiltHash.toLowerCase() !== election.electionKeyHash.toLowerCase()) {
  throw new Error(
    `recombined shares do not rebuild the election key the contract stored ` +
      `(got ${rebuiltHash}, chain has ${election.electionKeyHash})`,
  );
}
log('recombined the seed and rebuilt the election key the chain committed to');

const aad = ballotAad({ evmChainId: NETWORK.evmChainId, contract: CONTRACT, electionId: ELECTION_ID });
ballots.sort((a, b) => Number(a.ballotId - b.ballotId));
const totals = options.map(() => 0n);
for (const b of ballots) {
  const plain = JSON.parse(
    new TextDecoder().decode(
      open({ chainId: NETWORK.chainId, purpose: BALLOT_PURPOSE, envelope: b.ciphertext, keys, aad }),
    ),
  ) as { v: number; choice: string };
  if (plain.v !== BALLOT_PLAINTEXT_VERSION) throw new Error('unexpected ballot version');
  const at = options.indexOf(plain.choice);
  if (at < 0) throw new Error(`ballot ${b.ballotId} chose an unknown option`);
  totals[at]!++;
}
const countedBallotIdsHash = keccak256(
  encodeAbiParameters(parseAbiParameters('uint256[]'), [ballots.map((b) => b.ballotId)]),
);
log(`counted ${ballots.length} ballots: ${options.map((o, i) => `${o}=${totals[i]}`).join('  ')}`);

const already = (await read('tallySubmission', [ELECTION_ID, myUnified.evm])) as Hex;
if (already !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
  log('already submitted a tally in an earlier run, skipping');
} else {
  const sent = await send('submitTally', [ELECTION_ID, totals, countedBallotIdsHash]);
  const status = (await read('resultStatus', [ELECTION_ID])) as [boolean, number, number];
  log(`submitted — agreements ${status[1]}/${status[2]}, final ${status[0]}, charged ${sent.gasUsed}`);
  recordProof({
    proves:
      `trustee ${ME + 1} tallied independently in its own process and submitted totals for election ${ELECTION_ID}` +
      (status[0] ? ` — this was the ${status[1]}th matching submission, so the result is FINAL` : ''),
    txHash: sent.hash,
    gasUsed: sent.gasUsed,
    lane: 'evm',
  });
}

log('done');

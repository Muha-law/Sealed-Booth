/**
 * ONE trustee, as its own OS process.
 *
 *   npx tsx scripts/09-trustee.ts <index 0-based> <electionId> [--creation-tx 0x...] [--dry-run]
 *
 * --creation-tx is the transaction that created the election. Every event is
 * read by scanning from its block in 9,000-block chunks, because this node caps
 * eth_getLogs at 10,000 blocks and an election is usually weeks old by its
 * tally. For the demo election it defaults to BOOTH_DEMO_ELECTION_TX.
 *
 * --dry-run reads everything, verifies the panel and checks that the scan found
 * every ballot the contract counted, then stops. It sends no transaction.
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
import { toQorAddress } from '@qorechain/evm/window';
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
import { SHARE_PURPOSE } from '../src/core/constants.js';
import { packElectionKey } from '../src/core/electionKey.js';
import { tallyBallots, type OnChainBallot, type RegistryKeys } from '../src/core/tally.js';
import { chunkRanges } from '../src/core/logRange.js';

const ME = Number(process.argv[2]);
const ELECTION_ID = BigInt(process.argv[3] ?? '0');
const DRY_RUN = process.argv.includes('--dry-run');
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
if (!Number.isInteger(ME) || ME < 0 || ELECTION_ID === 0n) {
  throw new Error(
    'usage: npx tsx scripts/09-trustee.ts <trusteeIndex> <electionId> [--creation-tx 0x...] [--dry-run]',
  );
}

const env = loadEnv();
const CONTRACT = requireEnv(env, 'ELECTION_CONTRACT_ADDRESS') as Hex;
const CREATION_TX = (flag('--creation-tx') ??
  (env.BOOTH_DEMO_ELECTION_ID && BigInt(env.BOOTH_DEMO_ELECTION_ID) === ELECTION_ID
    ? env.BOOTH_DEMO_ELECTION_TX
    : undefined)) as Hex | undefined;
if (!CREATION_TX) {
  throw new Error(`pass --creation-tx <hash of the transaction that created election ${ELECTION_ID}>`);
}
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
  voterCount: number;
  ballotCount: number;
  electionKeyHash: Hex;
};
const options = (await read('getOptions', [ELECTION_ID])) as readonly string[];
const n = Number(election.trusteeCount);
const k = Number(election.threshold);
log(`election ${ELECTION_ID}: ${k} of ${n} trustees`);

// ---- everything else comes from the chain, all of it public ----
type ChainLog = Awaited<ReturnType<typeof client.getLogs>>[number];

/** Every log this contract emitted in [from, to], in 9,000-block chunks. */
async function scanLogs(from: bigint, to: bigint): Promise<ChainLog[]> {
  const out: ChainLog[] = [];
  for (const [a, b] of chunkRanges(from, to)) {
    for (let attempt = 1; ; attempt++) {
      try {
        out.push(...(await client.getLogs({ address: CONTRACT, fromBlock: a, toBlock: b })));
        break;
      } catch (err) {
        // A transient RPC error must not silently drop a chunk of ballots.
        if (attempt >= 4) throw new Error(`getLogs ${a}..${b} failed ${attempt} times: ${String(err)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  return out;
}

// The creation block, from the creation transaction's receipt (no age limit),
// checked to really be this election on this contract.
const creation = await client.getTransactionReceipt({ hash: CREATION_TX });
const createdHere = creation.logs.some((l: ChainLog) => {
  if (l.address.toLowerCase() !== CONTRACT.toLowerCase()) return false;
  try {
    const p = decodeEventLog({ abi, data: l.data, topics: l.topics });
    return p.eventName === 'ElectionCreated' && (p.args as unknown as { electionId: bigint }).electionId === ELECTION_ID;
  } catch {
    return false;
  }
});
if (!createdHere) {
  throw new Error(`transaction ${CREATION_TX} did not create election ${ELECTION_ID} on ${CONTRACT}`);
}
const creationBlock = creation.blockNumber as bigint;

const head = await client.getBlockNumber();
const logs = await scanLogs(creationBlock, head);
log(`scanned blocks ${creationBlock}..${head} (${chunkRanges(creationBlock, head).length} chunk(s)), ${logs.length} log(s)`);
const releaseLogs0: ChainLog[] = [];

let trusteeAddresses: Hex[] = [];
let keyRefs: Hex[] = [];
const sealedByIndex = new Map<number, Uint8Array>();
const ballots: OnChainBallot[] = [];
const roll = new Set<string>();

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
    ballots.push({
      ballotId: a.ballotId as bigint,
      // The CHAIN's view of who cast it. tallyBallots rebuilds the signed
      // message from this, never from anything inside the ballot.
      voter: a.voter as Hex,
      ciphertext: bytes(a.ciphertext as string),
    });
  } else if (parsed.eventName === 'VoterAllowed') {
    roll.add((a.voter as string).toLowerCase());
  } else if (parsed.eventName === 'ShareReleased') {
    releaseLogs0.push(l);
  }
}
if (trusteeAddresses.length !== n) throw new Error('could not read the panel from the chain');
log(`read the panel and ${ballots.length} ballots from the event log`);

// Completeness: the scan must have found exactly the ballots the contract
// counted, ids 1..N, each matching the hash in storage. A tally over a partial
// set would be wrong yet look final, so this is checked on every run.
{
  const expected = Number(election.ballotCount);
  const ids = ballots.map((b) => b.ballotId).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const contiguous = ids.every((id, i) => id === BigInt(i + 1));
  if (ballots.length !== expected || !contiguous) {
    throw new Error(
      `scan found ${ballots.length} ballot(s) [${ids.join(',')}] but the contract counts ${expected}; refusing to tally`,
    );
  }
  for (const b of ballots) {
    const stored = (await read('ballotHash', [ELECTION_ID, b.ballotId])) as Hex;
    if (stored.toLowerCase() !== keccak256(b.ciphertext).toLowerCase()) {
      throw new Error(`ballot ${b.ballotId}: event ciphertext does not match the hash in storage`);
    }
  }
  if (roll.size !== Number(election.voterCount)) {
    throw new Error(`scan found ${roll.size} allowlisted voter(s) but the contract counts ${election.voterCount}`);
  }
  log(
    `complete: all ${expected} ballot(s) found, ids 1..${expected}, each matches storage; ` +
      `roll ${roll.size}/${election.voterCount}; ${sealedByIndex.size} sealed share(s)`,
  );
}

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

if (DRY_RUN) {
  const isOpenNow = (await read('isOpen', [ELECTION_ID])) as boolean;
  log(`dry run: election ${isOpenNow ? 'still open' : 'closed'}; stopping before any transaction`);
  process.exit(0);
}

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

// Releases already in the full scan first, then only blocks not yet scanned,
// so a share released long before this process started is still found.
let scannedTo = head;
for (let attempt = 0; attempt < 60; attempt++) {
  let releaseLogs: ChainLog[];
  if (attempt === 0) {
    releaseLogs = releaseLogs0;
  } else {
    const now = await client.getBlockNumber();
    releaseLogs = now > scannedTo ? await scanLogs(scannedTo + 1n, now) : [];
    if (now > scannedTo) scannedTo = now;
  }

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

// Every voter's ML-DSA-87 key, from the chain's PQC registry. The identity
// comes from the registry and the signature from the ballot — never both from
// the ballot. This endpoint sends no CORS headers, which is why the tally runs
// here and not in a browser page.
const registryKeys: Map<string, Uint8Array> = new Map();
for (const b of ballots) {
  const key = b.voter.toLowerCase();
  if (registryKeys.has(key)) continue;
  // fetchPqcStatus needs the bech32 form: a 0x address returns HTTP 400.
  // fetchKemKey accepts either, which makes the asymmetry easy to miss.
  const status = (await fetchPqcStatus({
    rest: NETWORK.rest,
    address: toQorAddress(b.voter),
  })) as { pubkey?: string; registered?: boolean };
  if (status.pubkey) registryKeys.set(key, fromBase64(status.pubkey));
}
log(`fetched ${registryKeys.size} registered ML-DSA-87 key(s) for ${ballots.length} ballot(s)`);

const result = tallyBallots({
  evmChainId: NETWORK.evmChainId,
  contract: CONTRACT,
  electionId: ELECTION_ID,
  chainId: NETWORK.chainId,
  options,
  ballots,
  roll,
  registryKeys: registryKeys as RegistryKeys,
  keys,
});

const totals = options.map((o) => BigInt(result.counts.get(o) ?? 0));
const countedBallotIdsHash = keccak256(
  encodeAbiParameters(parseAbiParameters('uint256[]'), [result.countedBallotIds]),
);

log(`counted ${result.counted} of ${ballots.length} ballots: ${options.map((o, i) => `${o}=${totals[i]}`).join('  ')}`);
for (const r of result.rejected) {
  log(`  REJECTED ballot ${r.ballotId} from ${r.voter}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
}
if (result.rejected.length === 0) log('  no ballots rejected');

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

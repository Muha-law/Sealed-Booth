/**
 * Opening the ballots, in a trustee's browser or process, after voting closed.
 *
 * This runs for a TRUSTEE, not for the public. No share ever goes on chain in
 * readable form: each trustee opens its own sealed share with its own
 * ML-KEM-1024 key, re-seals it to the other trustees' registered keys, and a
 * trustee holding k of them recombines the seed here and counts.
 *
 * The post-quantum check that makes a ballot count: the ML-DSA-87 signature
 * sealed inside the envelope must verify against the key the chain's PQC
 * registry holds for `ballotVoter(electionId, ballotId)`. The identity comes
 * from the chain and the signature from the ballot — never both from the
 * ballot — so a ballot cannot assert who cast it.
 *
 * The flip side, stated plainly: any trustee who collects k shares can open
 * every ballot, and because the ballot events carry the voter's address, it can
 * see who voted what.
 */
import { open, sealKeysFromSeed, isQoreSealError, type SealKeyPair } from '@qorechain/qoreseal';
import { pqVerify } from '@qorechain/qoresign';
import { combine } from 'shamir-secret-sharing';
import { hexToBytes, keccak256, type Hex } from 'viem';
import { BALLOT_PURPOSE } from './constants.js';
import { ballotAad, ballotSigMessage, decodeBallotPlaintext, type ElectionRef } from './ballot.js';
import { packElectionKey } from './electionKey.js';

/** One ballot, as read from the chain. */
export interface OnChainBallot {
  ballotId: bigint;
  /** `ballotVoter(electionId, ballotId)` — who the CHAIN says cast it. */
  voter: Hex;
  ciphertext: Uint8Array;
}

/**
 * ML-DSA-87 public keys as the chain's PQC registry reports them, keyed by
 * lowercase voter address. The caller fetches them from
 * `/qorechain/pqc/v1/account/{address}`, because that endpoint sends no CORS
 * headers and cannot be read from a browser page (docs/VERIFIED-FACTS.md).
 */
export type RegistryKeys = ReadonlyMap<string, Uint8Array>;

export type RejectionReason =
  | 'not-on-roll'
  | 'no-registered-pq-key'
  | 'bad-mldsa-signature'
  | 'undecryptable'
  | 'malformed-plaintext'
  | 'unknown-option'
  | 'duplicate-voter';

export interface Rejection {
  ballotId: bigint;
  voter: Hex;
  reason: RejectionReason;
  detail?: string;
}

export interface TallyResult {
  /** One entry per declared option, including the ones nobody chose. */
  counts: ReadonlyMap<string, number>;
  counted: number;
  rejected: Rejection[];
  /** Ballot ids that were counted, ascending — what the trustees commit to. */
  countedBallotIds: bigint[];
}

/**
 * Recombine k shares into the election key pair. The shares come from each
 * trustee opening what was released to it, never from the chain in plaintext.
 *
 * @param expectedElectionKeyHash keccak256 of the election key blob as stored
 *        on chain. Checked, so too few shares or shares from another election
 *        are caught here rather than producing a silently empty tally.
 */
export async function recoverElectionKeys(
  shares: Uint8Array[],
  expectedElectionKeyHash: Hex,
): Promise<SealKeyPair> {
  if (shares.length === 0) throw new Error('no shares to recombine');

  const seed = await combine(shares);
  const keys = sealKeysFromSeed(seed);
  const blobHash = keccak256(packElectionKey(keys.mlkemPublicKey, keys.x25519PublicKey));

  if (blobHash.toLowerCase() !== expectedElectionKeyHash.toLowerCase()) {
    throw new Error(
      'recombined shares do not rebuild the election key on chain: too few shares, ' +
        'or shares from a different election',
    );
  }
  return keys;
}

export interface TallyArgs extends ElectionRef {
  /** QoreChain native chain id; must match what the ballots were sealed under. */
  chainId: string;
  /** Every option the election declared, so zero-vote options still appear. */
  options: readonly string[];
  ballots: readonly OnChainBallot[];
  /** Voters the contract allowlisted. Lowercase addresses. */
  roll: ReadonlySet<string>;
  /** ML-DSA-87 keys from the registry, by lowercase voter address. */
  registryKeys: RegistryKeys;
  keys: SealKeyPair;
}

/** Count the ballots. Pure: same inputs, same output, no network. */
export function tallyBallots(args: TallyArgs): TallyResult {
  const { chainId, options, ballots, roll, registryKeys, keys } = args;

  const counts = new Map<string, number>(options.map((o) => [o, 0]));
  const rejected: Rejection[] = [];
  const countedBallotIds: bigint[] = [];
  const seen = new Set<string>();
  const aad = ballotAad(args);
  let counted = 0;

  const sorted = [...ballots].sort((a, b) => (a.ballotId < b.ballotId ? -1 : 1));

  for (const ballot of sorted) {
    const voter = ballot.voter.toLowerCase();
    const reject = (reason: RejectionReason, detail?: string) =>
      rejected.push({ ballotId: ballot.ballotId, voter: ballot.voter, reason, detail });

    // The contract enforces one ballot per voter, but the tally must not
    // depend on that: it reads events, and events can be replayed to it.
    if (seen.has(voter)) {
      reject('duplicate-voter');
      continue;
    }
    seen.add(voter);

    if (!roll.has(voter)) {
      reject('not-on-roll');
      continue;
    }

    const registered = registryKeys.get(voter);
    if (!registered) {
      reject('no-registered-pq-key');
      continue;
    }

    let plaintext: Uint8Array;
    try {
      plaintext = open({
        chainId,
        purpose: BALLOT_PURPOSE,
        envelope: ballot.ciphertext,
        keys,
        aad,
      });
    } catch (err) {
      reject('undecryptable', isQoreSealError(err) ? err.code : String(err));
      continue;
    }

    let decoded;
    try {
      decoded = decodeBallotPlaintext(plaintext);
    } catch (err) {
      reject('malformed-plaintext', err instanceof Error ? err.message : String(err));
      continue;
    }

    // THE post-quantum check. The message is rebuilt from the CHAIN's view of
    // who cast this ballot, so a ciphertext replayed from another account — or
    // lifted from another election — fails here.
    const message = ballotSigMessage({
      evmChainId: args.evmChainId,
      contract: args.contract,
      electionId: args.electionId,
      voter: ballot.voter,
      choice: decoded.choice,
      nonce: decoded.nonce,
    });

    if (!pqVerify(registered, hexToBytes(message), decoded.signature)) {
      reject('bad-mldsa-signature');
      continue;
    }

    if (!counts.has(decoded.choice)) {
      reject('unknown-option', decoded.choice);
      continue;
    }

    counts.set(decoded.choice, (counts.get(decoded.choice) ?? 0) + 1);
    countedBallotIds.push(ballot.ballotId);
    counted++;
  }

  return { counts, counted, rejected, countedBallotIds };
}

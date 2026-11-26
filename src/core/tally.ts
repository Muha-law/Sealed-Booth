/**
 * Opening the ballots, in a trustee's browser, after voting closed.
 *
 * This runs for a TRUSTEE, not for the public. No share ever goes on chain in
 * readable form: each trustee opens its own sealed share with its own
 * ML-KEM-1024 key, re-seals it to the other trustees' registered keys, and a
 * trustee holding k of them recombines the seed here and counts.
 *
 * So the tally is reproducible by any trustee who gathers k shares — not by an
 * outside observer, who sees only ciphertext and the totals k trustees agreed
 * on. That is the deliberate trade against Booth v1, which published plaintext
 * shares and so destroyed ballot secrecy; see docs/ARCHITECTURE.md.
 *
 * The flip side, stated plainly: any trustee who collects k shares can open
 * every ballot, and because the ballot events carry the voter's address, it can
 * see who voted what.
 *
 * A ballot is counted only if its ML-DSA-87 signature verifies against the key
 * registered for that voter, and the rejection list says which ballots were
 * discarded and why.
 */
import { open, sealKeysFromSeed, isQoreSealError, type SealKeyPair } from '@qorechain/qoreseal';
import { pqVerify } from '@qorechain/qoresign';
import { combine } from 'shamir-secret-sharing';
import { keccak256, type Hex } from 'viem';
import { BALLOT_PLAINTEXT_VERSION, BALLOT_PURPOSE } from './constants.js';
import { ballotAad, ballotCommitment, type ElectionRef } from './ballot.js';
import { packElectionKey } from './electionKey.js';

/** One `BallotCast` event, as read from the chain. */
export interface OnChainBallot {
  voter: Hex;
  envelope: Uint8Array;
  mldsaPublicKey: Uint8Array;
  mldsaSignature: Uint8Array;
}

/** The roll as the contract holds it: voter address => keccak256(ML-DSA-87 public key). */
export type Roll = ReadonlyMap<string, Hex>;

export type RejectionReason =
  | 'not-on-roll'
  | 'wrong-pq-key'
  | 'bad-mldsa-signature'
  | 'undecryptable'
  | 'malformed-plaintext'
  | 'unknown-option'
  | 'duplicate-voter';

export interface Rejection {
  voter: Hex;
  reason: RejectionReason;
  detail?: string;
}

export interface TallyResult {
  /** One entry per declared option, including the ones nobody chose. */
  counts: ReadonlyMap<string, number>;
  counted: number;
  rejected: Rejection[];
}

/**
 * Recombine k shares into the election key pair. The shares come from each
 * trustee opening what was released to it, never from the chain in plaintext.
 *
 * @param expectedElectionKeyHash keccak256 of the election key blob as stored
 *        on chain. Checked, so a wrong or tampered share set is caught here
 *        rather than producing a silently empty tally.
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
  roll: Roll;
  keys: SealKeyPair;
}

/** Count the ballots. Pure: same inputs, same output, no network. */
export function tallyBallots(args: TallyArgs): TallyResult {
  const { chainId, options, ballots, roll, keys } = args;

  const counts = new Map<string, number>(options.map((o) => [o, 0]));
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  const aad = ballotAad(args);
  let counted = 0;

  for (const ballot of ballots) {
    const voter = ballot.voter.toLowerCase();

    // The contract already enforces one ballot per voter, but the tally must
    // not depend on that: it reads events, and events can be replayed to it.
    if (seen.has(voter)) {
      rejected.push({ voter: ballot.voter, reason: 'duplicate-voter' });
      continue;
    }
    seen.add(voter);

    const registered = roll.get(voter);
    if (!registered) {
      rejected.push({ voter: ballot.voter, reason: 'not-on-roll' });
      continue;
    }

    const keyHash = keccak256(ballot.mldsaPublicKey);
    if (keyHash.toLowerCase() !== registered.toLowerCase()) {
      rejected.push({ voter: ballot.voter, reason: 'wrong-pq-key' });
      continue;
    }

    // The post-quantum eligibility proof. This is the check the chain cannot do.
    const envelopeHash = keccak256(ballot.envelope);
    const commitment = ballotCommitment(args, keyHash, envelopeHash);
    const commitmentBytes = Uint8Array.from(Buffer.from(commitment.slice(2), 'hex'));

    if (!pqVerify(ballot.mldsaPublicKey, commitmentBytes, ballot.mldsaSignature)) {
      rejected.push({ voter: ballot.voter, reason: 'bad-mldsa-signature' });
      continue;
    }

    let plaintext: Uint8Array;
    try {
      plaintext = open({
        chainId,
        purpose: BALLOT_PURPOSE,
        envelope: ballot.envelope,
        keys,
        aad,
      });
    } catch (err) {
      rejected.push({
        voter: ballot.voter,
        reason: 'undecryptable',
        detail: isQoreSealError(err) ? err.code : String(err),
      });
      continue;
    }

    let choice: string;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { v?: unknown }).v !== BALLOT_PLAINTEXT_VERSION ||
        typeof (parsed as { choice?: unknown }).choice !== 'string'
      ) {
        throw new Error('not a Booth ballot v1');
      }
      choice = (parsed as { choice: string }).choice;
    } catch (err) {
      rejected.push({ voter: ballot.voter, reason: 'malformed-plaintext', detail: String(err) });
      continue;
    }

    if (!counts.has(choice)) {
      rejected.push({ voter: ballot.voter, reason: 'unknown-option', detail: choice });
      continue;
    }

    counts.set(choice, (counts.get(choice) ?? 0) + 1);
    counted++;
  }

  return { counts, counted, rejected };
}

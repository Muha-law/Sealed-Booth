/**
 * Creating an election: generate the election ML-KEM-1024 key, split its seed
 * k-of-n across the trustees, and seal each share to its trustee.
 *
 * The critical property: this module never returns the election key or its
 * seed. The creator cannot decrypt a single ballot, by construction — the only
 * way back to the key is k trustees revealing their shares after voting closes.
 */
import {
  generateSealKeys,
  recipientOf,
  seal,
  validateMlkemPublicKey,
  type SealKeyPair,
  type SealRecipient,
} from '@qorechain/qoreseal';
import { split } from 'shamir-secret-sharing';
import { keccak256, type Hex } from 'viem';
import { SHARE_PURPOSE } from './constants.js';
import { ELECTION_KEY_BLOB_LENGTH, packElectionKey } from './electionKey.js';

export interface ElectionSetupArgs {
  /** QoreChain native chain id, e.g. `qorechain-diana`. Bound into every envelope. */
  chainId: string;
  /** One recipient per trustee, in the order they will be indexed on chain. */
  trustees: SealRecipient[];
  /** k: how many trustees must reveal before the ballots can be opened. */
  threshold: number;
}

export interface ElectionSetup {
  /**
   * The election key blob that goes on chain: ML-KEM-1024 key plus the X25519
   * key, so ballots can use QoreSeal's hybrid mode. See electionKey.ts.
   */
  electionPublicKey: Uint8Array;
  /** keccak256 of each trustee's plaintext share, in trustee order. Committed on chain. */
  shareCommitments: Hex[];
  /** Each trustee's share, sealed to that trustee. Public: only that trustee can open it. */
  sealedShares: Uint8Array[];
  threshold: number;
  trusteeCount: number;
}

/**
 * Generate an election key and distribute its seed.
 *
 * Splitting the 32-byte seed rather than the 3168-byte decapsulation key keeps
 * shares at 33 bytes; `sealKeysFromSeed` rebuilds the identical key pair from
 * the recombined seed.
 */
export async function setUpElection(args: ElectionSetupArgs): Promise<ElectionSetup> {
  const { chainId, trustees, threshold } = args;
  const n = trustees.length;

  if (n === 0) throw new Error('an election needs at least one trustee');
  if (n > 255) throw new Error(`too many trustees: ${n} (the contract indexes trustees in a uint8)`);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > n) {
    throw new Error(`threshold must be an integer in 1..${n}, got ${threshold}`);
  }

  const election: SealKeyPair = generateSealKeys();
  // Fail loudly here rather than at registration: the chain applies these same checks.
  validateMlkemPublicKey(election.mlkemPublicKey);
  const electionPublicKey = packElectionKey(election.mlkemPublicKey, election.x25519PublicKey);
  if (electionPublicKey.length !== ELECTION_KEY_BLOB_LENGTH) {
    throw new Error(`bad election key blob length ${electionPublicKey.length}`);
  }

  const shares = await split(election.seed, n, threshold);
  if (shares.length !== n) throw new Error(`expected ${n} shares, got ${shares.length}`);

  const sealedShares = shares.map((share, i) => {
    const trustee = trustees[i];
    if (!trustee) throw new Error(`missing trustee at index ${i}`);
    return seal({
      chainId,
      purpose: SHARE_PURPOSE,
      recipients: [trustee],
      plaintext: share,
    });
  });

  const shareCommitments = shares.map((share) => keccak256(share));

  // The seed and the decapsulation key go out of scope here and are never
  // returned. Zero the copies we hold so they do not linger in this heap.
  election.seed.fill(0);
  election.mlkemSecretKey.fill(0);
  election.x25519SecretKey.fill(0);
  for (const share of shares) share.fill(0);

  return {
    electionPublicKey,
    shareCommitments,
    sealedShares,
    threshold,
    trusteeCount: n,
  };
}

/** The public half of a trustee's QoreSeal keys, as a recipient. */
export { recipientOf };

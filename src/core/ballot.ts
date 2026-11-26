/**
 * Casting a ballot, entirely in the browser.
 *
 * The ballot is sealed to the election's ML-KEM-1024 key and then signed twice
 * over the same 32-byte commitment:
 *
 *   * ML-DSA-87  — the post-quantum eligibility proof. Every client checks it
 *                  at tally time; a ballot without it is not counted.
 *   * secp256k1  — the admission gate the contract itself can check, because
 *                  QoreChain's PQC precompile is not callable from contract
 *                  code (docs/VERIFIED-FACTS.md).
 *
 * Nothing here talks to a server. The plaintext choice never leaves the tab.
 */
import { seal } from '@qorechain/qoreseal';
import { pqSign } from '@qorechain/qoresign';
import { privateKeyToAccount } from 'viem/accounts';
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToHex,
  toHex,
  type Hex,
} from 'viem';
import { BALLOT_DOMAIN_PREIMAGE, BALLOT_PLAINTEXT_VERSION, BALLOT_PURPOSE } from './constants.js';
import { unpackElectionKey } from './electionKey.js';
import type { VoterIdentity } from './identity.js';

/** keccak256("booth-ballot-v1") — must equal `Booth.BALLOT_DOMAIN`. */
export const BALLOT_DOMAIN: Hex = keccak256(stringToHex(BALLOT_DOMAIN_PREIMAGE));

export interface ElectionRef {
  /** EVM chain id. 9800 on qorechain-diana. */
  evmChainId: number;
  /** Deployed Booth contract. */
  contract: Hex;
  /** Election id within that contract. */
  electionId: bigint;
}

export interface BallotArgs extends ElectionRef {
  /** QoreChain native chain id, e.g. `qorechain-diana`. Bound into the envelope's KDF. */
  chainId: string;
  /** The election key blob as published on chain (ML-KEM-1024 + X25519). */
  electionPublicKey: Uint8Array;
  /** Exactly one of the election's options. */
  choice: string;
  voter: VoterIdentity;
}

export interface SealedBallot {
  /** QoreSeal envelope. The only part that carries the choice. */
  envelope: Uint8Array;
  envelopeHash: Hex;
  /** What both signatures cover. The voter's receipt. */
  commitment: Hex;
  mldsaPublicKey: Uint8Array;
  /** ML-DSA-87 signature over `commitment`, 4627 bytes. */
  mldsaSignature: Uint8Array;
  /** 65-byte r||s||v secp256k1 signature the contract recovers. */
  secpSignature: Hex;
}

/**
 * Extra authenticated data on the envelope: binds the ciphertext to this
 * election on this contract on this chain. A ballot cannot be lifted into
 * another election even by someone holding the election key.
 */
export function ballotAad(ref: ElectionRef): Uint8Array {
  const hex = encodeAbiParameters(parseAbiParameters('bytes32, uint256, address, uint256'), [
    BALLOT_DOMAIN,
    BigInt(ref.evmChainId),
    ref.contract,
    ref.electionId,
  ]);
  return Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
}

/**
 * The 32 bytes a voter signs. Mirrors `Booth.ballotCommitment` exactly — the
 * test suite asserts the two agree against the compiled contract.
 */
export function ballotCommitment(
  ref: ElectionRef,
  mldsaKeyHash: Hex,
  envelopeHash: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, uint256, address, uint256, bytes32, bytes32'),
      [
        BALLOT_DOMAIN,
        BigInt(ref.evmChainId),
        ref.contract,
        ref.electionId,
        mldsaKeyHash,
        envelopeHash,
      ],
    ),
  );
}

/** The canonical plaintext of a ballot. Versioned so a tally can reject anything else. */
export function ballotPlaintext(choice: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ v: BALLOT_PLAINTEXT_VERSION, choice }),
  );
}

/** Seal and doubly sign a ballot. Browser-side; no network access. */
export async function castBallot(args: BallotArgs): Promise<SealedBallot> {
  const { chainId, electionPublicKey, choice, voter } = args;

  const envelope = seal({
    chainId,
    purpose: BALLOT_PURPOSE,
    // QoreSeal's default hybrid mode: ML-KEM-1024 + X25519, combined through
    // SHA3-256, so breaking X25519 alone gains an attacker nothing.
    mode: 'hybrid',
    recipients: [unpackElectionKey(electionPublicKey)],
    plaintext: ballotPlaintext(choice),
    aad: ballotAad(args),
  });

  const envelopeHash = keccak256(envelope);
  const mldsaKeyHash = keccak256(voter.mldsaPublicKey);
  const commitment = ballotCommitment(args, mldsaKeyHash, envelopeHash);

  const commitmentBytes = Uint8Array.from(Buffer.from(commitment.slice(2), 'hex'));
  const mldsaSignature = pqSign(voter.mldsaSecretKey, commitmentBytes);

  // personal_sign over the raw 32 bytes: exactly what Booth._ethSigned rebuilds.
  const account = privateKeyToAccount(voter.evmPrivateKey);
  const secpSignature = await account.signMessage({ message: { raw: commitment } });

  return {
    envelope,
    envelopeHash,
    commitment,
    mldsaPublicKey: voter.mldsaPublicKey,
    mldsaSignature,
    secpSignature,
  };
}

/** What a voter keeps to check their ballot later. Carries nothing secret. */
export interface Receipt {
  electionId: bigint;
  voter: Hex;
  envelopeHash: Hex;
  commitment: Hex;
}

export function receiptFor(ballot: SealedBallot, args: BallotArgs): Receipt {
  return {
    electionId: args.electionId,
    voter: args.voter.evmAddress,
    envelopeHash: ballot.envelopeHash,
    commitment: ballot.commitment,
  };
}

export { toHex };

/**
 * Casting a ballot, entirely in the browser.
 *
 * The choice is sealed to the election's ML-KEM-1024 key, and the voter's
 * ML-DSA-87 signature is sealed INSIDE that envelope along with it. That is
 * strictly better than publishing the signature alongside: a public signature
 * would link a voter's post-quantum identity to their ciphertext for everyone
 * to see, forever.
 *
 * `Election.castBallot(electionId, ciphertext)` takes one opaque blob and no
 * signature parameter, which is the other reason the signature goes inside.
 *
 * Nothing here touches the network. The plaintext choice never leaves the tab.
 */
import { seal } from '@qorechain/qoreseal';
import { pqSign } from '@qorechain/qoresign';
import {
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  parseAbiParameters,
  stringToHex,
  toHex,
  type Hex,
} from 'viem';
import {
  BALLOT_NONCE_BYTES,
  BALLOT_PLAINTEXT_VERSION,
  BALLOT_PURPOSE,
  BALLOT_SIG_DOMAIN,
  ML_DSA_87_SIGNATURE_BYTES,
} from './constants.js';
import { unpackElectionKey } from './electionKey.js';

/** keccak256("booth-ballot-sig-v1"). */
export const SIG_DOMAIN: Hex = keccak256(stringToHex(BALLOT_SIG_DOMAIN));

export interface ElectionRef {
  /** EVM chain id. 9800 on qorechain-diana. */
  evmChainId: number;
  /** Deployed Election contract. */
  contract: Hex;
  /** Election id within that contract. */
  electionId: bigint;
}

/**
 * Extra authenticated data on the envelope: binds the ciphertext to this
 * election on this contract on this chain, so a ballot cannot be lifted into
 * another election even by someone holding the election key.
 *
 * Separate from, and in addition to, the signed message below.
 */
export function ballotAad(ref: ElectionRef): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(parseAbiParameters('bytes32, uint256, address, uint256'), [
      SIG_DOMAIN,
      BigInt(ref.evmChainId),
      ref.contract,
      ref.electionId,
    ]),
  );
}

export interface SigMessageArgs extends ElectionRef {
  /** The address that sends the transaction, i.e. `ballotVoter` on chain. */
  voter: Hex;
  /** Exactly one of the election's options. */
  choice: string;
  /** 32 random bytes, unique per ballot. */
  nonce: Uint8Array;
}

/**
 * The 32 bytes the voter's ML-DSA-87 key signs.
 *
 * Binds the domain tag, chain id, contract, election, **the voter's own
 * address**, the choice and a random nonce. It deliberately does NOT bind the
 * envelope hash: the signature lives inside the envelope, so that would be
 * circular.
 *
 * Binding the voter's address is what defeats a replay. If B submits A's
 * ciphertext from B's account, the tally recomputes this message with B's
 * address — taken from `ballotVoter` on chain, not from the ballot — and A's
 * signature no longer verifies.
 */
export function ballotSigMessage(args: SigMessageArgs): Hex {
  if (args.nonce.length !== BALLOT_NONCE_BYTES) {
    throw new Error(`nonce must be ${BALLOT_NONCE_BYTES} bytes, got ${args.nonce.length}`);
  }
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, uint256, address, uint256, address, bytes32, bytes32'),
      [
        SIG_DOMAIN,
        BigInt(args.evmChainId),
        args.contract,
        args.electionId,
        args.voter,
        keccak256(stringToHex(args.choice)),
        toHex(args.nonce),
      ],
    ),
  );
}

export interface BallotPlaintext {
  choice: string;
  nonce: Uint8Array;
  /** ML-DSA-87 signature over {@link ballotSigMessage}, 4627 bytes. */
  signature: Uint8Array;
}

/**
 * The ballot plaintext, as a compact binary layout:
 *
 *     byte  0        version = 2
 *     byte  1        choice length in bytes, 1..255
 *     bytes 2..      choice, UTF-8
 *     next  32       nonce
 *     next  4627     ML-DSA-87 signature
 *
 * Binary rather than JSON: hex or base64 would add 50-100% to every ballot, and
 * the ballot is already the largest thing Booth puts on chain. The voter's
 * ML-DSA public key is deliberately absent — the tally fetches it from the
 * chain's PQC registry, so a ballot cannot assert its own identity.
 */
export function encodeBallotPlaintext(p: BallotPlaintext): Uint8Array {
  const choice = new TextEncoder().encode(p.choice);
  if (choice.length === 0 || choice.length > 255) {
    throw new Error(`choice must be 1..255 UTF-8 bytes, got ${choice.length}`);
  }
  if (p.nonce.length !== BALLOT_NONCE_BYTES) {
    throw new Error(`nonce must be ${BALLOT_NONCE_BYTES} bytes, got ${p.nonce.length}`);
  }
  if (p.signature.length !== ML_DSA_87_SIGNATURE_BYTES) {
    throw new Error(
      `signature must be ${ML_DSA_87_SIGNATURE_BYTES} bytes, got ${p.signature.length}`,
    );
  }

  const out = new Uint8Array(2 + choice.length + BALLOT_NONCE_BYTES + ML_DSA_87_SIGNATURE_BYTES);
  out[0] = BALLOT_PLAINTEXT_VERSION;
  out[1] = choice.length;
  out.set(choice, 2);
  out.set(p.nonce, 2 + choice.length);
  out.set(p.signature, 2 + choice.length + BALLOT_NONCE_BYTES);
  return out;
}

/** Inverse of {@link encodeBallotPlaintext}. Throws on anything malformed. */
export function decodeBallotPlaintext(bytes: Uint8Array): BallotPlaintext {
  if (bytes.length < 2) throw new Error('ballot plaintext is too short');
  if (bytes[0] !== BALLOT_PLAINTEXT_VERSION) {
    throw new Error(`unsupported ballot plaintext version ${bytes[0]}`);
  }
  const choiceLen = bytes[1]!;
  if (choiceLen === 0) throw new Error('ballot plaintext has an empty choice');

  const expected = 2 + choiceLen + BALLOT_NONCE_BYTES + ML_DSA_87_SIGNATURE_BYTES;
  if (bytes.length !== expected) {
    throw new Error(`ballot plaintext must be ${expected} bytes, got ${bytes.length}`);
  }

  const choice = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2, 2 + choiceLen));
  const nonce = bytes.slice(2 + choiceLen, 2 + choiceLen + BALLOT_NONCE_BYTES);
  const signature = bytes.slice(2 + choiceLen + BALLOT_NONCE_BYTES);
  return { choice, nonce, signature };
}

/** Size of a sealed ballot in bytes, for gas budgeting. */
export function ballotEnvelopeSize(choice: string): number {
  const plaintext =
    2 + new TextEncoder().encode(choice).length + BALLOT_NONCE_BYTES + ML_DSA_87_SIGNATURE_BYTES;
  // QoreSeal: 56-byte header + one hybrid recipient entry (1664) + plaintext.
  return 56 + 1664 + plaintext;
}

export interface CastBallotArgs extends ElectionRef {
  /** QoreChain native chain id, bound into the envelope's KDF. */
  chainId: string;
  /** The election key blob as published on chain (ML-KEM-1024 + X25519). */
  electionPublicKey: Uint8Array;
  choice: string;
  /** The voter's EVM address. Must be the account that sends the transaction. */
  voter: Hex;
  /** The voter's ML-DSA-87 secret key. Never leaves the caller. */
  mldsaSecretKey: Uint8Array;
  /** Injectable for tests. Defaults to a CSPRNG. */
  nonce?: Uint8Array;
}

export interface SealedBallot {
  /** The only thing that goes on chain. */
  envelope: Uint8Array;
  envelopeHash: Hex;
  /** What the ML-DSA-87 key signed. Kept for the receipt and for debugging. */
  sigMessage: Hex;
  nonce: Uint8Array;
}

function randomNonce(): Uint8Array {
  const n = new Uint8Array(BALLOT_NONCE_BYTES);
  crypto.getRandomValues(n);
  return n;
}

/** Seal a ballot and sign it, all locally. */
export function castBallot(args: CastBallotArgs): SealedBallot {
  const nonce = args.nonce ?? randomNonce();
  const sigMessage = ballotSigMessage({ ...args, nonce });
  const signature = pqSign(args.mldsaSecretKey, hexToBytes(sigMessage));

  const envelope = seal({
    chainId: args.chainId,
    purpose: BALLOT_PURPOSE,
    // QoreSeal's default hybrid mode: ML-KEM-1024 + X25519, combined through
    // SHA3-256, so breaking X25519 alone gains an attacker nothing.
    mode: 'hybrid',
    recipients: [unpackElectionKey(args.electionPublicKey)],
    plaintext: encodeBallotPlaintext({ choice: args.choice, nonce, signature }),
    aad: ballotAad(args),
  });

  return { envelope, envelopeHash: keccak256(envelope), sigMessage, nonce };
}

/** What a voter keeps to check their ballot later. Carries nothing secret. */
export interface Receipt {
  electionId: bigint;
  voter: Hex;
  ballotId?: bigint;
  envelopeHash: Hex;
}

export function receiptFor(
  ballot: SealedBallot,
  args: CastBallotArgs,
  ballotId?: bigint,
): Receipt {
  return {
    electionId: args.electionId,
    voter: args.voter,
    ballotId,
    envelopeHash: ballot.envelopeHash,
  };
}

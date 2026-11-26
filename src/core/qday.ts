/**
 * The Q-Day simulation: what a quantum adversary gets, and what it does not.
 *
 * The threat model, made concrete: a cryptographically relevant quantum
 * computer recovers classical private keys from public ones. So the attacker is
 * simply HANDED the X25519 private key. That is the whole simulation — no
 * hand-waving about running Shor's algorithm, just the consequence of it.
 *
 * Two ballot boxes over the same ten ballots:
 *
 *   classical  X25519 + ChaCha20-Poly1305, which is how encrypted ballots are
 *              protected today. Given the recovered secret, every ballot opens.
 *   Booth      QoreSeal hybrid: ML-KEM-1024 + X25519 combined through SHA3-256.
 *              The attacker is given the same recovered X25519 secret AND the
 *              ML-KEM public key, which is on chain anyway. It still cannot
 *              derive the shared secret, because the ML-KEM half is missing.
 *
 * Nothing here is theatre: the right-hand column fails because `open()`
 * genuinely refuses, and the error code it returns is shown on screen.
 *
 * @noble/curves and @noble/ciphers appear ONLY here, to model the pre-quantum
 * status quo for comparison. Booth's real ballots never use them directly —
 * those go through QoreSeal.
 */
import { generateSealKeys, open, seal, isQoreSealError, type SealKeyPair } from '@qorechain/qoreseal';
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';

export interface SimVoter {
  name: string;
  choice: string;
}

/** A ballot sealed the way today's systems do it: X25519 only. */
export interface ClassicalBallot {
  /** The sender's throwaway public key, as any ECIES-style scheme publishes. */
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface SimBallot {
  voter: SimVoter;
  classical: ClassicalBallot;
  /** QoreSeal hybrid envelope: ML-KEM-1024 + X25519. */
  postQuantum: Uint8Array;
}

export interface Simulation {
  ballots: SimBallot[];
  /** What the attacker is handed on Q-Day. */
  recovered: {
    /** The classical ballot box's X25519 secret, recovered from its public key. */
    classicalSecret: Uint8Array;
    /** Booth's X25519 secret — the classical half of the hybrid. */
    boothX25519Secret: Uint8Array;
  };
  /** Public material the attacker always had: it is on chain. */
  boothPublic: {
    mlkemPublicKey: Uint8Array;
    x25519PublicKey: Uint8Array;
  };
  /** Kept so the demo can prove the ballots really do open with the right key. */
  boothKeys: SealKeyPair;
}

const CHAIN_ID = 'qorechain-diana';
const PURPOSE = 'booth-qday-demo';

/** Encrypt to an X25519 public key, the pre-quantum way. */
function classicalSeal(recipientPublicKey: Uint8Array, plaintext: Uint8Array): ClassicalBallot {
  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralSecret);
  const key = sha256(x25519.getSharedSecret(ephemeralSecret, recipientPublicKey));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  return {
    ephemeralPublicKey,
    nonce,
    ciphertext: chacha20poly1305(key, nonce).encrypt(plaintext),
  };
}

/**
 * Open a classical ballot with the recovered secret. This is what Q-Day costs:
 * it just works.
 */
export function attackClassical(ballot: ClassicalBallot, recoveredSecret: Uint8Array): string {
  const key = sha256(x25519.getSharedSecret(recoveredSecret, ballot.ephemeralPublicKey));
  const plaintext = chacha20poly1305(key, ballot.nonce).decrypt(ballot.ciphertext);
  return new TextDecoder().decode(plaintext);
}

export interface PqAttackResult {
  opened: false;
  /** QoreSeal's own stable error code, shown on screen as evidence. */
  code: string;
}

/**
 * The attacker's best reconstruction of Booth's key: the recovered X25519
 * secret, the public keys that were on chain all along, and an ML-KEM secret it
 * had to guess. Built ONCE — an ML-KEM-1024 keygen per ballot would make the
 * reveal crawl, and the guess does not need to differ per ballot to be wrong.
 */
export function prepareAttacker(sim: Simulation): SealKeyPair {
  const guessed = generateSealKeys();
  return {
    seed: guessed.seed,
    mlkemPublicKey: sim.boothPublic.mlkemPublicKey,
    mlkemSecretKey: guessed.mlkemSecretKey,
    x25519PublicKey: sim.boothPublic.x25519PublicKey,
    x25519SecretKey: sim.recovered.boothX25519Secret,
  };
}

/**
 * Try the attack on Booth's ballot with everything the adversary plausibly
 * has. The ML-KEM *secret* is the one thing it does not, and the hybrid secret
 * cannot be derived without it.
 *
 * Returns the refusal rather than throwing, because the refusal is the result.
 */
export function attackPostQuantum(
  envelope: Uint8Array,
  attackerKeys: SealKeyPair,
): PqAttackResult | { opened: true; plaintext: string } {
  try {
    const plaintext = open({
      chainId: CHAIN_ID,
      purpose: PURPOSE,
      envelope,
      keys: attackerKeys,
    });
    // Would mean the hybrid construction had failed. Report it honestly.
    return { opened: true, plaintext: new TextDecoder().decode(plaintext) };
  } catch (err) {
    return { opened: false, code: isQoreSealError(err) ? err.code : 'DECRYPTION_FAILED' };
  }
}

/** Open a Booth ballot with the real key, to show the ballots are not junk. */
export function openWithRealKey(envelope: Uint8Array, sim: Simulation): string {
  return new TextDecoder().decode(
    open({ chainId: CHAIN_ID, purpose: PURPOSE, envelope, keys: sim.boothKeys }),
  );
}

/** Seal the same ten ballots both ways. */
export function buildSimulation(voters: readonly SimVoter[]): Simulation {
  // The classical ballot box: one X25519 keypair, as today.
  const classicalSecret = x25519.utils.randomSecretKey();
  const classicalPublic = x25519.getPublicKey(classicalSecret);

  // Booth's ballot box: ML-KEM-1024 + X25519 from one seed.
  const boothKeys = generateSealKeys();

  const ballots = voters.map((voter) => {
    const plaintext = new TextEncoder().encode(`${voter.name} voted ${voter.choice}`);
    return {
      voter,
      classical: classicalSeal(classicalPublic, plaintext),
      postQuantum: seal({
        chainId: CHAIN_ID,
        purpose: PURPOSE,
        mode: 'hybrid',
        recipients: [
          {
            mlkemPublicKey: boothKeys.mlkemPublicKey,
            x25519PublicKey: boothKeys.x25519PublicKey,
          },
        ],
        plaintext,
      }),
    };
  });

  return {
    ballots,
    recovered: {
      classicalSecret,
      boothX25519Secret: boothKeys.x25519SecretKey,
    },
    boothPublic: {
      mlkemPublicKey: boothKeys.mlkemPublicKey,
      x25519PublicKey: boothKeys.x25519PublicKey,
    },
    boothKeys,
  };
}

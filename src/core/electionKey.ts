/**
 * Booth's on-chain election-key blob.
 *
 * QoreSeal's default `hybrid` mode needs both an ML-KEM-1024 key and an X25519
 * key, and `sealKeysFromSeed` derives **both** from the same 32-byte seed. So
 * splitting the seed k-of-n already distributes both secrets, and Booth can use
 * hybrid mode with no extra key management.
 *
 * Layout (Booth's own format, hence the version byte):
 *
 *     byte  0        version = 1
 *     bytes 1..1568  ML-KEM-1024 encapsulation key (1568 bytes)
 *     bytes 1569..1600  X25519 public key (32 bytes)
 *
 * The contract treats this as opaque bytes — it only hashes it — so the layout
 * lives here and nowhere else.
 */
import {
  ML_KEM_1024_PUBLIC_KEY_LENGTH,
  X25519_KEY_LENGTH,
  validateMlkemPublicKey,
  validateX25519PublicKey,
  type SealRecipient,
} from '@qorechain/qoreseal';

export const ELECTION_KEY_VERSION = 1;
export const ELECTION_KEY_BLOB_LENGTH =
  1 + ML_KEM_1024_PUBLIC_KEY_LENGTH + X25519_KEY_LENGTH;

export function packElectionKey(mlkemPublicKey: Uint8Array, x25519PublicKey: Uint8Array): Uint8Array {
  validateMlkemPublicKey(mlkemPublicKey);
  validateX25519PublicKey(x25519PublicKey);

  const blob = new Uint8Array(ELECTION_KEY_BLOB_LENGTH);
  blob[0] = ELECTION_KEY_VERSION;
  blob.set(mlkemPublicKey, 1);
  blob.set(x25519PublicKey, 1 + ML_KEM_1024_PUBLIC_KEY_LENGTH);
  return blob;
}

/** Read an election key blob as a QoreSeal recipient. Throws on anything malformed. */
export function unpackElectionKey(blob: Uint8Array): SealRecipient {
  if (blob.length !== ELECTION_KEY_BLOB_LENGTH) {
    throw new Error(
      `election key blob must be ${ELECTION_KEY_BLOB_LENGTH} bytes, got ${blob.length}`,
    );
  }
  if (blob[0] !== ELECTION_KEY_VERSION) {
    throw new Error(`unsupported election key version ${blob[0]}`);
  }

  const mlkemPublicKey = blob.slice(1, 1 + ML_KEM_1024_PUBLIC_KEY_LENGTH);
  const x25519PublicKey = blob.slice(1 + ML_KEM_1024_PUBLIC_KEY_LENGTH);

  // The chain applies the same ML-KEM checks; fail here rather than on chain.
  validateMlkemPublicKey(mlkemPublicKey);
  validateX25519PublicKey(x25519PublicKey);

  return { mlkemPublicKey, x25519PublicKey };
}

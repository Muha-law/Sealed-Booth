/**
 * A Booth participant's identity: one BIP-39 mnemonic, two key pairs.
 *
 * QoreChain's own model is a unified identity — one secp256k1 key rendered as
 * both `qor1…` and `0x…`, with a canonical ML-DSA-87 key derived alongside it.
 * Booth mirrors that exactly, so a voter's EVM address and their post-quantum
 * identity are provably the same account.
 *
 * Secrets never leave this module in printable form: the returned objects
 * redact themselves under `JSON.stringify` and `console.log`.
 */
import {
  addressFromPublicKey,
  deriveCanonicalPqKey,
  deriveClassicalKey,
} from '@qorechain/qoresign';
import { deriveSealKeys, type SealKeyPair } from '@qorechain/qoreseal';
import type { Hex } from 'viem';
import { toHex } from 'viem';

/** Only ever the EVM lane: one 20-byte identity behind `qor1…` and `0x…`. */
const KEY_TYPE = 'eth_secp256k1' as const;

export interface VoterIdentity {
  /** EIP-55 checksummed `0x…`; what the contract's roll is keyed on. */
  readonly evmAddress: Hex;
  /** The same 20 bytes as `qor1…`, for the native lane and KEM registry. */
  readonly bech32Address: string;
  /** 32-byte secp256k1 secret key. Secret. */
  readonly evmPrivateKey: Hex;
  /** ML-DSA-87 public key, 2592 bytes. */
  readonly mldsaPublicKey: Uint8Array;
  /** ML-DSA-87 secret key. Secret. */
  readonly mldsaSecretKey: Uint8Array;
}

export interface TrusteeIdentity {
  readonly bech32Address: string;
  readonly evmAddress: Hex;
  /** QoreSeal keys: the ML-KEM-1024 pair plus the X25519 pair. Secret halves inside. */
  readonly sealKeys: SealKeyPair;
}

/**
 * Hide secrets from accidental logging. A plain object would leak the whole key
 * through `JSON.stringify` or an unguarded `console.log`; project rule is that
 * secrets are never printed.
 */
function redacting<T extends object>(value: T, publicKeys: (keyof T)[]): T {
  const shown = Object.fromEntries(publicKeys.map((k) => [k, value[k]]));
  return Object.defineProperties(value, {
    toJSON: { value: () => ({ ...shown, redacted: '[secret key material withheld]' }) },
    [Symbol.for('nodejs.util.inspect.custom')]: {
      value: () => ({ ...shown, redacted: '[secret key material withheld]' }),
    },
  }) as T;
}

/** Derive a voter's EVM key and their canonical ML-DSA-87 key from one mnemonic. */
export function voterFromMnemonic(mnemonic: string, index = 0): VoterIdentity {
  const classical = deriveClassicalKey({ mnemonic, type: KEY_TYPE, index });
  const address = addressFromPublicKey(classical.publicKey, KEY_TYPE);
  // The canonical derivation binds the ML-DSA-87 key to this exact account.
  const pq = deriveCanonicalPqKey({ mnemonic, address: address.bech32 });

  return redacting(
    {
      evmAddress: address.hex as Hex,
      bech32Address: address.bech32,
      evmPrivateKey: toHex(classical.privateKey),
      mldsaPublicKey: pq.publicKey,
      mldsaSecretKey: pq.secretKey,
    },
    ['evmAddress', 'bech32Address'],
  );
}

/**
 * Derive a trustee's QoreSeal keys from its own mnemonic.
 *
 * `index` is QoreSeal's rotation index: move to the next one to rotate the
 * trustee's KEM key.
 */
export function trusteeFromMnemonic(mnemonic: string, index = 0): TrusteeIdentity {
  const classical = deriveClassicalKey({ mnemonic, type: KEY_TYPE });
  const address = addressFromPublicKey(classical.publicKey, KEY_TYPE);
  const sealKeys = deriveSealKeys({ mnemonic, index });

  return redacting(
    {
      bech32Address: address.bech32,
      evmAddress: address.hex as Hex,
      sealKeys,
    },
    ['bech32Address', 'evmAddress'],
  );
}

/**
 * Every Booth account, derived one way only.
 *
 * QoreChain has two secp256k1 derivations and they are different accounts:
 *
 *   coin type 60  (`eth_secp256k1`)  -> the unified identity: one 20 bytes
 *                                       rendered as both `qor1…` and `0x…`
 *   coin type 118 (`secp256k1`)      -> a separate, cosmos-style account
 *
 * Booth uses coin type 60 everywhere. Measured proof and the reason this
 * matters (a mis-funded faucet claim costs 24 hours) are in
 * docs/VERIFIED-FACTS.md.
 *
 * Secrets are returned because signing needs them, and are never printed:
 * these objects redact themselves under `JSON.stringify` and `console.log`.
 */
import {
  addressFromPublicKey,
  deriveCanonicalPqKey,
  deriveClassicalKey,
} from '@qorechain/qoresign';
import { deriveSealKeys } from '@qorechain/qoreseal';

const KEY_TYPE = 'eth_secp256k1';

function redacting(value, shownKeys) {
  const shown = Object.fromEntries(shownKeys.map((k) => [k, value[k]]));
  const safe = () => ({ ...shown, redacted: '[secret key material withheld]' });
  return Object.defineProperties(value, {
    toJSON: { value: safe },
    [Symbol.for('nodejs.util.inspect.custom')]: { value: safe },
  });
}

/**
 * The unified account for a mnemonic: bech32 and hex forms of the same 20
 * bytes, the secp256k1 key, and the canonical ML-DSA-87 key bound to it.
 */
export function boothAccount(mnemonic, index = 0) {
  const classical = deriveClassicalKey({ mnemonic, type: KEY_TYPE, index });
  const address = addressFromPublicKey(classical.publicKey, KEY_TYPE);
  const pqKey = deriveCanonicalPqKey({ mnemonic, address: address.bech32 });

  return redacting(
    {
      bech32: address.bech32,
      evm: address.hex,
      addressBytes: address.bytes,
      classicalKey: classical,
      pqKey,
    },
    ['bech32', 'evm'],
  );
}

/** A trustee also holds QoreSeal keys: the ML-KEM-1024 pair plus X25519. */
export function trusteeAccount(mnemonic, sealIndex = 0) {
  const account = boothAccount(mnemonic);
  const sealKeys = deriveSealKeys({ mnemonic, index: sealIndex });

  return redacting(
    { ...account, sealKeys, classicalKey: account.classicalKey, pqKey: account.pqKey },
    ['bech32', 'evm'],
  );
}

export const TRUSTEE_ENV_KEYS = [
  'BOOTH_TRUSTEE_1_MNEMONIC',
  'BOOTH_TRUSTEE_2_MNEMONIC',
  'BOOTH_TRUSTEE_3_MNEMONIC',
];

export const VOTER_ENV_KEYS = [
  'BOOTH_VOTER_1_MNEMONIC',
  'BOOTH_VOTER_2_MNEMONIC',
  'BOOTH_VOTER_3_MNEMONIC',
  'BOOTH_VOTER_4_MNEMONIC',
  'BOOTH_VOTER_5_MNEMONIC',
];

/**
 * Demo invite accounts, all derived from ONE master mnemonic by HD index.
 *
 * Why one master: a window can only be opened by the account that owns it, so
 * the keeper must sign as each invite. Deriving them keeps that to a single
 * GitHub Actions secret instead of thirty.
 *
 * The master itself NEVER reaches the browser. Only individual derived private
 * keys do, for the few invites currently in the live pool, and those are
 * deliberately public single-use demo credentials — see docs/ARCHITECTURE.md.
 */
export const INVITE_COUNT = 30;

export function inviteAccount(masterMnemonic, index) {
  if (!Number.isInteger(index) || index < 0 || index >= INVITE_COUNT) {
    throw new Error(`invite index must be 0..${INVITE_COUNT - 1}, got ${index}`);
  }
  return boothAccount(masterMnemonic, index);
}

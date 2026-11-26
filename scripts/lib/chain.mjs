/**
 * Sending native-lane transactions as a unified eth-native account.
 *
 * Two things here are not obvious and both are documented in the kits:
 *
 *  1. The bootstrap. The chain requires hybrid signatures and allows no
 *     classical fallback, yet a fresh account has no ML-DSA-87 key to sign
 *     with. The way out is that `MsgRegisterPQCKeyV2` — and only that message —
 *     is signed `classical`-only. So `sendNative(..., { bootstrap: true })`.
 *
 *  2. Account reads. cosmjs's default account parser rejects an
 *     `eth_secp256k1` pubkey, so account number and sequence are read straight
 *     from REST rather than through StargateClient.
 */
import { StargateClient } from '@cosmjs/stargate';
import {
  EthNativeSigner,
  deriveUnifiedAccount,
  qorechainRegistry,
  recommendedGasPriceUqor,
} from '@qorechain/sdk';
import { NETWORK } from './env.mjs';

const registry = qorechainRegistry();

/**
 * QoreSign and QoreSeal build messages as a protobuf `Any` (pre-encoded bytes);
 * EthNativeSigner wants a cosmjs `EncodeObject` (a message object the registry
 * encodes). Decode through the registry so the KIT still defines the message
 * content and nothing here hand-assembles protobuf fields.
 */
export function anyToEncodeObject(any) {
  return { typeUrl: any.typeUrl, value: registry.lookupType(any.typeUrl).decode(any.value) };
}

let transportPromise;

/** One shared broadcaster. The SDK documents a connected StargateClient here. */
export function transport() {
  transportPromise ??= StargateClient.connect(NETWORK.rpc);
  return transportPromise;
}

/** Account number and sequence, read over REST so eth_secp256k1 pubkeys parse. */
export async function accountAuth(bech32) {
  const res = await fetch(`${NETWORK.rest}/cosmos/auth/v1beta1/accounts/${bech32}`);
  if (res.status === 404) {
    throw new Error(
      `account ${bech32} does not exist on chain yet — it has never received funds`,
    );
  }
  if (!res.ok) throw new Error(`account query failed: ${res.status} ${await res.text()}`);

  const json = await res.json();
  // A BaseAccount may be wrapped (vesting, module accounts); walk to it.
  const base = json.account?.base_account ?? json.account ?? {};
  const accountNumber = base.account_number ?? json.account?.account_number;
  const sequence = base.sequence ?? json.account?.sequence;

  if (accountNumber === undefined) {
    throw new Error(`could not read account_number for ${bech32}: ${JSON.stringify(json)}`);
  }
  return { accountNumber: BigInt(accountNumber), sequence: BigInt(sequence ?? 0) };
}

let cachedGasPrice;

/** A gas price with headroom over the chain minimum, as the SDK recommends. */
async function gasPriceUqor() {
  cachedGasPrice ??= await recommendedGasPriceUqor({ rest: NETWORK.rest });
  return cachedGasPrice;
}

/** StdFee for a gas limit, priced off the live chain minimum and rounded up. */
export async function feeFor(gas) {
  const price = await gasPriceUqor();
  // price is an exact decimal string in uqor per gas; multiply without floats.
  const [whole, frac = ''] = String(price).split('.');
  const scale = 10n ** BigInt(frac.length);
  const scaled = BigInt(whole + frac);
  const amount = (BigInt(gas) * scaled + scale - 1n) / scale; // ceil
  return { amount: [{ denom: 'uqor', amount: amount.toString() }], gas: String(gas) };
}

/**
 * `index` is the HD account index on m/44'/60'/0'/0/{index}. It must agree with
 * `boothAccount(mnemonic, index)` in accounts.mjs, which derives the same path
 * through QoreSign; a test asserts they match.
 */
export async function unifiedAccount(mnemonic, index = 0) {
  // deriveUnifiedAccount takes a bare index, not a DerivationOptions object.
  return deriveUnifiedAccount(mnemonic, index);
}

/**
 * `deriveUnifiedAccount` returns `publicKey` as a `0x…` hex STRING, while the
 * QoreSign builders want the raw 33 compressed bytes. Converting here keeps
 * that surprise in one place.
 */
export function classicalPublicKeyBytes(unified) {
  const hex = unified.publicKey;
  if (hex instanceof Uint8Array) return hex;
  if (typeof hex !== 'string') {
    throw new Error(`unexpected publicKey type on unified account: ${typeof hex}`);
  }
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = Uint8Array.from(body.match(/../g).map((b) => parseInt(b, 16)));
  if (bytes.length !== 33) {
    throw new Error(`expected a 33-byte compressed secp256k1 key, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Sign and broadcast native-lane messages. Throws with the chain's own error
 * text on a non-zero code — never swallows a failure.
 *
 * @param {object} opts
 * @param {boolean} [opts.bootstrap] Sign classical-only. Valid solely for the
 *   first `MsgRegisterPQCKeyV2` of an account that has no ML-DSA-87 key yet.
 */
export async function sendNative(account, messages, opts = {}) {
  const { bootstrap = false, gas = 400_000, memo = '' } = opts;

  const signer = new EthNativeSigner(account, {
    rest: NETWORK.rest,
    signMode: bootstrap ? 'classical' : 'hybrid',
  });

  const { accountNumber, sequence } = await accountAuth(account.cosmos);
  const fee = await feeFor(gas);

  const result = await signer.signAndBroadcast(await transport(), {
    chainId: NETWORK.chainId,
    messages,
    fee,
    memo,
    accountNumber,
    sequence,
  });

  if (result.code !== 0) {
    throw new Error(
      `transaction failed with code ${result.code}\n` +
        `  tx:  ${result.transactionHash}\n` +
        `  log: ${result.rawLog ?? '(no log)'}`,
    );
  }
  return result;
}

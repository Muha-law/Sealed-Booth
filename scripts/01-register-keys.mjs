/**
 * Step 1: get the relayer and the three trustees onto the chain.
 *
 *   relayer  : register its ML-DSA-87 key, then fund the trustees
 *   trustee n: register its ML-DSA-87 key, then publish its ML-KEM-1024 key
 *              in the QoreSeal KEM registry, then sign a recipient card that
 *              binds the ML-KEM key to that ML-DSA-87 identity
 *
 * Idempotent: every step checks the chain first, so re-running after a failure
 * resumes instead of paying twice.
 *
 *   node scripts/01-register-keys.mjs
 */
import { writeFileSync } from 'node:fs';
import { buildRegisterPqKeyMessage, fromBase64 } from '@qorechain/qoresign';
import { fetchPqcStatus, msg } from '@qorechain/sdk';
import { fetchKemKey } from '@qorechain/qoreseal/network';
import {
  ALGORITHM_ML_KEM_1024,
  signRecipientCard,
  verifyRecipientCard,
} from '@qorechain/qoreseal';
import { loadEnv, NETWORK, formatQor, requireEnv } from './lib/env.mjs';
import { trusteeAccount, TRUSTEE_ENV_KEYS } from './lib/accounts.mjs';
import {
  sendNative,
  unifiedAccount,
  anyToEncodeObject,
  classicalPublicKeyBytes,
} from './lib/chain.mjs';
import { recordProof } from './lib/proof.mjs';

const env = loadEnv();
const relayerMnemonic = requireEnv(env, 'BOOTH_RELAYER_MNEMONIC');

/** Enough for a PQC registration (4.6 KB signature) plus a KEM registration. */
const TRUSTEE_FUNDING_UQOR = 3_000_000n; // 3 QOR

async function balanceUqor(bech32) {
  const res = await fetch(`${NETWORK.rest}/cosmos/bank/v1beta1/balances/${bech32}`);
  if (!res.ok) throw new Error(`balance query failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return BigInt((json.balances ?? []).find((b) => b.denom === 'uqor')?.amount ?? 0);
}

async function pqcRegistered(bech32) {
  const status = await fetchPqcStatus({ rest: NETWORK.rest, address: bech32 });
  return Boolean(status.registered ?? status.found);
}

/**
 * Register an account's ML-DSA-87 key. The message carries a proof of
 * possession and the compressed secp256k1 key the chain checks against the
 * address; the transaction itself is signed CLASSICAL-only, because the account
 * has no registered PQ key yet and the chain allows no classical fallback for
 * anything else.
 */
async function registerPqcKey(label, mnemonic) {
  const unified = await unifiedAccount(mnemonic);

  if (await pqcRegistered(unified.cosmos)) {
    console.log(`  ${label}: ML-DSA-87 key already registered, skipping`);
    return null;
  }

  const message = buildRegisterPqKeyMessage({
    chainId: NETWORK.chainId,
    account: unified.cosmos,
    pqKey: unified.pqc,
    classicalPublicKey: classicalPublicKeyBytes(unified),
  });

  console.log(`  ${label}: registering ML-DSA-87 key…`);
  const result = await sendNative(unified, [anyToEncodeObject(message)], {
    bootstrap: true,
    gas: 900_000, // a 4627-byte proof of possession is not a cheap message
    memo: 'booth: register ML-DSA-87 identity',
  });

  recordProof({
    proves: `${label} ML-DSA-87 identity key registered on chain (with proof of possession)`,
    txHash: result.transactionHash,
    gasUsed: result.gasUsed,
    lane: 'native',
  });
  return result;
}

/** Publish a trustee's ML-KEM-1024 key in the KEM registry. Needs the hybrid signature. */
async function registerKemKey(label, trustee, unified) {
  const existing = await fetchKemKey({ rest: NETWORK.rest, address: unified.cosmos });
  if (existing.registered) {
    console.log(`  ${label}: ML-KEM key already registered (alg ${existing.algorithmId}), skipping`);
    return null;
  }

  console.log(`  ${label}: registering ML-KEM-1024 key (${trustee.sealKeys.mlkemPublicKey.length} bytes)…`);
  const result = await sendNative(
    unified,
    [
      msg.pqc.registerKemKey({
        sender: unified.cosmos,
        algorithmId: ALGORITHM_ML_KEM_1024,
        publicKey: trustee.sealKeys.mlkemPublicKey,
      }),
    ],
    { gas: 900_000, memo: 'booth: publish ML-KEM-1024 recipient key' },
  );

  recordProof({
    proves: `${label} ML-KEM-1024 encryption key published in the QoreSeal KEM registry (algorithm id ${ALGORITHM_ML_KEM_1024})`,
    txHash: result.transactionHash,
    gasUsed: result.gasUsed,
    lane: 'native',
  });
  return result;
}

// ---------------------------------------------------------------- run

console.log(`network ${NETWORK.chainId}\n`);

const relayer = await unifiedAccount(relayerMnemonic);
const relayerBalance = await balanceUqor(relayer.cosmos);
console.log(`relayer ${relayer.cosmos}  ${formatQor(relayerBalance)}`);
if (relayerBalance === 0n) {
  console.error(`\nrelayer has no QOR. Fund it at ${NETWORK.faucet}`);
  process.exit(2);
}

console.log('\n--- relayer identity ---');
await registerPqcKey('relayer', relayerMnemonic);

console.log('\n--- funding trustees ---');
const trustees = TRUSTEE_ENV_KEYS.map((key, i) => ({
  label: `trustee ${i + 1}`,
  mnemonic: requireEnv(env, key),
  index: i,
}));

for (const t of trustees) {
  const account = trusteeAccount(t.mnemonic);
  const have = await balanceUqor(account.bech32);
  if (have >= TRUSTEE_FUNDING_UQOR) {
    console.log(`  ${t.label}: already holds ${formatQor(have)}, skipping`);
    continue;
  }
  const amount = (TRUSTEE_FUNDING_UQOR - have).toString();
  console.log(`  ${t.label}: sending ${formatQor(amount)} to ${account.bech32}…`);
  const result = await sendNative(
    relayer,
    [
      msg.bank.send({
        fromAddress: relayer.cosmos,
        toAddress: account.bech32,
        amount: [{ denom: 'uqor', amount }],
      }),
    ],
    { gas: 250_000, memo: 'booth: fund trustee' },
  );
  recordProof({
    proves: `relayer funded ${t.label} (${formatQor(amount)}) so the trustee can register its own keys`,
    txHash: result.transactionHash,
    gasUsed: result.gasUsed,
    lane: 'native',
  });
}

console.log('\n--- trustee identities and KEM keys ---');
const cards = [];
for (const t of trustees) {
  const trustee = trusteeAccount(t.mnemonic);
  const unified = await unifiedAccount(t.mnemonic);

  await registerPqcKey(t.label, t.mnemonic);
  await registerKemKey(t.label, trustee, unified);

  // The recipient card binds the X25519 key and the SHA3-256 of the registered
  // ML-KEM key to this account, signed with its classical AND ML-DSA-87 keys.
  // This is the kit's own ML-DSA key-binding mechanism — nothing bespoke.
  const card = signRecipientCard({
    chainId: NETWORK.chainId,
    address: unified.cosmos,
    keys: trustee.sealKeys,
    classicalKey: trustee.classicalKey,
    pqKey: unified.pqc,
  });

  // Verify it the way a voter's browser will: against the keys ON CHAIN.
  const kem = await fetchKemKey({ rest: NETWORK.rest, address: unified.cosmos });
  // fetchPqcStatus reports the key as `pubkey`, base64-encoded.
  const pqStatus = await fetchPqcStatus({ rest: NETWORK.rest, address: unified.cosmos });
  const encoded = pqStatus.pubkey ?? pqStatus.publicKey;
  if (!encoded) {
    throw new Error(
      `could not read ${t.label}'s on-chain ML-DSA-87 key; status fields: ` +
        Object.keys(pqStatus).join(', '),
    );
  }
  const pqPublicKey = encoded instanceof Uint8Array ? encoded : fromBase64(encoded);

  const recipient = verifyRecipientCard({
    card,
    chainId: NETWORK.chainId,
    pqPublicKey,
    mlkemPublicKey: kem.publicKey,
  });
  console.log(
    `  ${t.label}: recipient card verified against on-chain keys ` +
      `(ML-KEM ${recipient.mlkemPublicKey.length} B, X25519 ${recipient.x25519PublicKey.length} B)`,
  );

  cards.push({ index: t.index, address: unified.cosmos, card });
}

writeFileSync('build/trustee-cards.json', JSON.stringify(cards, null, 2) + '\n', 'utf8');
console.log('\nWrote build/trustee-cards.json (public material only).');
console.log('Next: node scripts/02-deploy.mjs');

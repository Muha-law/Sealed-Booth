/**
 * Pre-provision the demo invite pool, and open the demo election.
 *
 *   npx tsx scripts/12-provision-invites.ts
 *
 * One-time setup. For each of the 30 invites: fund it thinly and register its
 * ML-DSA-87 key (permanent, so this never needs repeating). Then create the
 * demo election, open until 20 Dec, with all 30 on the allowlist.
 *
 * Secrets: the invites MASTER mnemonic is generated here if absent and written
 * to a file OUTSIDE the repo. It is never printed, never committed. Only the
 * path is shown.
 *
 * Invites are funded thinly on purpose. Their private keys are published to the
 * Vote page for the live pool, so they are public by design — each is good for
 * exactly one ballot, and holds only a few cents of worthless testnet QOR.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toHex, type Abi, type Hex } from 'viem';
import { generateMnemonic, fetchPqcStatus, msg } from '@qorechain/sdk';
import { fetchKemKey } from '@qorechain/qoreseal/network';
import { verifyRecipientCard } from '@qorechain/qoreseal';
import { buildRegisterPqKeyMessage, fromBase64 } from '@qorechain/qoresign';

// @ts-expect-error - .mjs helper
import { loadEnv, NETWORK, requireEnv, formatQor } from './lib/env.mjs';
// @ts-expect-error - .mjs helper
import { trusteeAccount, inviteAccount, INVITE_COUNT, TRUSTEE_ENV_KEYS } from './lib/accounts.mjs';
// @ts-expect-error - .mjs helper
import { sendNative, unifiedAccount, anyToEncodeObject, classicalPublicKeyBytes } from './lib/chain.mjs';
// @ts-expect-error - .mjs helper, no type declarations
import { ensureWindow, publicClient, walletClient, maxFeePerGas } from './lib/evm.mjs';
// @ts-expect-error - .mjs helper
import { recordProof } from './lib/proof.mjs';
import { setUpElection } from '../src/core/election.js';

const SECRETS_DIR = join(homedir(), 'booth-secrets');
const MASTER_FILE = join(SECRETS_DIR, 'invites.txt');

/** Demo election stays open until 20 Dec 2026 23:59 UTC. */
const DEMO_CLOSE_AT = BigInt(Math.floor(Date.UTC(2026, 11, 20, 23, 59, 0) / 1000));
const DEMO_QUESTION = 'Booth demo: which animal guards the ballot box?';
const DEMO_OPTIONS = ['hedgehog', 'badger', 'otter'];
const THRESHOLD = 2;
/** Enough for one PQC registration plus a little slack. The keeper tops up. */
const INVITE_FUNDING_UQOR = 120_000n;

const env = loadEnv();
const CONTRACT = requireEnv(env, 'ELECTION_CONTRACT_ADDRESS') as Hex;
const abi = JSON.parse(readFileSync('out/Election.sol/Election.json', 'utf8')).abi as Abi;
const client = publicClient();
const relayer = await unifiedAccount(requireEnv(env, 'BOOTH_RELAYER_MNEMONIC'));
const fee = await maxFeePerGas(client);

// ---------------------------------------------- the invites master mnemonic

let master: string | undefined = env.BOOTH_INVITES_MNEMONIC;
if (!master) {
  master = generateMnemonic();
  mkdirSync(SECRETS_DIR, { recursive: true });
  writeFileSync(
    MASTER_FILE,
    [
      'BOOTH_INVITES_MNEMONIC',
      '',
      master,
      '',
      'Add this as a GitHub Actions secret named BOOTH_INVITES_MNEMONIC',
      '(repo Settings > Secrets and variables > Actions > New repository secret),',
      'then delete this file.',
      '',
      'It derives all 30 demo invite accounts. It must never reach the browser',
      'or the repository: only individual derived keys for the live pool do.',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  try {
    chmodSync(MASTER_FILE, 0o600);
  } catch {
    /* best effort on Windows */
  }
  // Also store it locally so the keeper and scripts can run from this machine.
  const dotenv = readFileSync('.env', 'utf8');
  writeFileSync(
    '.env',
    dotenv.includes('BOOTH_INVITES_MNEMONIC=')
      ? dotenv.replace(/^BOOTH_INVITES_MNEMONIC=.*$/m, `BOOTH_INVITES_MNEMONIC=${master}`)
      : `${dotenv.trimEnd()}\nBOOTH_INVITES_MNEMONIC=${master}\n`,
    'utf8',
  );
  console.log('Generated the invites master mnemonic.');
  console.log(`  written to: ${MASTER_FILE}`);
  console.log('  (not printed here, and not committed — copy it into GitHub, then delete the file)');
} else {
  console.log('Using the existing BOOTH_INVITES_MNEMONIC.');
}
console.log('');

async function balanceUqor(bech32: string) {
  const res = await fetch(`${NETWORK.rest}/cosmos/bank/v1beta1/balances/${bech32}`);
  const j = await res.json();
  return BigInt((j.balances ?? []).find((b: { denom: string }) => b.denom === 'uqor')?.amount ?? 0);
}

const relayerBalance = await balanceUqor(relayer.cosmos);
console.log(`relayer ${relayer.cosmos}  ${formatQor(relayerBalance)}`);
const needed = BigInt(INVITE_COUNT) * (INVITE_FUNDING_UQOR + 33_000n) + 500_000n;
if (relayerBalance < needed) {
  console.error(`\nNot enough QOR: need about ${formatQor(needed)} to provision ${INVITE_COUNT} invites.`);
  console.error(`Claim more at ${NETWORK.faucet} and re-run. This script is idempotent.`);
  process.exit(2);
}

// ------------------------------------------------- fund and register invites

console.log(`\n--- provisioning ${INVITE_COUNT} invites ---`);
const invites = [];
let funded = 0;
let registered = 0;

for (let i = 0; i < INVITE_COUNT; i++) {
  const acct = inviteAccount(master, i);
  const uni = await unifiedAccount(master, i);

  const have = await balanceUqor(acct.bech32);
  if (have < INVITE_FUNDING_UQOR) {
    const amount = (INVITE_FUNDING_UQOR - have).toString();
    await sendNative(
      relayer,
      [
        msg.bank.send({
          fromAddress: relayer.cosmos,
          toAddress: acct.bech32,
          amount: [{ denom: 'uqor', amount }],
        }),
      ],
      { gas: 220_000, memo: `booth: fund demo invite ${i}` },
    );
    funded++;
  }

  const pqc = (await fetchPqcStatus({ rest: NETWORK.rest, address: acct.bech32 })) as {
    registered?: boolean;
    found?: boolean;
  };
  if (!(pqc.registered ?? pqc.found)) {
    await sendNative(
      uni,
      [
        anyToEncodeObject(
          buildRegisterPqKeyMessage({
            chainId: NETWORK.chainId,
            account: uni.cosmos,
            pqKey: uni.pqc,
            classicalPublicKey: classicalPublicKeyBytes(uni),
          }),
        ),
      ],
      { bootstrap: true, gas: 320_000, memo: `booth: invite ${i} ML-DSA-87 identity` },
    );
    registered++;
  }

  invites.push({ index: i, address: acct.evm as Hex });
  if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${INVITE_COUNT} ready`);
}
console.log(`  funded ${funded}, registered ${registered} ML-DSA-87 keys (both are one-time)`);

// ------------------------------------------------------ open the demo election

const existing = env.BOOTH_DEMO_ELECTION_ID;
if (existing) {
  const e = (await client.readContract({
    address: CONTRACT,
    abi,
    functionName: 'getElection',
    args: [BigInt(existing)],
  })) as { closeAt: bigint; voterCount: number };
  console.log(`\nDemo election ${existing} already exists (closes ${e.closeAt}, ${e.voterCount} voters).`);
  console.log('Nothing more to do.');
  process.exit(0);
}

console.log('\n--- trustee recipient keys ---');
const cards = JSON.parse(readFileSync('build/trustee-cards.json', 'utf8')) as {
  address: string;
  card: Parameters<typeof verifyRecipientCard>[0]['card'];
}[];
const trustees = [];
for (const key of TRUSTEE_ENV_KEYS) {
  const local = trusteeAccount(requireEnv(env, key));
  const uni = await unifiedAccount(requireEnv(env, key));
  const kem = await fetchKemKey({ rest: NETWORK.rest, address: local.bech32 });
  const status = (await fetchPqcStatus({ rest: NETWORK.rest, address: local.bech32 })) as {
    pubkey: string;
  };
  const recipient = verifyRecipientCard({
    card: cards.find((c) => c.address === local.bech32)!.card,
    chainId: NETWORK.chainId,
    pqPublicKey: fromBase64(status.pubkey),
    mlkemPublicKey: kem.publicKey!,
  });
  trustees.push({ evm: uni.evm as Hex, recipient, keyRef: keccak256(kem.publicKey!) });
}
console.log(`  ${trustees.length} trustees verified`);

console.log('\n--- creating the demo election ---');
await ensureWindow(relayer, { txs: 4, gasEach: 1_000_000, blocks: 17_280 });

const setup = await setUpElection({
  chainId: NETWORK.chainId,
  trustees: trustees.map((t) => t.recipient),
  threshold: THRESHOLD,
});
const head = await client.getBlock();

const args = [
  DEMO_QUESTION,
  DEMO_OPTIONS,
  BigInt(head.timestamp),
  DEMO_CLOSE_AT,
  THRESHOLD,
  invites.map((i) => i.address),
  trustees.map((t) => t.evm),
  trustees.map((t) => t.keyRef),
  toHex(setup.electionPublicKey),
  setup.shareCommitments,
  setup.sealedShares.map((s: Uint8Array) => toHex(s)),
] as const;

const estimate = await client.estimateContractGas({
  address: CONTRACT,
  abi,
  functionName: 'createElection',
  args,
  account: relayer.evm,
});
const hash = await walletClient(relayer.privateKey).writeContract({
  address: CONTRACT,
  abi,
  functionName: 'createElection',
  args,
  gas: (estimate * 112n) / 100n,
  maxFeePerGas: fee,
  maxPriorityFeePerGas: 0n,
});
const receipt = await client.waitForTransactionReceipt({ hash, timeout: 240_000 });
if (receipt.status !== 'success') throw new Error(`createElection reverted: ${hash}`);

const electionId = (await client.readContract({
  address: CONTRACT,
  abi,
  functionName: 'electionCount',
})) as bigint;

console.log(`  demo election ${electionId}, open until ${new Date(Number(DEMO_CLOSE_AT) * 1000).toISOString()}`);
console.log(`  ${invites.length} invites on the allowlist, ${THRESHOLD} of ${trustees.length} trustees`);

recordProof({
  proves:
    `demo election ${electionId} opened on Election.sol until 20 Dec 2026, with ${invites.length} pre-provisioned ` +
    `single-use invite voters on the allowlist, so a judge can cast a real ML-KEM-1024 sealed ballot in the browser ` +
    `without obtaining testnet QOR`,
  txHash: hash,
  gasUsed: receipt.gasUsed,
  lane: 'evm',
});

const dotenv = readFileSync('.env', 'utf8');
writeFileSync(
  '.env',
  dotenv.includes('BOOTH_DEMO_ELECTION_ID=')
    ? dotenv.replace(/^BOOTH_DEMO_ELECTION_ID=.*$/m, `BOOTH_DEMO_ELECTION_ID=${electionId}`)
    : `${dotenv.trimEnd()}\nBOOTH_DEMO_ELECTION_ID=${electionId}\n`,
  'utf8',
);
console.log('\nWrote BOOTH_DEMO_ELECTION_ID to .env');
if (!env.BOOTH_INVITES_MNEMONIC) {
  console.log(`\nREMINDER: copy the master from ${MASTER_FILE} into GitHub, then delete it.`);
}

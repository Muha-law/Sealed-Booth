/**
 * The demo keeper. Runs on GitHub Actions every 4 hours.
 *
 *   node scripts/keeper.mjs            # keep the pool alive, write pool.json
 *   node scripts/keeper.mjs --dry-run  # read-only: report, send nothing
 *
 * Why it has to exist: an EVM authorisation window on this chain lasts at most
 * 17,280 blocks, which at the measured 1.427 s/block is 6 h 51 m. Judging runs
 * 6-15 Dec. So windows must be reopened continuously or nobody can vote.
 *
 * What it does, idempotently:
 *   - finds invites that are allowlisted and have NOT voted
 *   - keeps POOL_TARGET of them with a live window and enough balance
 *   - when unvoted invites run short, provisions the next HD indices (fund,
 *     register their ML-DSA-87 key) and adds them with addVoters
 *   - writes public/pool.json for the Vote page: only the pool's keys
 *   - fails loudly, with a non-zero exit, when the relayer runs low
 *
 * Secrets: reads two mnemonics from the environment and NEVER prints either,
 * nor any derived private key. Addresses and counts only. The run log is public.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, toHex } from 'viem';
import { evmWindowStatus, evmWindowCost } from '@qorechain/evm/window';
import { qorechainTestnet } from '@qorechain/evm';
import { fetchPqcStatus, msg } from '@qorechain/sdk';
import { buildRegisterPqKeyMessage } from '@qorechain/qoresign';
import { decodeEventLog, keccak256 } from 'viem';
import { loadEnv, NETWORK, formatQor } from './lib/env.mjs';
import { inviteAccount, INVITE_MAX } from './lib/accounts.mjs';
import { walletClient, maxFeePerGas } from './lib/evm.mjs';
import { sendNative, unifiedAccount, anyToEncodeObject, classicalPublicKeyBytes } from './lib/chain.mjs';
import ELECTION_ABI from '../src/abi/Election.json' with { type: 'json' };

const DRY_RUN = process.argv.includes('--dry-run');

/** How many invites should be ready to vote at any moment. */
const POOL_TARGET = 8;
/** Open windows for this many blocks. The chain's maximum. */
const WINDOW_BLOCKS = 17_280;
/** Each pool member should be able to send this many EVM transactions. */
const WINDOW_TXS = 3;
/** Gas a ballot might use, for sizing the window's value cap. */
const WINDOW_GAS_EACH = 400_000n;
/**
 * Top a pool member up to this when it falls below MIN_BALANCE.
 *
 * Measured: a v2 ballot costs 0.041915 QOR at its gas limit (6,500 bytes of
 * calldata, 277,220 gas, where the EIP-7623 floor is the binding constraint)
 * and opening a window costs 0.045. So 0.0869 per use, and 0.35 gives a 4x
 * margin. Exposure is bounded: these keys are published, so only the 8 pool
 * members hold this much at a time.
 */
const TOPUP_TO_UQOR = 350_000n;
const MIN_BALANCE_UQOR = 150_000n;
/** Shout if the relayer falls below this. */
const RELAYER_FLOOR_UQOR = 3_000_000n;

const env = loadEnv();
const required = ['BOOTH_RELAYER_MNEMONIC', 'BOOTH_INVITES_MNEMONIC', 'ELECTION_CONTRACT_ADDRESS', 'BOOTH_DEMO_ELECTION_ID', 'BOOTH_DEMO_ELECTION_TX'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`keeper: missing configuration: ${missing.join(', ')}`);
  console.error('In GitHub Actions these come from repository secrets and workflow env.');
  process.exit(1);
}

const CONTRACT = env.ELECTION_CONTRACT_ADDRESS;
const ELECTION_ID = BigInt(env.BOOTH_DEMO_ELECTION_ID);
const ELECTION_TX = env.BOOTH_DEMO_ELECTION_TX;
const master = env.BOOTH_INVITES_MNEMONIC;

const client = createPublicClient({ chain: qorechainTestnet, transport: http(NETWORK.evmRpc) });
const read = (functionName, args = []) =>
  client.readContract({ address: CONTRACT, abi: ELECTION_ABI, functionName, args });

async function balanceUqor(bech32) {
  const res = await fetch(`${NETWORK.rest}/cosmos/bank/v1beta1/balances/${bech32}`);
  if (!res.ok) throw new Error(`balance query failed: ${res.status}`);
  const json = await res.json();
  return BigInt((json.balances ?? []).find((b) => b.denom === 'uqor')?.amount ?? 0);
}

const relayer = await unifiedAccount(env.BOOTH_RELAYER_MNEMONIC);
const head = await client.getBlockNumber();
const election = await read('getElection', [ELECTION_ID]);
const open = await read('isOpen', [ELECTION_ID]);

console.log(`keeper: contract ${CONTRACT} election ${ELECTION_ID}`);
console.log(`  block ${head}, election open: ${open}, closeAt ${election.closeAt}`);
console.log(`  allowlisted ${election.voterCount}, ballots cast ${election.ballotCount}`);

if (!open) {
  console.log('keeper: the demo election has closed. Nothing to keep alive.');
  process.exit(0);
}

const relayerBalance = await balanceUqor(relayer.cosmos);
console.log(`  relayer ${relayer.cosmos} holds ${formatQor(relayerBalance)}`);
if (relayerBalance < RELAYER_FLOOR_UQOR) {
  console.error('');
  console.error('='.repeat(70));
  console.error(`KEEPER IS OUT OF FUNDS: the relayer holds ${formatQor(relayerBalance)},`);
  console.error(`below the ${formatQor(RELAYER_FLOOR_UQOR)} floor. Demo voting will stop.`);
  console.error(`Claim testnet QOR at ${NETWORK.faucet} for:`);
  console.error(`  ${relayer.cosmos}`);
  console.error('='.repeat(70));
  process.exit(1);
}

// ------------------------------------------------- find who can still vote

const candidates = [];
let scanned = 0;
for (let i = 0; i < INVITE_MAX && candidates.length < POOL_TARGET; i++) {
  const acct = inviteAccount(master, i);
  scanned = i + 1;
  const [allowlisted, voted] = await Promise.all([
    read('isVoter', [ELECTION_ID, acct.evm]),
    read('hasVoted', [ELECTION_ID, acct.evm]),
  ]);
  if (!allowlisted) break; // indices are allowlisted in order; the first gap is the frontier
  if (voted) continue;
  candidates.push({ index: i, acct });
}
console.log(`  scanned ${scanned} invites, ${candidates.length} unvoted and allowlisted`);

// ----------------------------------- top the allowlist up when running short

if (candidates.length < POOL_TARGET) {
  const wanted = POOL_TARGET - candidates.length;
  console.log(`  only ${candidates.length} left — provisioning ${wanted} more`);

  const fresh = [];
  let next = scanned;
  while (fresh.length < wanted && next < INVITE_MAX) {
    const acct = inviteAccount(master, next);
    if (!(await read('isVoter', [ELECTION_ID, acct.evm]))) fresh.push({ index: next, acct });
    next++;
  }

  if (!fresh.length) {
    console.error(`keeper: invite indices exhausted at INVITE_MAX=${INVITE_MAX}; raise it to add more.`);
  }

  for (const { index, acct } of fresh) {
    if (DRY_RUN) {
      console.log(`    [dry-run] would provision invite ${index} ${acct.evm}`);
      continue;
    }
    const uni = await unifiedAccount(master, index);
    const have = await balanceUqor(acct.bech32);
    if (have < MIN_BALANCE_UQOR) {
      await sendNative(
        relayer,
        [
          msg.bank.send({
            fromAddress: relayer.cosmos,
            toAddress: acct.bech32,
            amount: [{ denom: 'uqor', amount: (TOPUP_TO_UQOR - have).toString() }],
          }),
        ],
        { gas: 220_000, memo: `booth: fund demo invite ${index}` },
      );
    }
    const pqc = await fetchPqcStatus({ rest: NETWORK.rest, address: acct.bech32 });
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
        { bootstrap: true, gas: 320_000, memo: `booth: invite ${index} ML-DSA-87 identity` },
      );
    }
    console.log(`    provisioned invite ${index} ${acct.evm}`);
  }

  if (fresh.length && !DRY_RUN) {
    // addVoters: admin only, while the election is open. Idempotent per address.
    const fee = await maxFeePerGas(client);
    const addresses = fresh.map((f) => f.acct.evm);
    const estimate = await client.estimateContractGas({
      address: CONTRACT,
      abi: ELECTION_ABI,
      functionName: 'addVoters',
      args: [ELECTION_ID, addresses],
      account: relayer.evm,
    });
    const hash = await walletClient(relayer.privateKey).writeContract({
      address: CONTRACT,
      abi: ELECTION_ABI,
      functionName: 'addVoters',
      args: [ELECTION_ID, addresses],
      gas: (estimate * 112n) / 100n,
      maxFeePerGas: fee,
      maxPriorityFeePerGas: 0n,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 240_000 });
    if (receipt.status !== 'success') throw new Error(`addVoters reverted: ${hash}`);
    console.log(`    addVoters: ${addresses.length} added, tx ${hash}`);
    candidates.push(...fresh);
  }
}

// -------------------------------------- keep each pool member able to vote

const pool = candidates.slice(0, POOL_TARGET);
const fee = DRY_RUN ? 0n : await maxFeePerGas(client);
const perTx = DRY_RUN ? 0n : evmWindowCost({ gas: WINDOW_GAS_EACH, maxFeePerGas: fee });
const windowValue = perTx * BigInt(WINDOW_TXS);

const entries = [];
let opened = 0;
let toppedUp = 0;

for (const { index, acct } of pool) {
  const balance = await balanceUqor(acct.bech32);
  let status = await evmWindowStatus({ rest: NETWORK.rest, address: acct.bech32 });

  if (balance < MIN_BALANCE_UQOR && !DRY_RUN) {
    await sendNative(
      relayer,
      [
        msg.bank.send({
          fromAddress: relayer.cosmos,
          toAddress: acct.bech32,
          amount: [{ denom: 'uqor', amount: (TOPUP_TO_UQOR - balance).toString() }],
        }),
      ],
      { gas: 220_000, memo: `booth: top up demo invite ${index}` },
    );
    toppedUp++;
  }

  // Only `live` is safe to test: an expired window still reports txs and value.
  const needsWindow =
    !status.live ||
    BigInt(status.remainingTxs) < 1n ||
    BigInt(status.remainingValue) < perTx;

  if (needsWindow && !DRY_RUN) {
    const uni = await unifiedAccount(master, index);
    await sendNative(
      uni,
      [
        msg.pqc.openEvmWindow({
          sender: uni.cosmos,
          blocks: String(WINDOW_BLOCKS),
          maxTxs: String(WINDOW_TXS),
          maxValue: windowValue.toString(),
        }),
      ],
      { gas: 300_000, memo: `booth: window for demo invite ${index}` },
    );
    status = await evmWindowStatus({ rest: NETWORK.rest, address: acct.bech32 });
    opened++;
  }

  entries.push({
    index,
    address: acct.evm,
    // Both keys are published deliberately. The page needs the secp256k1 key
    // to send the transaction and the ML-DSA-87 key to sign the ballot, and a
    // browser cannot derive either without a secret. Single-use: the contract
    // allows one ballot per address, and the account holds a few cents of
    // worthless testnet QOR. The MASTER mnemonic never appears here.
    privateKey: DRY_RUN ? '0xdry-run' : toHex(acct.classicalKey.privateKey),
    mldsaSecretKey: DRY_RUN ? '0xdry-run' : toHex(acct.pqKey.secretKey),
    expiryHeight: String(status.expiryHeight ?? 0n),
    remainingTxs: String(status.remainingTxs ?? 0n),
    live: Boolean(status.live),
  });
  console.log(
    `  invite ${String(index).padStart(2)} ${acct.evm} ` +
      `window ${status.live ? 'live' : 'DEAD'} expiry ${status.expiryHeight} txs ${status.remainingTxs}`,
  );
}

console.log(`  opened ${opened} window(s), topped up ${toppedUp} balance(s)`);

// ------------------------------------------------------- publish pool.json

// The election's ML-KEM-1024 + X25519 key blob, from the creation event.
//
// Read from the creation transaction's RECEIPT, not from eth_getLogs. This
// node caps getLogs at a 10,000-block range (about 4 hours), so a log scan
// found the event only while the election was young; the first scheduled run
// after that failed. A receipt lookup by hash has no age limit.
//
// The hash is pinned config, so it is checked, not trusted: the key must hash
// to the electionKeyHash the contract stored, or nothing is published. A wrong
// key here would make every demo ballot unopenable by the trustees.
let electionPublicKey = '0x';
{
  const receipt = await client.getTransactionReceipt({ hash: ELECTION_TX });
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== CONTRACT.toLowerCase()) continue;
    try {
      const parsed = decodeEventLog({ abi: ELECTION_ABI, data: l.data, topics: l.topics });
      const a = parsed.args;
      if (parsed.eventName === 'ElectionCreated' && a.electionId === ELECTION_ID) {
        electionPublicKey = a.electionPublicKey;
      }
    } catch {
      /* not one of ours */
    }
  }
}
if (electionPublicKey === '0x') {
  console.error(`keeper: transaction ${ELECTION_TX} did not create election ${ELECTION_ID} on ${CONTRACT}.`);
  console.error('  Check BOOTH_DEMO_ELECTION_TX.');
  process.exit(1);
}
if (keccak256(electionPublicKey).toLowerCase() !== election.electionKeyHash.toLowerCase()) {
  console.error('keeper: the election key from the creation event does not match the on-chain electionKeyHash.');
  console.error(`  event key hash ${keccak256(electionPublicKey)}, contract ${election.electionKeyHash}. Refusing to publish.`);
  process.exit(1);
}
console.log(`  election key ${(electionPublicKey.length - 2) / 2} bytes, matches on-chain electionKeyHash`);

const payload = {
  note: 'Demo identities. These private keys are PUBLIC BY DESIGN: each is good for one ballot in this election only and holds a few cents of worthless testnet QOR.',
  chainId: NETWORK.evmChainId,
  rpc: NETWORK.evmRpc,
  explorer: NETWORK.explorer,
  contract: CONTRACT,
  electionId: String(ELECTION_ID),
  electionPublicKey,
  question: election.question,
  closeAt: String(election.closeAt),
  generatedAtBlock: String(head),
  poolTarget: POOL_TARGET,
  invites: entries.filter((e) => e.live),
};

if (DRY_RUN) {
  console.log('\n[dry-run] pool.json would contain', payload.invites.length, 'live invites');
} else {
  mkdirSync('public', { recursive: true });
  writeFileSync('public/pool.json', JSON.stringify(payload, null, 2) + '\n');
  console.log(`\nwrote public/pool.json with ${payload.invites.length} live invite(s)`);
}

if (!payload.invites.length) {
  console.error('keeper: no invite ended up with a live window. The Vote page will show no demo identity.');
  process.exit(1);
}

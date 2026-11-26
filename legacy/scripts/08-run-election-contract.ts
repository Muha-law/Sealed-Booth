/**
 * One full live election on Election.sol, on qorechain-diana.
 *
 *   npx tsx scripts/08-run-election-contract.ts
 *
 *   create -> 5 ballots -> refused double vote -> refused early tally
 *          -> close -> 2 trustees agree -> 1 trustee contradicts -> result
 *
 * Election.sol takes the voter from `msg.sender`, so every voter submits their
 * OWN transaction. On QoreChain that means each voter needs funding, a
 * registered ML-DSA-87 key and a live EVM authorisation window before they can
 * vote at all. That provisioning is most of this script.
 *
 * Every gas limit is set from `eth_estimateGas` plus a small margin, because
 * this chain charges `max(real, limit/2)` — a generous limit is a minimum fee.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  toHex,
  type Abi,
  type Hex,
} from 'viem';
import { fetchKemKey } from '@qorechain/qoreseal/network';
import { open, seal, sealKeysFromSeed, verifyRecipientCard } from '@qorechain/qoreseal';
import { fetchPqcStatus, msg } from '@qorechain/sdk';
import { buildRegisterPqKeyMessage, fromBase64 } from '@qorechain/qoresign';
import { combine } from 'shamir-secret-sharing';

// @ts-expect-error - .mjs helper
import { loadEnv, NETWORK, requireEnv, formatQor } from './lib/env.mjs';
// @ts-expect-error - .mjs helper
import { trusteeAccount, TRUSTEE_ENV_KEYS, VOTER_ENV_KEYS } from './lib/accounts.mjs';
// @ts-expect-error - .mjs helper
import { sendNative, unifiedAccount, anyToEncodeObject, classicalPublicKeyBytes } from './lib/chain.mjs';
// @ts-expect-error - .mjs helper
import { ensureWindow, publicClient, walletClient, maxFeePerGas } from './lib/evm.mjs';
// @ts-expect-error - .mjs helper
import { recordProof } from './lib/proof.mjs';
import { setUpElection } from '../src/core/election.js';
import { ballotAad, ballotPlaintext } from '../src/core/ballot.js';
import { BALLOT_PURPOSE, SHARE_PURPOSE, BALLOT_PLAINTEXT_VERSION } from '../src/core/constants.js';

const env = loadEnv();
const CONTRACT = requireEnv(env, 'ELECTION_CONTRACT_ADDRESS') as Hex;
const abi = JSON.parse(readFileSync('out/Election.sol/Election.json', 'utf8')).abi as Abi;

const THRESHOLD = 2;
const QUESTION = 'Which animal guards the ballot box?';
const OPTIONS = ['hedgehog', 'badger', 'otter'];
const CHOICES = ['hedgehog', 'badger', 'hedgehog', 'otter', 'hedgehog'];
const VOTING_SECONDS = 240;
const VOTER_FUNDING_UQOR = 1_500_000n; // 1.5 QOR: covers a window plus native fees

const client = publicClient();
const relayer = await unifiedAccount(requireEnv(env, 'BOOTH_RELAYER_MNEMONIC'));
const fee = await maxFeePerGas(client);

/**
 * EIP-7623 floor for a transaction's calldata: 21000 + 10 per token, where a
 * zero byte is 1 token and a non-zero byte is 4. This chain enforces it, and
 * refuses to broadcast below it with "insufficient gas for floor data gas
 * cost". A ballot carries ~1.7 KB of ciphertext, so its floor (~92k) is well
 * above what the execution itself needs — the floor, not the estimate, sets
 * the real minimum.
 */
function calldataFloorGas(data: Hex): bigint {
  const bytes = data.slice(2);
  let tokens = 0n;
  for (let i = 0; i < bytes.length; i += 2) {
    tokens += bytes.slice(i, i + 2) === '00' ? 1n : 4n;
  }
  return 21_000n + 10n * tokens;
}

/**
 * Tight gas, respecting both bounds: 12% over the execution estimate, but never
 * below the EIP-7623 calldata floor. The limit doubles as a minimum fee here
 * (`max(real, limit/2)`), so it is kept as low as the chain allows.
 */
async function tightGas(account: Hex, functionName: string, args: readonly unknown[]) {
  const estimate = await client.estimateContractGas({
    address: CONTRACT,
    abi,
    functionName,
    args,
    account,
  });
  const floor = calldataFloorGas(encodeFunctionData({ abi, functionName, args }));
  const withMargin = (estimate * 112n) / 100n;
  const limit = withMargin > floor ? withMargin : (floor * 102n) / 100n;
  return { estimate, floor, limit };
}

async function sendFrom(
  privateKey: Hex,
  account: Hex,
  functionName: string,
  args: readonly unknown[],
) {
  const { estimate, floor, limit } = await tightGas(account, functionName, args);
  const wallet = walletClient(privateKey);
  const hash = await wallet.writeContract({
    address: CONTRACT,
    abi,
    functionName,
    args,
    gas: limit,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: 0n,
  });
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return {
    hash: hash as Hex,
    estimate,
    floor,
    limit,
    gasUsed: r.gasUsed as bigint,
    block: r.blockNumber,
  };
}

/** Send something expected to revert, with a deliberately tight limit. */
async function sendExpectingRevert(
  privateKey: Hex,
  account: Hex,
  functionName: string,
  args: readonly unknown[],
  expected: string,
  executionGas: bigint,
) {
  // A reverting call cannot be estimated, so take the execution cost as given
  // but still respect the EIP-7623 calldata floor.
  const floor = calldataFloorGas(encodeFunctionData({ abi, functionName, args }));
  const limit = executionGas > floor ? executionGas : (floor * 102n) / 100n;

  let simulated = '(simulation did not revert)';
  try {
    await client.simulateContract({ address: CONTRACT, abi, functionName, args, account });
    throw new Error(`${functionName} was ACCEPTED but should have reverted with ${expected}`);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    const m = new RegExp(expected).exec(text);
    if (!m) throw err;
    simulated = m[0];
  }

  const wallet = walletClient(privateKey);
  const hash = await wallet.writeContract({
    address: CONTRACT,
    abi,
    functionName,
    args,
    gas: limit,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: 0n,
  });
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status === 'success') throw new Error(`${functionName} succeeded on chain but must fail`);
  return { hash: hash as Hex, reason: simulated, gasUsed: r.gasUsed as bigint, limit, floor };
}

const read = (functionName: string, args: readonly unknown[] = []) =>
  client.readContract({ address: CONTRACT, abi, functionName, args });

async function balanceUqor(bech32: string) {
  const res = await fetch(`${NETWORK.rest}/cosmos/bank/v1beta1/balances/${bech32}`);
  const json = await res.json();
  return BigInt((json.balances ?? []).find((b: { denom: string }) => b.denom === 'uqor')?.amount ?? 0);
}

console.log(`Election ${CONTRACT}`);
console.log(`admin    ${relayer.evm}\n`);

// --------------------------------------------------- 0. provision the voters

// The admin sends createElection, so it needs a live window too. Windows
// expire by BLOCK COUNT: remainingTxs and remainingValue can still be
// non-zero while `live` is false, so always test `live`.
console.log('--- admin window ---');
await ensureWindow(relayer, { txs: 4, gasEach: 900_000, blocks: 17_280 });

console.log('\n--- provisioning voters (each casts its own transaction) ---');
const voters = [];
for (const [i, key] of VOTER_ENV_KEYS.entries()) {
  const v = await unifiedAccount(requireEnv(env, key));
  const label = `voter ${i + 1}`;

  const have = await balanceUqor(v.cosmos);
  if (have < VOTER_FUNDING_UQOR) {
    const amount = (VOTER_FUNDING_UQOR - have).toString();
    await sendNative(
      relayer,
      [
        msg.bank.send({
          fromAddress: relayer.cosmos,
          toAddress: v.cosmos,
          amount: [{ denom: 'uqor', amount }],
        }),
      ],
      { gas: 220_000, memo: 'booth: fund voter' },
    );
    console.log(`  ${label}: funded ${formatQor(amount)}`);
  }

  const pqc = (await fetchPqcStatus({ rest: NETWORK.rest, address: v.cosmos })) as {
    registered?: boolean;
    found?: boolean;
  };
  if (!(pqc.registered ?? pqc.found)) {
    await sendNative(
      v,
      [
        anyToEncodeObject(
          buildRegisterPqKeyMessage({
            chainId: NETWORK.chainId,
            account: v.cosmos,
            pqKey: v.pqc,
            classicalPublicKey: classicalPublicKeyBytes(v),
          }),
        ),
      ],
      { bootstrap: true, gas: 320_000, memo: 'booth: voter ML-DSA-87 identity' },
    );
    console.log(`  ${label}: ML-DSA-87 key registered`);
  }

  // Voter 1 needs two EVM txs (its ballot plus the refused double vote).
  await ensureWindow(v, { txs: i === 0 ? 4 : 2, gasEach: 600_000, blocks: 17_280 });
  voters.push({ label, account: v, choice: CHOICES[i]! });
}

console.log('\n--- provisioning trustees for the EVM lane ---');
const trustees = [];
for (const [i, key] of TRUSTEE_ENV_KEYS.entries()) {
  const local = trusteeAccount(requireEnv(env, key));
  const uni = await unifiedAccount(requireEnv(env, key));
  const kem = await fetchKemKey({ rest: NETWORK.rest, address: local.bech32 });
  if (!kem.registered) throw new Error(`trustee ${i + 1} has no ML-KEM key on chain`);

  const status = (await fetchPqcStatus({ rest: NETWORK.rest, address: local.bech32 })) as {
    pubkey: string;
  };
  const cards = JSON.parse(readFileSync('build/trustee-cards.json', 'utf8')) as {
    address: string;
    card: Parameters<typeof verifyRecipientCard>[0]['card'];
  }[];
  // The ML-DSA key binding: trust the ML-KEM key only because this account's
  // post-quantum identity signed a card for it.
  const recipient = verifyRecipientCard({
    card: cards.find((c) => c.address === local.bech32)!.card,
    chainId: NETWORK.chainId,
    pqPublicKey: fromBase64(status.pubkey),
    mlkemPublicKey: kem.publicKey!,
  });

  await ensureWindow(uni, { txs: 3, gasEach: 400_000, blocks: 17_280 });
  trustees.push({
    label: `trustee ${i + 1}`,
    index: i,
    local,
    account: uni,
    recipient,
    // The on-chain key reference the contract stores.
    keyRef: keccak256(kem.publicKey!),
  });
  console.log(`  trustee ${i + 1}: card verified, keyRef ${keccak256(kem.publicKey!).slice(0, 18)}…`);
}

// ------------------------------------------------------------- 1. create

console.log('\n--- createElection ---');
const setup = await setUpElection({
  chainId: NETWORK.chainId,
  trustees: trustees.map((t) => t.recipient),
  threshold: THRESHOLD,
});

const head = await client.getBlock();
const openAt = BigInt(head.timestamp);
const closeAt = openAt + BigInt(VOTING_SECONDS);

const createArgs = [
  QUESTION,
  OPTIONS,
  openAt,
  closeAt,
  THRESHOLD,
  voters.map((v) => v.account.evm as Hex),
  trustees.map((t) => t.account.evm as Hex),
  trustees.map((t) => t.keyRef),
  toHex(setup.electionPublicKey),
  setup.shareCommitments,
  setup.sealedShares.map((s: Uint8Array) => toHex(s)),
] as const;

const created = await sendFrom(relayer.privateKey, relayer.evm, 'createElection', createArgs);
const electionId = (await read('electionCount')) as bigint;
console.log(`  election ${electionId}: ${THRESHOLD} of ${trustees.length} trustees, ${voters.length} voters`);
console.log(`  gas estimate ${created.estimate}, floor ${created.floor}, limit ${created.limit}, charged ${created.gasUsed}`);
recordProof({
  proves:
    `Election.sol election ${electionId} created by the admin: question, 3 options, a 5-address voter allowlist, ` +
    `3 trustees each referenced by the keccak256 of their REGISTERED ML-KEM-1024 key, threshold ${THRESHOLD}, ` +
    `open/close times, the election ML-KEM-1024 public key and 3 QoreSeal-sealed shares`,
  txHash: created.hash,
  gasUsed: created.gasUsed,
  lane: 'evm',
});

const ref = { evmChainId: NETWORK.evmChainId, contract: CONTRACT, electionId };
const aad = ballotAad(ref);

// --------------------------------------------------------------- 2. vote

console.log('\n--- 5 voters cast their own ballots ---');
const receipts: { label: string; voter: Hex; ballotId: bigint; ciphertextHash: Hex }[] = [];
for (const v of voters) {
  const envelope = seal({
    chainId: NETWORK.chainId,
    purpose: BALLOT_PURPOSE,
    mode: 'hybrid',
    recipients: [
      {
        mlkemPublicKey: setup.electionPublicKey.slice(1, 1569),
        x25519PublicKey: setup.electionPublicKey.slice(1569),
      },
    ],
    plaintext: ballotPlaintext(v.choice),
    aad,
  });

  const sent = await sendFrom(v.account.privateKey, v.account.evm, 'castBallot', [
    electionId,
    toHex(envelope),
  ]);
  const ballotId = (await read('getElection', [electionId])) as { ballotCount: number };
  receipts.push({
    label: v.label,
    voter: v.account.evm,
    ballotId: BigInt(ballotId.ballotCount),
    ciphertextHash: keccak256(envelope),
  });
  console.log(
    `  ${v.label}: ballot ${ballotId.ballotCount}, ${envelope.length} B sealed, ` +
      `estimate ${sent.estimate}, floor ${sent.floor}, limit ${sent.limit}, charged ${sent.gasUsed}`,
  );

  if (v.label === 'voter 1') {
    recordProof({
      proves:
        `voter 1 cast an ML-KEM-1024 sealed ballot on Election.sol from its own account; the contract stored only ` +
        `keccak256(ciphertext) and emitted the ciphertext in an event. Gas limit ${sent.limit} set from a ${sent.estimate} estimate`,
      txHash: sent.hash,
      gasUsed: sent.gasUsed,
      lane: 'evm',
    });
  }
}

// ------------------------------------------------- 3. double vote (refused)

console.log('\n--- double vote by voter 1 (expect AlreadyVoted) ---');
const dupEnvelope = seal({
  chainId: NETWORK.chainId,
  purpose: BALLOT_PURPOSE,
  mode: 'hybrid',
  recipients: [
    {
      mlkemPublicKey: setup.electionPublicKey.slice(1, 1569),
      x25519PublicKey: setup.electionPublicKey.slice(1569),
    },
  ],
  plaintext: ballotPlaintext('otter'),
  aad,
});
const dup = await sendExpectingRevert(
  voters[0]!.account.privateKey,
  voters[0]!.account.evm,
  'castBallot',
  [electionId, toHex(dupEnvelope)],
  'AlreadyVoted',
  90_000n,
);
console.log(`  refused with ${dup.reason}, charged ${dup.gasUsed}`);
recordProof({
  proves: `a second ballot from voter 1 was REFUSED on chain with ${dup.reason} — one allowlisted voter, one ballot`,
  txHash: dup.hash,
  gasUsed: dup.gasUsed,
  lane: 'evm',
});

// --------------------------------------------- 4. early tally (refused)

console.log('\n--- tally before close by trustee 1 (expect StillOpen) ---');
const early = await sendExpectingRevert(
  trustees[0]!.account.privateKey,
  trustees[0]!.account.evm,
  'submitTally',
  [electionId, [0n, 0n, 0n], keccak256(toHex('premature'))],
  'StillOpen',
  90_000n,
);
console.log(`  refused with ${early.reason}, charged ${early.gasUsed}`);
recordProof({
  proves: `a tally submitted before the close was REFUSED on chain with ${early.reason} — ballots cannot be opened early`,
  txHash: early.hash,
  gasUsed: early.gasUsed,
  lane: 'evm',
});

// ------------------------------------------------------------- 5. close

console.log('\n--- waiting for the close ---');
for (;;) {
  const b = await client.getBlock();
  const left = Number(closeAt) - Number(b.timestamp);
  if (left <= 0) break;
  console.log(`  ${left}s to go`);
  await new Promise((r) => setTimeout(r, Math.min(left, 25) * 1000));
}
console.log(`  isOpen(${electionId}) = ${await read('isOpen', [electionId])}`);

// ------------------------------------------- 6. trustees decrypt and tally

console.log('\n--- trustees open their shares and count, off chain ---');
const logs = await client.getLogs({ address: CONTRACT, fromBlock: created.block, toBlock: 'latest' });

const sealedByIndex = new Map<number, Uint8Array>();
const ballots: { ballotId: bigint; ciphertext: Uint8Array }[] = [];
for (const log of logs) {
  try {
    const parsed = decodeEventLog({ abi, data: log.data, topics: log.topics });
    const a = parsed.args as unknown as Record<string, unknown>;
    if (a.electionId !== electionId) continue;
    const bytes = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
    if (parsed.eventName === 'ShareSealed') {
      sealedByIndex.set(Number(a.trusteeIndex), bytes(a.sealedShare as string));
    } else if (parsed.eventName === 'BallotCast') {
      ballots.push({ ballotId: a.ballotId as bigint, ciphertext: bytes(a.ciphertext as string) });
    }
  } catch {
    /* not ours */
  }
}
console.log(`  ${sealedByIndex.size} sealed shares and ${ballots.length} ballots in the log`);

const shares: Uint8Array[] = [];
for (const t of trustees.slice(0, THRESHOLD)) {
  shares.push(
    open({
      chainId: NETWORK.chainId,
      purpose: SHARE_PURPOSE,
      envelope: sealedByIndex.get(t.index)!,
      keys: t.local.sealKeys,
    }),
  );
}
const keys = sealKeysFromSeed(await combine(shares));
console.log(`  ${THRESHOLD} shares recombined; election key rebuilt`);

ballots.sort((a, b) => Number(a.ballotId - b.ballotId));
const totals = OPTIONS.map(() => 0n);
for (const b of ballots) {
  const plain = JSON.parse(
    new TextDecoder().decode(
      open({ chainId: NETWORK.chainId, purpose: BALLOT_PURPOSE, envelope: b.ciphertext, keys, aad }),
    ),
  ) as { v: number; choice: string };
  if (plain.v !== BALLOT_PLAINTEXT_VERSION) throw new Error('unexpected ballot version');
  const at = OPTIONS.indexOf(plain.choice);
  if (at < 0) throw new Error(`ballot ${b.ballotId} chose an unknown option`);
  totals[at]!++;
}
const countedBallotIdsHash = keccak256(
  encodeAbiParameters(parseAbiParameters('uint256[]'), [ballots.map((b) => b.ballotId)]),
);
console.log(`  counted: ${OPTIONS.map((o, i) => `${o}=${totals[i]}`).join('  ')}`);

// --------------------------------- 7. two trustees submit matching totals

console.log('\n--- trustee 1 and trustee 2 submit matching totals ---');
for (const t of trustees.slice(0, THRESHOLD)) {
  const sent = await sendFrom(t.account.privateKey, t.account.evm, 'submitTally', [
    electionId,
    totals,
    countedBallotIdsHash,
  ]);
  const status = (await read('resultStatus', [electionId])) as [boolean, number, number];
  console.log(
    `  ${t.label}: submitted, agreements ${status[1]}/${status[2]}, final ${status[0]}, charged ${sent.gasUsed}`,
  );
  recordProof({
    proves:
      `${t.label} submitted its tally for election ${electionId}` +
      (status[0]
        ? ` — the ${THRESHOLD}nd matching submission, so the result is now FINAL`
        : ` — one of ${THRESHOLD} needed, no result yet`),
    txHash: sent.hash,
    gasUsed: sent.gasUsed,
    lane: 'evm',
  });
}

// ---------------------------------- 8. a trustee submits a wrong total

console.log('\n--- trustee 3 submits a WRONG total (expect no result from it) ---');
const wrong = totals.map((n, i) => (i === 0 ? n + 7n : n));
const bad = await sendExpectingRevert(
  trustees[2]!.account.privateKey,
  trustees[2]!.account.evm,
  'submitTally',
  [electionId, wrong, countedBallotIdsHash],
  'TallyMismatch',
  110_000n,
);
console.log(`  refused with ${bad.reason}, charged ${bad.gasUsed}`);
recordProof({
  proves:
    `trustee 3 tried to submit totals contradicting the final result and was REFUSED on chain with ${bad.reason} — ` +
    `a dissenting trustee cannot change or dispute a result that k trustees already agreed`,
  txHash: bad.hash,
  gasUsed: bad.gasUsed,
  lane: 'evm',
});

// ----------------------------------------------------------- 9. the result

console.log('\n--- final result, read from the contract ---');
const [finalTotals, finalCounted, agreements] = (await read('finalResult', [electionId])) as [
  readonly bigint[],
  Hex,
  number,
];

console.log('\n================ RESULT ================');
OPTIONS.forEach((o, i) => {
  console.log(`  ${o.padEnd(10)} ${String(finalTotals[i]).padStart(2)}  ${'#'.repeat(Number(finalTotals[i]))}`);
});
console.log(`  agreements ${agreements} of ${THRESHOLD} required`);
console.log(`  countedBallotIdsHash ${finalCounted}`);
console.log('========================================');

const expected = CHOICES.reduce<Record<string, number>>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), {});
OPTIONS.forEach((o, i) => {
  if (Number(finalTotals[i]) !== (expected[o] ?? 0)) {
    throw new Error(`final result disagrees with the ballots cast for ${o}`);
  }
});
if (finalCounted !== countedBallotIdsHash) throw new Error('counted-ballot hash mismatch');
console.log('\nFinal result matches the five ballots cast.');

console.log('\n--- voter receipts: each voter checks their own ballot is included ---');
for (const r of receipts) {
  const stored = (await read('ballotHash', [electionId, r.ballotId])) as Hex;
  const voted = await read('hasVoted', [electionId, r.voter]);
  const ok = stored === r.ciphertextHash && voted === true;
  console.log(`  ${r.label}: ballot ${r.ballotId} hash matches = ${ok}`);
  if (!ok) throw new Error(`${r.label} cannot verify inclusion`);
}

// The result itself is a READ, not a transaction, so it gets no PROOF.md row
// — rows are only ever written for confirmed transactions. The result is
// recorded in the PROOF.md narrative section instead.
const resultLines = [
  `election ${electionId} on ${CONTRACT}`,
  ...OPTIONS.map((o, i) => `  ${o} = ${finalTotals[i]}`),
  `  agreements ${agreements}/${THRESHOLD}`,
  `  countedBallotIdsHash ${finalCounted}`,
];
writeFileSync('build/election-result.txt', resultLines.join('\n') + '\n');

console.log(`\nElection ${electionId} complete on Election.sol.`);

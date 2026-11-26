/**
 * True EVM execution gas for each Booth operation.
 *
 * This chain's EVM lane charges `max(real gas, gasLimit / 2)` — a 50%-of-limit
 * floor, established in scripts/04-gas-check.ts and refined when the Election
 * deployment exceeded the floor and the receipt then reported the true figure.
 * The native lane has no such floor. So for EVM figures the honest source is
 * `eth_estimateGas`, which actually executes the call.
 *
 * This opens one measurement election so `castBallot` can be estimated against
 * a voter who has not yet voted, then estimates every operation. Only the two
 * setup transactions are sent; the ballot and reveal are estimated, never sent.
 *
 *   npx tsx scripts/05-measure-evm-gas.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak256, toHex, type Abi, type Hex } from 'viem';
import { fetchKemKey } from '@qorechain/qoreseal/network';
import { verifyRecipientCard, type RecipientCard } from '@qorechain/qoreseal';
import { fetchPqcStatus } from '@qorechain/sdk';
import { fromBase64 } from '@qorechain/qoresign';

// @ts-expect-error - .mjs helper
import { loadEnv, NETWORK, requireEnv } from './lib/env.mjs';
// @ts-expect-error - .mjs helper
import { trusteeAccount, TRUSTEE_ENV_KEYS, VOTER_ENV_KEYS } from './lib/accounts.mjs';
// @ts-expect-error - .mjs helper
import { unifiedAccount } from './lib/chain.mjs';
// @ts-expect-error - .mjs helper
import { publicClient, walletClient, receipt, maxFeePerGas } from './lib/evm.mjs';
import { setUpElection } from '../src/core/election.js';
import { voterFromMnemonic, type VoterIdentity } from '../src/core/identity.js';
import { castBallot } from '../src/core/ballot.js';

const env = loadEnv();
const CONTRACT = requireEnv(env, 'BOOTH_CONTRACT_ADDRESS') as Hex;
const abi = JSON.parse(readFileSync('build/Booth.json', 'utf8')).abi as Abi;

const client = publicClient();
const relayer = await unifiedAccount(requireEnv(env, 'BOOTH_RELAYER_MNEMONIC'));
const wallet = walletClient(relayer.privateKey);
const fee = await maxFeePerGas(client);
const measured: Record<string, string> = {};

const estimate = (functionName: string, args: readonly unknown[]) =>
  client.estimateContractGas({ address: CONTRACT, abi, functionName, args, account: relayer.evm });

// Rebuild the trustee recipients from the chain, as a real client would.
const cardsFile = JSON.parse(readFileSync('build/trustee-cards.json', 'utf8')) as {
  address: string;
  card: RecipientCard;
}[];
const recipients = [];
for (const key of TRUSTEE_ENV_KEYS) {
  const local = trusteeAccount(requireEnv(env, key));
  const kem = await fetchKemKey({ rest: NETWORK.rest, address: local.bech32 });
  const status = (await fetchPqcStatus({ rest: NETWORK.rest, address: local.bech32 })) as {
    pubkey: string;
  };
  recipients.push(
    verifyRecipientCard({
      card: cardsFile.find((c) => c.address === local.bech32)!.card,
      chainId: NETWORK.chainId,
      pqPublicKey: fromBase64(status.pubkey),
      mlkemPublicKey: kem.publicKey!,
    }),
  );
}

const setup = await setUpElection({ chainId: NETWORK.chainId, trustees: recipients, threshold: 2 });
const head = await client.getBlock();
const closesAt = BigInt(head.timestamp) + 3600n; // an hour: this election is only for measuring

const createArgs = [
  'Booth gas measurement (not a real vote)',
  ['hedgehog', 'badger', 'otter'],
  closesAt,
  2,
  toHex(setup.electionPublicKey),
  setup.shareCommitments,
  setup.sealedShares.map((s: Uint8Array) => toHex(s)),
] as const;

measured.createElection = String(await estimate('createElection', createArgs));
console.log(`createElection  ${measured.createElement ?? measured.createElection} gas (estimate)`);

const createHash = await wallet.writeContract({
  address: CONTRACT,
  abi,
  functionName: 'createElection',
  args: createArgs,
  gas: 2_500_000n,
  maxFeePerGas: fee,
  maxPriorityFeePerGas: 0n,
});
await receipt(client, createHash);
const electionId = (await client.readContract({
  address: CONTRACT,
  abi,
  functionName: 'electionCount',
})) as bigint;
console.log(`  measurement election is ${electionId}`);

const voters: VoterIdentity[] = (VOTER_ENV_KEYS as string[]).map((k) =>
  voterFromMnemonic(requireEnv(env, k)),
);
const rollArgs = [
  electionId,
  voters.map((v) => v.evmAddress),
  voters.map((v) => keccak256(v.mldsaPublicKey)),
] as const;

measured.registerVoters5 = String(await estimate('registerVoters', rollArgs));
console.log(`registerVoters  ${measured.registerVoters5} gas for 5 voters (estimate)`);

const rollHash = await wallet.writeContract({
  address: CONTRACT,
  abi,
  functionName: 'registerVoters',
  args: rollArgs,
  gas: 1_500_000n,
  maxFeePerGas: fee,
  maxPriorityFeePerGas: 0n,
});
await receipt(client, rollHash);

// Now a real ballot, estimated but never sent.
const sealed = await castBallot({
  evmChainId: NETWORK.evmChainId,
  contract: CONTRACT,
  electionId,
  chainId: NETWORK.chainId,
  electionPublicKey: setup.electionPublicKey,
  choice: 'hedgehog',
  voter: voters[0]!,
});
measured.castBallot = String(
  await estimate('castBallot', [
    electionId,
    toHex(sealed.envelope),
    toHex(sealed.mldsaPublicKey),
    toHex(sealed.mldsaSignature),
    sealed.secpSignature,
  ]),
);
measured.ballotCalldataBytes = String(
  sealed.envelope.length + sealed.mldsaPublicKey.length + sealed.mldsaSignature.length + 65,
);
console.log(`castBallot      ${measured.castBallot} gas (estimate, not sent)`);
console.log(`  ballot calldata ${measured.ballotCalldataBytes} bytes`);

writeFileSync('build/evm-gas.json', JSON.stringify(measured, null, 2) + '\n', 'utf8');
console.log('\nWrote build/evm-gas.json');
console.log(`measurement election ${electionId} is left open and unused — it holds no ballots.`);

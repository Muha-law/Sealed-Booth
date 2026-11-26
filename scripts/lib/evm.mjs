/**
 * The EVM lane, and the authorisation window every transaction on it needs.
 *
 * On QoreChain an EVM transaction is admitted only from an account that has a
 * registered ML-DSA-87 key AND a live window, and the window is opened by a
 * hybrid-signed message on the NATIVE lane. So the classical key can never
 * move value on its own — and no browser wallet can do this today, which is
 * why Booth relays.
 *
 * Order matters: open the window, THEN read the nonce. Opening advances it,
 * because the Cosmos sequence *is* the EVM nonce.
 */
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { qorechainTestnet } from '@qorechain/evm';
import { evmWindowCost, evmWindowStatus } from '@qorechain/evm/window';
import { msg } from '@qorechain/sdk';
import { NETWORK, formatQor } from './env.mjs';
import { sendNative } from './chain.mjs';

/** 112.5 gwei is what this testnet quotes; read it live rather than assume. */
export async function maxFeePerGas(publicClient) {
  const price = await publicClient.getGasPrice();
  // A little headroom so a block-to-block move does not strand a transaction.
  return (price * 12n) / 10n;
}

export function publicClient() {
  return createPublicClient({ chain: qorechainTestnet, transport: http(NETWORK.evmRpc) });
}

export function walletClient(evmPrivateKey) {
  return createWalletClient({
    account: privateKeyToAccount(evmPrivateKey),
    chain: qorechainTestnet,
    transport: http(NETWORK.evmRpc),
  });
}

export async function windowStatus(address) {
  return evmWindowStatus({ rest: NETWORK.rest, address });
}

/**
 * Make sure the relayer has a window big enough for `txs` transactions of
 * `gasEach`. Opens one only when the stored window cannot cover the work.
 *
 * @returns the transaction result when a window was opened, else null.
 */
export async function ensureWindow(unified, { txs, gasEach, blocks = 17_280 }) {
  const client = publicClient();
  const fee = await maxFeePerGas(client);
  const perTx = evmWindowCost({ gas: BigInt(gasEach), maxFeePerGas: fee });
  const needed = perTx * BigInt(txs);

  const current = await windowStatus(unified.cosmos);
  if (current.live && BigInt(current.remainingTxs) >= BigInt(txs) && BigInt(current.remainingValue) >= needed) {
    console.log(
      `  window already live: ${current.remainingTxs} txs, ` +
        `${formatQor(current.remainingValue)}, ${current.remainingBlocks} blocks left`,
    );
    return null;
  }

  console.log(
    `  opening EVM window: ${txs} txs x ${gasEach} gas @ ${fee} wei/gas ` +
      `= ${formatQor(needed)} over ${blocks} blocks`,
  );

  const result = await sendNative(
    unified,
    [
      msg.pqc.openEvmWindow({
        sender: unified.cosmos,
        blocks: String(blocks),
        maxTxs: String(txs),
        maxValue: needed.toString(),
      }),
    ],
    { gas: 300_000, memo: 'booth: open EVM authorisation window' },
  );

  const after = await windowStatus(unified.cosmos);
  if (!after.live) {
    throw new Error(
      `window did not come up live after opening it: ${JSON.stringify(after, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      )}`,
    );
  }
  return { result, needed, perTx, fee };
}

/** Wait for a receipt and fail loudly on a reverted transaction. */
export async function receipt(client, hash) {
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== 'success') {
    throw new Error(`EVM transaction ${hash} reverted (status ${r.status}), gas used ${r.gasUsed}`);
  }
  return r;
}

/**
 * Compare a deployed runtime against a forge artifact, allowing for immutables.
 *
 * Solidity patches `immutable` values into the runtime bytecode at deployment,
 * so a byte-for-byte comparison against the artifact always fails for any
 * contract with one. The artifact's `immutableReferences` gives the exact
 * offsets and lengths, so those windows are masked out of both sides.
 *
 * @returns {{match: boolean, maskedBytes: number, diffs: number[]}}
 */
export function runtimeMatches(artifact, onChainHex) {
  const expected = artifact.deployedBytecode.object.toLowerCase().replace(/^0x/, '');
  const actual = (onChainHex ?? '').toLowerCase().replace(/^0x/, '');

  if (expected.length !== actual.length) {
    return { match: false, maskedBytes: 0, diffs: [], reason: 'length differs' };
  }

  // Byte offsets covered by an immutable.
  const masked = new Set();
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) {
      for (let b = start; b < start + length; b++) masked.add(b);
    }
  }

  const diffs = [];
  for (let b = 0; b * 2 < expected.length; b++) {
    if (masked.has(b)) continue;
    if (expected.slice(b * 2, b * 2 + 2) !== actual.slice(b * 2, b * 2 + 2)) diffs.push(b);
  }

  return { match: diffs.length === 0, maskedBytes: masked.size, diffs };
}

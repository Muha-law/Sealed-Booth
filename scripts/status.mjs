/**
 * Read-only preflight. Says exactly what is funded, what keys are registered
 * and whether the EVM authorisation window is open, so a failure later is never
 * a surprise. Sends no transaction and spends nothing.
 *
 *   node scripts/status.mjs
 */
import { fetchPqcStatus, fetchEvmWindow, fetchMinGasPriceUqor } from '@qorechain/sdk';
import { fetchKemKey } from '@qorechain/qoreseal/network';
import { loadEnv, NETWORK, formatQor } from './lib/env.mjs';
import { boothAccount, trusteeAccount, TRUSTEE_ENV_KEYS, VOTER_ENV_KEYS } from './lib/accounts.mjs';

const env = loadEnv();

async function balanceUqor(bech32) {
  const res = await fetch(`${NETWORK.rest}/cosmos/bank/v1beta1/balances/${bech32}`);
  if (!res.ok) throw new Error(`balance query failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const entry = (json.balances ?? []).find((b) => b.denom === 'uqor');
  return BigInt(entry?.amount ?? 0);
}

async function describe(label, account, opts = {}) {
  const line = [`${label.padEnd(11)} ${account.bech32}`];
  let balance = 0n;
  try {
    balance = await balanceUqor(account.bech32);
    line.push(`  balance ${formatQor(balance)}`);
  } catch (err) {
    line.push(`  balance UNKNOWN (${err.message})`);
  }

  try {
    const pqc = await fetchPqcStatus({ rest: NETWORK.rest, address: account.bech32 });
    line.push(`  ML-DSA-87 key ${pqc.registered ?? pqc.found ? 'registered' : 'NOT registered'}`);
  } catch (err) {
    line.push(`  ML-DSA-87 key UNKNOWN (${err.message})`);
  }

  if (opts.kem) {
    try {
      const kem = await fetchKemKey({ rest: NETWORK.rest, address: account.bech32 });
      line.push(
        kem.registered
          ? `  ML-KEM key registered (alg ${kem.algorithmId}${kem.algorithmName ? ` ${kem.algorithmName}` : ''})`
          : '  ML-KEM key NOT registered',
      );
    } catch (err) {
      line.push(`  ML-KEM key UNKNOWN (${err.message})`);
    }
  }

  if (opts.window) {
    try {
      const w = await fetchEvmWindow({ rest: NETWORK.rest, address: account.bech32 });
      line.push(
        w.live
          ? `  EVM window LIVE — ${w.remainingTxs} txs, ${formatQor(w.remainingValue)}, ${w.remainingBlocks} blocks left`
          : '  EVM window CLOSED',
      );
    } catch (err) {
      line.push(`  EVM window UNKNOWN (${err.message})`);
    }
  }

  console.log(line.join('\n'));
  console.log('');
  return balance;
}

console.log(`network   ${NETWORK.chainId}  (EVM ${NETWORK.evmChainId})`);
console.log(`rest      ${NETWORK.rest}`);
try {
  console.log(`min gas   ${await fetchMinGasPriceUqor({ rest: NETWORK.rest })} uqor/gas`);
} catch (err) {
  console.log(`min gas   UNKNOWN (${err.message})`);
}
console.log('');

if (!env.BOOTH_RELAYER_MNEMONIC) {
  console.error('No accounts yet. Run: node scripts/generate-accounts.mjs');
  process.exit(1);
}

const relayer = boothAccount(env.BOOTH_RELAYER_MNEMONIC);
const relayerBalance = await describe('relayer', relayer, { window: true });

for (const [i, key] of TRUSTEE_ENV_KEYS.entries()) {
  if (!env[key]) {
    console.log(`trustee ${i + 1}   ${key} not set\n`);
    continue;
  }
  await describe(`trustee ${i + 1}`, trusteeAccount(env[key]), { kem: true });
}

for (const [i, key] of VOTER_ENV_KEYS.entries()) {
  if (!env[key]) continue;
  const voter = boothAccount(env[key]);
  console.log(`voter ${i + 1}     ${voter.bech32}   ${voter.evm}`);
}

console.log('');
if (env.BOOTH_CONTRACT_ADDRESS) {
  console.log(`Booth contract ${env.BOOTH_CONTRACT_ADDRESS}`);
} else {
  console.log('Booth contract not deployed yet.');
}

if (relayerBalance === 0n) {
  console.log('');
  console.log('BLOCKED: the relayer has no QOR, so nothing can be sent.');
  console.log(`Fund ${relayer.bech32}`);
  console.log(`at ${NETWORK.faucet} (sign-in required; 100 QOR per 24h).`);
  process.exit(2);
}

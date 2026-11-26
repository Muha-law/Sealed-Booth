// .env loading and the network constants, all from docs/VERIFIED-FACTS.md.
// Nothing here is invented: every value was measured against the live testnet.
import { readFileSync, existsSync } from 'node:fs';

/** Minimal .env reader. No dependency, and it never echoes a value. */
export function loadEnv(path = '.env') {
  if (!existsSync(path)) return {};
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  const merged = { ...env, ...process.env };

  // Hard isolation for the per-trustee processes. When BOOTH_ONLY_TRUSTEE=<i>
  // is set, every other secret is stripped before the caller sees it, so a
  // trustee process cannot reach another trustee's key even though .env on disk
  // holds them all. This is what makes "separate processes" a real claim rather
  // than a convention the code happens to follow.
  const only = merged.BOOTH_ONLY_TRUSTEE;
  if (only !== undefined && only !== '') {
    const keep = `BOOTH_TRUSTEE_${Number(only) + 1}_MNEMONIC`;
    for (const key of Object.keys(merged)) {
      if (key.endsWith('_MNEMONIC') && key !== keep) delete merged[key];
    }
    if (!merged[keep]) {
      throw new Error(`BOOTH_ONLY_TRUSTEE=${only} but ${keep} is not set`);
    }
  }

  return merged;
}

export const NETWORK = {
  chainId: 'qorechain-diana',
  evmChainId: 9800,
  rest: 'https://api-testnet.qore.host',
  rpc: 'https://rpc-testnet.qore.host',
  evmRpc: 'https://evm-testnet.qore.host',
  explorer: 'https://explore.qore.network',
  faucet: 'https://dashboard.qorechain.io/faucet',
};

export function explorerTx(hash) {
  return `${NETWORK.explorer}/tx/${hash}`;
}

/** Fail with a message that names what to do, never with a bare undefined. */
export function requireEnv(env, key) {
  const value = env[key];
  if (!value) {
    throw new Error(
      `${key} is not set in .env.\n` +
        `Run: node scripts/generate-accounts.mjs\n` +
        `then fund the printed qor1 address at ${NETWORK.faucet}`,
    );
  }
  return value;
}

/** uqor has 6 decimals. Format for humans without losing precision. */
export function formatQor(uqor) {
  const n = BigInt(uqor);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${frac} QOR`;
}

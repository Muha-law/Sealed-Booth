/**
 * Create the nine accounts a full Booth run needs and write their mnemonics to
 * .env (gitignored, testnet only).
 *
 * Mnemonics are NEVER printed. Only addresses reach the terminal — the one
 * address to fund, and the rest for reference. Re-running refuses to overwrite
 * an existing .env unless --force is passed, so a funded account cannot be
 * thrown away by accident.
 *
 *   node scripts/generate-accounts.mjs
 *   node scripts/generate-accounts.mjs --force
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateMnemonic } from '@qorechain/sdk';
import { NETWORK } from './lib/env.mjs';
import { boothAccount, TRUSTEE_ENV_KEYS, VOTER_ENV_KEYS } from './lib/accounts.mjs';

const force = process.argv.includes('--force');

if (existsSync('.env') && !force) {
  console.error('.env already exists. Refusing to overwrite it — it may hold funded accounts.');
  console.error('Pass --force only if you are certain you want new accounts.');
  process.exit(1);
}

const roles = [
  { key: 'BOOTH_RELAYER_MNEMONIC', label: 'relayer / deployer' },
  ...TRUSTEE_ENV_KEYS.map((key, i) => ({ key, label: `trustee ${i + 1}` })),
  ...VOTER_ENV_KEYS.map((key, i) => ({ key, label: `voter ${i + 1}` })),
];

const generated = roles.map((role) => {
  const mnemonic = generateMnemonic();
  return { ...role, mnemonic, account: boothAccount(mnemonic) };
});

const template = existsSync('.env.example') ? readFileSync('.env.example', 'utf8') : '';
const header = template
  .split(/\r?\n/)
  .filter((l) => l.startsWith('QORECHAIN_') || l.startsWith('#'))
  .join('\n');

const body = generated
  .map(
    (g) =>
      `# ${g.label} — ${g.account.bech32}\n` +
      `#   EVM: ${g.account.evm}\n` +
      `${g.key}=${g.mnemonic}`,
  )
  .join('\n\n');

writeFileSync(
  '.env',
  `${header}\n\n# ---------------------------------------------------------------\n` +
    `# Generated accounts. SECRET. Testnet only. Never commit this file.\n` +
    `# ---------------------------------------------------------------\n\n${body}\n\n` +
    `# Filled in by scripts/deploy.mjs\nBOOTH_CONTRACT_ADDRESS=\n`,
  'utf8',
);

const relayer = generated[0].account;

console.log('Wrote 9 accounts to .env (mnemonics are not printed anywhere).\n');
console.log('FUND THIS ONE ADDRESS:\n');
console.log(`    ${relayer.bech32}\n`);
console.log(`at ${NETWORK.faucet}  (sign in, paste the qor1 address, request 100 QOR)`);
console.log('\nThe relayer pays for everything and then funds the trustees itself,');
console.log('so one faucet claim is enough — the faucet allows only one per 24 hours.\n');
console.log('For reference:');
for (const g of generated.slice(1)) {
  console.log(`  ${g.label.padEnd(11)} ${g.account.bech32}`);
}
console.log('\nNext: node scripts/status.mjs');

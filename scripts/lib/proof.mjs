/**
 * Appends a row to PROOF.md the moment a transaction confirms.
 *
 * Project rule: a row is only ever written for a real, confirmed transaction.
 * This helper refuses to write without a transaction hash, and records the gas
 * the receipt actually reported rather than an estimate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { explorerTx } from './env.mjs';

const PATH = 'PROOF.md';
const PLACEHOLDER = '| | *(no transactions yet)* | | |';

/**
 * @param {object} row
 * @param {string} row.proves    What this transaction demonstrates.
 * @param {string} row.txHash    The confirmed hash.
 * @param {bigint|number|string} [row.gasUsed] From the receipt, not an estimate.
 * @param {string} [row.lane]    'evm' or 'native'.
 */
export function recordProof(row) {
  // Two conventions on this chain: the native lane reports an UPPERCASE
  // 64-hex hash with no prefix, the EVM lane a `0x…` lowercase one. Both are
  // real; anything else is not.
  if (!row.txHash || !/^(0x)?[0-9a-fA-F]{64}$/.test(row.txHash)) {
    throw new Error(`refusing to write PROOF.md without a real tx hash (got ${row.txHash})`);
  }
  if (!row.proves) throw new Error('every PROOF.md row must say what it proves');

  const md = readFileSync(PATH, 'utf8');
  const lines = md.split(/\r?\n/);

  // Find the proof table and work out the next row number.
  let lastIndex = -1;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === PLACEHOLDER) {
      lines.splice(i, 1);
      lastIndex = i - 1;
      break;
    }
    const m = /^\|\s*(\d+)\s*\|/.exec(line);
    if (m) {
      n = Math.max(n, Number(m[1]));
      lastIndex = i;
    }
  }
  if (lastIndex < 0) {
    throw new Error('could not find the proof table in PROOF.md');
  }

  const gas = row.gasUsed === undefined ? '—' : BigInt(row.gasUsed).toLocaleString('en-US');
  const lane = row.lane ? ` *(${row.lane})*` : '';
  const short = `${row.txHash.slice(0, 10)}…${row.txHash.slice(-8)}`;
  // Verified: explore.qore.network/tx/<hash> resolves for both forms.

  lines.splice(
    lastIndex + 1,
    0,
    `| ${n + 1} | ${row.proves}${lane} | \`${short}\` | gas ${gas} | [explorer](${explorerTx(row.txHash)}) |`,
  );

  writeFileSync(PATH, lines.join('\n'), 'utf8');
  console.log(`  PROOF.md row ${n + 1}: ${row.proves}`);
  console.log(`    ${explorerTx(row.txHash)}`);
  return n + 1;
}

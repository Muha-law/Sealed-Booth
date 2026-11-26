/**
 * Appends a row to PROOF.md the moment a transaction confirms.
 *
 * Project rule: a row is only ever written for a real, confirmed transaction.
 * This helper refuses to write without a transaction hash, and records the gas
 * the receipt actually reported rather than an estimate.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { explorerTx } from './env.mjs';

const PATH = 'PROOF.md';
const LOCK = 'PROOF.md.lock';

/**
 * Cross-process lock.
 *
 * recordProof is read-modify-write, and the trustee processes run concurrently.
 * Without this, three trustees appending at once silently lose rows — it
 * happened: two real releaseShare transactions landed on chain and their rows
 * never reached the file. An O_EXCL lock file is enough; it is the same
 * primitive a mutex would use and needs no dependency.
 */
function withLock(fn) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    let fd;
    try {
      fd = openSync(LOCK, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${LOCK}; delete it if it is stale`);
      }
      // Busy-wait briefly. These writes are rare and short.
      const until = Date.now() + 40;
      while (Date.now() < until) {
        /* spin */
      }
      continue;
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(LOCK);
      } catch {
        /* already gone */
      }
    }
  }
}
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

  return withLock(() => appendRow(row));
}

function appendRow(row) {
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

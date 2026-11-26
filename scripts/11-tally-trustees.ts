/**
 * Tally a closed election by running every trustee as its own OS process.
 *
 *   npx tsx scripts/11-tally-trustees.ts <electionId>
 *
 * Each child gets BOOTH_ONLY_TRUSTEE=<index>, which makes loadEnv strip every
 * other secret — so no process here holds more than one trustee key. Waits for
 * the close first, then reads back and checks the final result.
 *
 * Safe to re-run: each trustee skips a release or a submission it has already
 * made, so a network blip mid-run costs nothing.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Abi, Hex } from 'viem';

// @ts-expect-error - .mjs helper
import { loadEnv, requireEnv } from './lib/env.mjs';
// @ts-expect-error - .mjs helper, no type declarations
import { publicClient } from './lib/evm.mjs';

const ELECTION_ID = BigInt(process.argv[2] ?? '0');
if (ELECTION_ID === 0n) throw new Error('usage: npx tsx scripts/11-tally-trustees.ts <electionId>');

const env = loadEnv();
const CONTRACT = requireEnv(env, 'ELECTION_CONTRACT_ADDRESS') as Hex;
const abi = JSON.parse(readFileSync('out/Election.sol/Election.json', 'utf8')).abi as Abi;
const client = publicClient();
const read = (fn: string, args: readonly unknown[] = []) =>
  client.readContract({ address: CONTRACT, abi, functionName: fn, args });

const election = (await read('getElection', [ELECTION_ID])) as {
  trusteeCount: number;
  threshold: number;
  closeAt: bigint;
  ballotCount: number;
};
const options = (await read('getOptions', [ELECTION_ID])) as readonly string[];
const n = Number(election.trusteeCount);

console.log(`Election ${CONTRACT} #${ELECTION_ID}`);
console.log(`  ${election.ballotCount} ballots, ${election.threshold} of ${n} trustees\n`);

while (await read('isOpen', [ELECTION_ID])) {
  const b = await client.getBlock();
  const left = Number(election.closeAt) - Number(b.timestamp);
  console.log(`  waiting for the close: ${left}s`);
  await new Promise((r) => setTimeout(r, Math.min(Math.max(left, 1), 20) * 1000));
}
console.log('  voting is closed\n');

console.log(`--- spawning ${n} trustee processes, one key each ---`);
const runTrustee = (index: number) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/09-trustee.ts', String(index), String(ELECTION_ID)], {
      stdio: 'inherit',
      shell: true, // resolves npx.cmd on Windows
      env: { ...process.env, BOOTH_ONLY_TRUSTEE: String(index) },
    });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`trustee ${index + 1} exited with code ${code}`)),
    );
    child.on('error', reject);
  });

await Promise.all(Array.from({ length: n }, (_, i) => runTrustee(i)));

console.log('\n--- final result, read from the contract ---');
const [released, threshold, enough] = (await read('releaseStatus', [ELECTION_ID])) as [
  number,
  number,
  boolean,
];
const [totals, counted, agreements] = (await read('finalResult', [ELECTION_ID])) as [
  readonly bigint[],
  Hex,
  number,
];

console.log('\n================ RESULT ================');
options.forEach((o, i) => {
  console.log(`  ${o.padEnd(10)} ${String(totals[i]).padStart(2)}  ${'#'.repeat(Number(totals[i]))}`);
});
console.log(`  agreeing trustees  ${agreements} (threshold ${threshold})`);
console.log(`  shares released    ${released} of ${n} (enough: ${enough})`);
console.log(`  countedBallotIdsHash ${counted}`);
console.log('========================================');

const sum = totals.reduce((a, b) => a + b, 0n);
if (sum !== BigInt(election.ballotCount)) {
  throw new Error(`totals sum to ${sum} but ${election.ballotCount} ballots were cast`);
}
console.log(`\nTotals sum to the ${election.ballotCount} ballots cast.`);

// Copy the ABI out of the Foundry artifact into src/abi/, which IS committed.
//
// out/ is gitignored, so CI and the browser bundle cannot read it. The ABI is
// not a secret and the frontend needs it, so it lives in the repo. Run this
// after any contract change; a test asserts the two stay in step.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const artifact = JSON.parse(readFileSync('out/Election.sol/Election.json', 'utf8'));
mkdirSync('src/abi', { recursive: true });
writeFileSync('src/abi/Election.json', JSON.stringify(artifact.abi, null, 2) + '\n');
console.log(`src/abi/Election.json updated — ${artifact.abi.length} entries`);

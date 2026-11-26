// Compile contracts/*.sol with solc and write artifacts to build/.
// evmVersion is pinned to "paris": QoreChain's EVM support for PUSH0 and
// transient storage has not been verified, so Booth avoids needing either.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contractsDir = join(root, 'contracts');
const outDir = join(root, 'build');

const sources = {};
for (const f of readdirSync(contractsDir).filter((f) => f.endsWith('.sol'))) {
  sources[f] = { content: readFileSync(join(contractsDir, f), 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // createElection takes 7 parameters; the legacy codegen runs out of stack.
    viaIR: true,
    evmVersion: 'paris',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] },
    },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));

let failed = false;
for (const e of out.errors ?? []) {
  console.error(e.formattedMessage);
  if (e.severity === 'error') failed = true;
}
if (failed) process.exit(1);

mkdirSync(outDir, { recursive: true });
let count = 0;
for (const [file, contracts] of Object.entries(out.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts)) {
    writeFileSync(
      join(outDir, `${name}.json`),
      JSON.stringify(
        {
          contractName: name,
          sourceFile: file,
          solcVersion: solc.version(),
          evmVersion: input.settings.evmVersion,
          abi: c.abi,
          bytecode: '0x' + c.evm.bytecode.object,
          deployedBytecode: '0x' + c.evm.deployedBytecode.object,
        },
        null,
        2,
      ) + '\n',
    );
    const size = c.evm.deployedBytecode.object.length / 2;
    console.log(`${name.padEnd(12)} runtime ${String(size).padStart(6)} bytes` +
      (size > 24576 ? '  !! over the 24576-byte EIP-170 limit' : ''));
    count++;
  }
}
console.log(`compiled ${count} contract(s) with solc ${solc.version()}`);

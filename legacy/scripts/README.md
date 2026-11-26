# Superseded scripts

Kept for provenance, not for running. Each produced PROOF.md rows that are
still cited, so deleting them would orphan the record.

| Script | What it was | Why it is here |
|---|---|---|
| `03-run-election.ts` | full election on `legacy/Booth.sol` | Booth published plaintext shares; superseded by Election.sol |
| `04-gas-check.ts` | proved EVM `gasUsed` is a charge, not execution gas | the finding now lives in docs/VERIFIED-FACTS.md |
| `05-measure-evm-gas.ts` | measured Booth's real gas | same |
| `08-run-election-contract.ts` | first Election.sol run, single-process tally | superseded by `10-run-election-v2.ts` (three processes) and by the v2 ballot format |

They are outside `tsconfig.json`'s `include`, so they are not typechecked
against the current `src/core` API — which has moved on. Do not revive one
without porting it.

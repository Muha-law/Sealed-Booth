# Submission checklist

QoreChain "Build Before Q-Day", Encrypted Apps. Checked 2026-11-27.
`[x]` means verified, with how. `[ ]` means still to do, or only you can
confirm it.

## Required

- [x] **Public repository.** https://github.com/Muha-law/Sealed-Booth.
  Checked: `gh repo view --json visibility` returns `PUBLIC`.
- [x] **License.** `LICENSE` at the root holds GitHub's canonical Apache-2.0
  text. It matches `"license": "Apache-2.0"` in `package.json` and the
  `SPDX-License-Identifier: Apache-2.0` header in all five Solidity files
  (`contracts/Election.sol`, `test/solidity/Election.t.sol`, `legacy/Booth.sol`,
  `legacy/BoothHarness.sol`, `probes/PqcProbe.sol`). The TypeScript files carry
  no SPDX header, and none contradicts it.
- [x] **README.** It opens with the live link and a 60-second judge path. Every
  requirement row links its code and a transaction on the current contract;
  the one exception, `TallyMismatch`, is labelled.
- [ ] **Video link.** Pending: record it from [DEMO_SCRIPT.md](DEMO_SCRIPT.md),
  then add the link here and at the top of the README.
- [x] **Testnet addresses.** Listed below. Every one was checked on chain.
- [ ] **Registration complete.** Only you can confirm this, on the submission
  platform.
- [ ] **AI-native box ticked** on the submission form. Only you can confirm
  this.
- [x] **AI_USAGE.md present.** It has a summary for judges (workflow, what was
  generated, what you decided, the bugs Claude Code caught in its own work) and
  the full task log. No placeholders left.

## Testnet addresses

QoreChain testnet `qorechain-diana`, EVM chain id 9800, explorer
https://explore.qore.network.

| What | Address | PROOF.md |
|---|---|---|
| **Election.sol, current**: proof election 3, live demo election 2 | `0xb7d52d7934c5c26a9a8fa623ce3669c5def336e2` | row 50 |
| Election.sol, previous deployment (first with `releaseShare`) | `0x9c9342a166835214f0f9a0c78eba790cc7340255` | row 39 |
| Election.sol, first deployment (election 5, `TallyMismatch`) | `0x8a90db2f3f2192f94a1376c2b51f34f0628b1110` | row 22 |
| Booth.sol, v1, superseded (its election 2 is permanently readable) | `0x3270076bad2329ea3dcf6a43ac4bd40f4aa2b829` | row 12 |
| PqcProbe (precompile evidence) | `0x53a39cf1a1219cb131cf4c60e7f73ab9973679a8` | row 21 |
| Relayer / admin | `qor17kuzprpll7y0qltyz4a37zzxc8pgm6reqg4jm9` · `0xF5B8208c3FfF88F07D64157b1f0846C1c28dE879` | rows 11, 38, 49 |

## Health, as of this check

- [x] Live site: https://muha-law.github.io/Sealed-Booth/.
  `node scripts/check-site.mjs` passed 42 checks with 0 failures, at desktop and
  phone widths, casting real ballots.
- [x] `test` workflow green: forge (58), vitest (57), typecheck.
- [x] `keeper` workflow green. It reads the election key from the creation
  receipt, so it no longer depends on log age.
- [x] Trustees can tally the demo election at any age. A dry run scanned from
  the creation block and found every ballot cast (9 of 9).

## Before judging (6–15 Dec)

- [ ] **Top up the relayer from the faucet before 6 Dec.** It held
  **18.22 QOR** on 27 Nov. This is an estimate from the keeper logs, not a
  measurement over days:
  - Each ballot costs the relayer about 0.31 QOR, the top-up of the next
    invite.
  - Keeping 8 idle invites votable costs about 1.3 QOR a day: windows reopen
    about every 7 hours at about 0.045 QOR each, drawn from invite balances that
    the relayer refills.
  - The keeper stops entirely below a **3 QOR floor**: it exits before
    reopening any window, the run goes red, and demo voting stops. At the rate
    above the balance reaches that floor around **8–9 Dec**, during judging.
  - The keeper logs the balance on every run. Watch the Actions tab.
- [ ] **Invite budget.** 30 identities are allowlisted and 9 have voted, so 21
  remain. The keeper keeps 8 ready at a time. Each recording take and each
  `check-site.mjs` run uses one or two. If they run low: provision more
  identities (fund each and register its ML-DSA-87 key, as
  `scripts/12-provision-invites.ts` does), allowlist them with `addVoters`
  (admin-only, any time before the close), then run the keeper.
- [ ] After recording, add the video link (see above).

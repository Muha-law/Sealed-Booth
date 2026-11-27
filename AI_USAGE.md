# AI_USAGE.md

Running log of how AI was used to build Booth, as the hackathon rules require.
A summary comes first; the dated task log after it is the full record, newest
entry last.

---

## Summary

### The workflow

- **Claude (chat) for strategy and code review.** I worked out what to build
  and why there, wrote each task as a precise request, and reviewed what came
  back.
- **Claude Code for building.** Each task below starts with *What I asked*,
  my request as given. Claude Code wrote the code, tests, scripts and docs,
  ran the deployments and live elections on testnet, and recorded every
  transaction in PROOF.md as it landed.
- **Nothing was taken on trust.** Claims were checked against the live chain,
  in a real browser, or by a test. Where something could not be checked, the
  entry says so under *Could not verify*.

### What was generated

- **Contract:** `contracts/Election.sol` and its 58 Foundry tests; the
  superseded `legacy/Booth.sol`; `probes/PqcProbe.sol`.
- **Client core** (`src/core/`): election key setup and Shamir split, ballot
  sealing and signing, tally, inclusion check, Q-Day simulation, with 57 vitest
  tests.
- **Site** (`web/`): Results, Vote and Q-Day screens.
- **Scripts:** key registration, deployment, live election runs, the
  single-trustee process, invite provisioning, the keeper, and `check-site.mjs`.
- **CI:** the keeper workflow on GitHub Actions and the test workflow.
- **Docs:** README, ARCHITECTURE, VERIFIED-FACTS, PROOF.md, DEMO_SCRIPT.md,
  this file.
- **No cryptography was implemented.** Every primitive comes from the
  QoreChain kits, plus the audited `shamir-secret-sharing`.

### What I decided myself

- **The idea.** A secret ballot whose secrecy has to outlive the cryptography
  protecting it: harvest now, decrypt later, applied to votes.
- **Killing AgentVault.** I dropped my earlier project, AgentVault, and built
  Booth instead. *(your words: why AgentVault was dropped)*
- **The reveal fix.** Booth.sol had trustees publish plaintext shares on chain.
  When the AI proved from chain data that this made Booth.sol election 2
  permanently readable (Task 6), I retired Booth.sol and kept it on chain as
  evidence. I specified `releaseShare` (Task 7): after close only, trustee
  only, once each, every share re-sealed to each trustee's registered key,
  checked against its commitment.
- **Invites over self-generated keys.** A visitor cannot make a usable voter
  identity in the browser on this chain. QoreX rejects the signing calls,
  MetaMask cannot produce the hybrid signature an EVM window needs, and the
  REST endpoints send no CORS headers. So I chose 30 pre-provisioned,
  single-use, allowlisted invite identities (Task 8), published by design.
- **Pages over committed keys.** I approved publishing the demo keys but vetoed
  committing `pool.json`. A keeper committing every 4 hours would have kept
  rewriting history past the deadline. The keeper writes it into the Pages
  artifact only, and its workflow cannot commit (Task 8).
- **Signature inside the envelope.** I specified the v2 ballot (Task 8). The
  ML-DSA-87 signature is sealed inside the envelope and binds the choice, a
  random nonce, the voter's own address, the election, the contract and the
  chain id, never the envelope hash. It is verified at tally against the
  registry key for `ballotVoter()`, so a ballot cannot claim who cast it.
- **Earlier choices:** k-of-n via Shamir with its stated limit (Task 1), and
  no overclaiming in the README (Task 2).

### Bugs Claude Code caught in its own work

Each was found by checking, not by being told.

| Task | Its mistake | How it was caught |
|---|---|---|
| 2→5 | Concluded the PQC precompile was unreachable from contracts, from an `eth_call` state override | Deployed `PqcProbe` and measured: it is reachable. Corrected in PROOF.md and VERIFIED-FACTS |
| 6 | A 90,000 gas limit below the chain's EIP-7623 calldata floor | The chain refused to broadcast; limits now `max(estimate × 1.12, floor × 1.02)` |
| 6 | Let the admin's EVM window run out of blocks mid-run, while its status still read 23 transactions remaining | Diagnosed from the RPC's `details` field; window checks now test `live`, not `remainingTxs` |
| 7 | `submitTally` gas sized for the cheap branch; the finalising branch costs 2.6× | "Reverts" proved to be out of gas by replaying at the parent block |
| 7 | `recordProof` read-modify-write raced across three processes and lost two PROOF.md rows | Recovered from the `ShareReleased` events on chain; writer now locks |
| 8 | Wrote placeholder code into the Vote submit handler | Flagged it itself; `pool.json` lacked the ML-DSA-87 key it needed |
| 8 | `vite.config.mjs` `root: 'web'` made vitest silently find zero tests | Noticed the count, split the configs |
| 8 | Called `fetchPqcStatus` with a `0x` address, which returns HTTP 400 | The first v2 tally failed in all three trustee processes |
| 9 | Results' explorer list included a transaction hash reconstructed from memory, which did not exist | Verified every hash against the chain before shipping |
| 9 | Nav order followed chunk-load order, so a cold load could land on Vote | Caught by the real-browser check on a cold cache |
| 9 | `loadEnv` ignored `process.env` when no `.env` existed, so the keeper would have failed on Actions | Pre-flighted the workflow against a fresh clone with secrets only in the environment; fixed in `08f26a8` with 4 tests |
| 10 | The keeper read the election key with `eth_getLogs`, which reaches only 10,000 blocks; it broke once the election was ~4 h old | The first scheduled run went red |
| 11 | The inclusion check assumed the newest ballot was the voter's; the trustee scanned only the last 9,000 blocks | Audit of every historical read; an interleaving test; a dry tally that found 7 of 7 ballots where the old window saw 2 |
| 12 | "Typecheck clean" was true only on this machine: Node types came from a `node_modules` above the repo | The new CI workflow failed on a clean checkout |
| 12 | PROOF.md labelled the wrong tally submission as the one that finalized | Receipts checked for `ResultFinalized`; corrected in PROOF.md |
| 12 | README requirement rows still pointed at a superseded deployment | Every linked transaction's target contract checked on chain |

### Open items from the log, since resolved

- Task 3, faucet: claimed (Task 4).
- Tasks 5–6, push blocked by READ-only access: resolved; every commit since is
  on GitHub.
- Task 5, Election.sol or Booth.sol: Election.sol (Task 6).
- Task 4, ML-DSA-87 check on chain: moot once Booth.sol was retired. Election.sol
  verifies the signature sealed in the envelope at tally (Task 8).
- Task 7, keeper: built in Task 8, live since Task 9, hardened in Task 10.
- Task 8, Pages unpublished and Q-Day placeholder: both done in Task 9.

---

## 2026-11-25 — Task 1: verify the kits and the chain before writing any code

**What I asked**

Set up Booth per the project brief: ML-KEM-1024 encrypted ballots sealed to a
trustee panel on QoreChain testnet `qorechain-diana` / EVM 9800, using the
official kits only, never inventing chain parameters or message formats.

**What the AI generated**

- Confirmed all seven `@qorechain/*` kits exist on npm (publisher `qorechain`,
  Apache-2.0) and read their READMEs and TypeScript definitions rather than
  assuming APIs.
- Probed the live testnet: native chain id, EVM chain id, active precompiles,
  denom, deployment access control, explorer route.
- Ran a live `eth_call` against the PQC precompile `0x…0A01` with a real
  ML-DSA-87 keypair: a valid signature returns `true`, a one-bit-tampered
  signature returns `false`.
- Ran a local QoreSeal round-trip: sealed a ballot to 5 trustees and confirmed
  each trustee can open it **alone** (1-of-n), and that QoreSeal exports no
  threshold / Shamir / k-of-n primitive.
- Wrote `docs/VERIFIED-FACTS.md` (every verified parameter and how it was
  verified), `.gitignore`, `.env.example`, `PROOF.md` and this log.

**What I changed or decided myself**

The AI stopped and put the two load-bearing decisions to me instead of assuming
them. Both were mine to make:

- **Trustee threshold: k-of-n via Shamir.** QoreSeal alone is 1-of-n, which
  contradicts Booth's core promise, so I accepted one audited non-kit dependency
  (`shamir-secret-sharing`) to split the election key seed k-of-n. All
  encryption stays in QoreSeal; Shamir only splits 32 bytes. I accepted the
  stated limitation that the tallying browser briefly holds the reconstructed
  key, and that the README must say so rather than claim true threshold
  decryption.
- **Ballot path: voter signs in the browser, a relayer submits.** Chosen over
  provisioning every voter with a funded account, a PQC key and an authorisation
  window. Eligibility is enforced on chain by the PQC precompile, so the relayer
  cannot forge or substitute a ballot.
- I rejected nothing the AI proposed, but I did require that it prove the
  k-of-n design before I committed to it, which it did (3 of 5 opens the
  ballots, 2 of 5 fails closed).

**Decided by the AI, flagged for my review**

- Seal mode `hybrid` (ML-KEM-1024 + X25519) as the default rather than
  ML-KEM-only, on the grounds that it is strictly stronger and still satisfies
  the ML-KEM-1024 requirement. The Q-Day screen will show both.
- Splitting the 32-byte seed instead of the 3168-byte decapsulation key.
- `git init` and the repo hygiene files.

**Could not verify**

- Explorer tx page rendering with a real hash (no Booth transaction yet).
- `@qorechain/qoreseal@0.1.0` pins `@qorechain/qoresign@0.1.0` while 0.2.0 is
  current; not yet confirmed whether this resolves to one copy.

---

## 2026-11-25 — Task 2: the Booth contract, and proving what the chain can actually verify

**What I asked**

Go on with the next task: the Booth contract plus the `staticcall` proof that
the previous task flagged as the thing everything else rested on.

**What the AI generated**

- Found that this node supports `eth_call` **state overrides**, and used them to
  run compiled contract bytecode on the real testnet EVM with no deployment and
  no funds. This became the project's main test technique.
- Proved the PQC precompile `0x…0A01` is **not reachable from contract code**:
  it returns success with zero bytes via both `call` and `staticcall`, while
  `sha256`, `ripemd160`, `identity` and `ecrecover` all work from the same
  injected contract. So on-chain ML-DSA-87 verification is off the table.
- Found and ran down a red herring: `ecrecover` returned empty for the
  well-known leaked Hardhat test key, reproducibly, while three freshly
  generated keys recovered fine. This chain appears to refuse recovery for
  publicly compromised keys, and the symptom looks exactly like a signature bug.
- Redesigned eligibility around what the chain can verify: two signatures per
  ballot, secp256k1 checked by the contract at admission, ML-DSA-87 checked by
  every client at tally.
- Wrote `contracts/Booth.sol` (6632 bytes runtime), `contracts/BoothHarness.sol`
  (test only), the `src/core` library (identity, election setup, ballot, tally,
  election-key blob) and 27 tests.
- Cross-checked the TypeScript and Solidity ballot commitments against each
  other **on the live chain** — they agree exactly for several election ids.

**What I changed or decided myself**

- Accepted the redesign. The AI put the trade-off plainly rather than quietly
  shipping a contract that looked like it verified ML-DSA-87 but did not, which
  is the version I would have had to retract in front of judges.
- I require the README to state that admission is classically secured while
  ballot secrecy and the counting rule are post-quantum. No overclaiming.

**Decided by the AI, flagged for my review**

- Ballots seal in QoreSeal's `hybrid` mode (ML-KEM-1024 + X25519) rather than
  ML-KEM alone, since the single 32-byte election seed derives both keys and the
  combined secret is no weaker. The election key therefore goes on chain as a
  1601-byte blob (`src/core/electionKey.ts`), which is Booth's own format.
- Splitting the election *seed* k-of-n rather than the decapsulation key.
- `viaIR: true` in the compiler, because `createElection` has 7 parameters and
  the legacy pipeline ran out of stack.
- Zeroing the election seed and secret keys after splitting, and making identity
  objects redact themselves under `JSON.stringify`/`console.log`.

**Could not verify**

- Anything requiring a funded account: no deployment, no real transaction, no
  gas figure, and so **PROOF.md still has no rows**. Blocked on a funded testnet
  account.
- The precompile result carries one honest caveat: the override address has no
  real Cosmos account, and QoreChain's precompiles are stateful, so they may
  consult chain state for the caller. Standard precompiles work in the identical
  setup, which rules out the override mechanism, but only a deployed contract
  settles it.
- The closed-voting paths (`revealShare` success, share-commitment mismatch,
  ballots refused after close) need either time travel or a real deployment;
  only the "too early" refusal is covered so far.

---

## 2026-11-26 — Task 3: put it on chain (BLOCKED on funding)

**What I asked**

Make it real on qorechain-diana: register 3 trustee ML-KEM keys, deploy
Booth.sol through the relayer path, run one full election end to end, log every
tx in PROOF.md with real gas, and stop on any real error.

**What the AI generated**

Could not start: all five steps need a funded account and there was no `.env`.
Instead it removed every obstacle it could without funds:

- Found the official faucet — <https://dashboard.qorechain.io/faucet>, 100 QOR
  per claim, one per 24 hours, `qor1…` only, **sign-in required**. No kit README
  mentions a faucet; it is documented only in the dashboard docs.
- Caught a trap that would have cost a day: **one mnemonic derives two different
  QoreChain accounts.** `deriveEvmAccount` / qoresign `eth_secp256k1` (coin type
  60) is the unified identity whose `qor1…` and `0x…` are the same 20 bytes;
  `deriveNativeAccount` (coin type 118) is a *separate* account. Funding the
  wrong one puts QOR where the EVM lane cannot spend it, and the faucet only
  pays once per 24 hours.
- Read the live fee parameters (112.5 gwei, `min_gas_price` 0.1 uqor/gas) and
  the PQC module params: `hybrid_signature_mode: required`,
  `allow_classical_fallback: false` — so every native transaction must be
  hybrid-signed.
- Built `scripts/lib/{env,accounts,proof}.mjs`, `scripts/generate-accounts.mjs`
  and `scripts/status.mjs`. Generated nine accounts into `.env` without printing
  a single mnemonic, and ran the preflight against the live chain: it reports
  every balance at zero, no ML-DSA-87 keys, no ML-KEM keys, EVM window closed.
- Gave PROOF.md a gas column; `recordProof()` refuses to write a row without a
  real 32-byte tx hash.

**What I changed or decided myself**

- *(pending — I need to claim the faucet before anything else can run.)*

**Decided by the AI, flagged for my review**

- One faucet claim to the relayer, which then funds the three trustees itself,
  rather than nine separate claims against a 24-hour limit.
- Nine accounts (1 relayer, 3 trustees, 5 voters) so the double-vote attempt has
  a real registered voter behind it.
- Deliberately did **not** write the register/deploy/election scripts blind. The
  PQC bootstrap, window mechanics and hybrid sign-bytes negotiation cannot be
  exercised without funds, and untested chain code would likely be rewritten
  after the first real error.

**Could not verify**

- Every one of the five requested steps. Nothing was sent, so **PROOF.md still
  has no rows** — correctly, rather than holding invented ones.

---

## 2026-11-26 — Task 4: the whole thing, on chain

**What I asked**

Funded the relayer. Register 3 trustee ML-KEM keys, deploy Booth, run one full
election end to end (create, register, 5 ballots, a double-vote attempt
expecting AlreadyVoted, close, trustees tally, final result), log every tx in
PROOF.md with real gas, and stop on any real error.

**What the AI generated**

All of it ran. 21 transactions on `qorechain-diana`, every one in PROOF.md:

- 3 trustees each registered an ML-DSA-87 identity key (with proof of
  possession) and published an ML-KEM-1024 key in the QoreSeal KEM registry,
  with recipient cards verified against the on-chain keys.
- Booth deployed at `0x3270076bad2329ea3dcf6a43ac4bd40f4aa2b829` after opening
  an EVM authorisation window from the native lane.
- Election 2: 5 voters registered, 5 ballots cast, a sixth from voter 1 refused
  on chain with `AlreadyVoted`, 2 of 3 trustees revealed, tally recomputed from
  chain data alone. **hedgehog 3, badger 1, otter 1** — matching the ballots
  cast. All five voters verified their receipts.

Three things it found by not trusting its own numbers:

- **Receipt gas on the EVM lane is fake.** `gasUsed` is exactly half the gas
  limit whatever the work. It proved this by re-sending the same call at a tight
  limit, then re-measured every operation with `eth_estimateGas` and corrected
  PROOF.md so the column cannot mislead. Native-lane gas is real.
- **It had been wrong about the PQC precompile.** Deploying a probe showed
  `pqcVerify` works from contract code (`true` valid, `false` tampered, ~290k
  gas). The earlier "unreachable" finding was an artifact of the `eth_call`
  state override it had used — exactly the caveat it had flagged. It corrected
  VERIFIED-FACTS.md, ARCHITECTURE.md, the contract comment and the test comment,
  keeping both measurements on record.
- The deployed bytecode no longer matched a fresh compile; it showed the
  difference is confined to the 51-byte metadata block, with all 6,579 bytes of
  executable code identical.

**What I changed or decided myself**

- Claimed the faucet. 50 QOR to the relayer, which funded the three trustees
  itself.
- *(open)* Whether to move the ML-DSA-87 check into `castBallot` now that the
  precompile is known to work. It would make admission post-quantum rather than
  secp256k1, at roughly +290k gas per ballot, and costs a redeploy and a re-run.
  The AI left the decision to me rather than redeploying on its own initiative.

**Decided by the AI, flagged for my review**

- 2-of-3 threshold for the demo election, so the k-of-n property is visible.
- Trustee 3 also revealed (3 of 3) purely to get a live call for the gas
  experiment; it is harmless since the threshold was already met.
- A separate measurement election (3) holding no ballots, so `castBallot` could
  be estimated honestly against a voter who had not yet voted.
- 150-second voting window, so the run could wait out the close.

**Could not verify**

- Nothing is left unverified from the five requested steps. Caveats worth
  keeping: the measurement election 3 is left open and empty, election 1 is an
  orphan from my own argument bug (annotated in PROOF.md), and the frontend
  still does not exist.

---

## 2026-11-26 — Task 5: Election.sol with Foundry, and the repo

**What I asked**

Write the election contract in Solidity with Foundry in contracts/ — question,
2 to 6 options, voter allowlist, trustees with registered encryption key
references, threshold k, open/close times, election public key, sealed shares.
createElection by admin; castBallot (allowlist, while open, once, store hash,
emit ciphertext, return ballot id); submitTally (trustees, after close, final
only when k agree); views; the named errors; tests for every rule. Deploy
through an EVM window, verify if the explorer supports it, log it in PROOF.md.

Then: set the GitHub repo as origin, check .gitignore, scan for secrets, commit
in small logical commits and push to main.

**What the AI generated**

- Installed Foundry 1.10.0 (it was not present) and set up `foundry.toml` with
  the compiler and EVM version pinned, forge tests in `test/solidity` so they
  do not collide with the existing vitest suite, and forge-std as a submodule.
- `contracts/Election.sol`, 7,187 bytes runtime. Bulk bytes (ciphertexts, the
  election key, sealed shares) go in events with only commitments stored, per
  the gas measurements. A trustee's encryption key is referenced by the
  keccak256 of its registered ML-KEM-1024 key rather than stored.
- `submitTally` counts agreement: a result is final only when k trustees submit
  identical totals AND the same counted-ballot set. Disagreement yields no
  result rather than a disputed one, and contradicting a final result reverts
  `TallyMismatch`.
- 38 forge tests, all passing, including the four named cases and three fuzz
  properties. The existing 27 vitest tests still pass.
- Deployed to qorechain-diana at `0x8a90db2f3f2192f94a1376c2b51f34f0628b1110`
  through the relayer's EVM window.
- Caught its own false alarm: the deployed runtime did not match the artifact,
  because Solidity patches `immutable` values in at deployment. It read
  `immutableReferences`, confirmed the 40 differing bytes were exactly the admin
  address in its two 32-byte windows, and added a masking comparison.
- Refined its own gas finding again: EVM gas is `max(real, limit/2)`, a
  50%-of-limit floor, not a flat halving. The Election deployment proved it —
  its real cost exceeded the floor and the receipt then reported the truth.
- Established that contract verification is **not possible** on this explorer
  (Blockscout, Etherscan-style and Sourcify all unavailable for chain 9800) and
  recorded reproducibility instead.
- Ten logical commits, origin set, secrets scanned: no mnemonic, key or share
  file is tracked, and it compared every staged file against the nine real
  mnemonics in .env to prove no leak.

**What I changed or decided myself**

- *(open)* The push failed: the authenticated GitHub account has READ only on
  `Muha-law/Sealed-Booth`. I need to authenticate as the repo owner or grant
  write access before it can land.
- *(open)* Election.sol and Booth.sol now both exist and model the tally
  differently. Mine to decide which one the submission presents.

**Decided by the AI, flagged for my review**

- Kept Booth.sol rather than replacing it, since it is deployed and PROOF.md
  cites it. Election.sol is additive.
- Added named errors beyond the six I listed (NotAdmin, BadOptionCount,
  BadThreshold, BadWindow, LengthMismatch, EmptyCiphertext, AlreadySubmitted,
  DuplicateTrustee, ZeroAddress, NotFinalized) so every refusal says why.
- Deployed with a viem script rather than `forge create`, because the latter
  takes the private key as a command-line argument and would put it in the
  process table.
- `finalResult` reverts `NotFinalized` before k agree, with a non-reverting
  `resultStatus` alongside it for a UI.

**Could not verify**

- The push. Blocked on repo permissions; the real 403 is in my notes.
- Contract verification on the explorer — no API exists.
- Election.sol has not been exercised on chain beyond deployment reads
  (`admin()`, `electionCount()`, a `NoSuchElection` revert). Its rules are
  covered by the 38 forge tests, not yet by a live election.
- **There is no RECON.md in this repo.** I referred to it three times; the AI
  mapped it to `docs/VERIFIED-FACTS.md`, which holds the recon it was pointing
  at, and flagged the mismatch rather than inventing a file.

---

## 2026-11-26 — Task 6: Election.sol becomes the submission, live run, push blocked

**What I asked**

Push the 11 commits. Answer whether Booth's revealShare ever put shares or the
election secret on chain in readable form, then make Election.sol the only
contract: move Booth to legacy/, mark its PROOF.md rows superseded, update
ARCHITECTURE.md. Confirm the 3 trustee ML-KEM keys are registered and bound to
their ML-DSA-87 keys. Run one full live election on Election.sol with tight gas
limits. Document that the relayer can censor but not forge, and that every voter
gets a receipt. Commit and push.

**What the AI generated**

- Answered the Booth question with evidence rather than from the source: it read
  `getRevealedShares(2)` off chain, recombined two plaintext shares and
  recovered the 3,168-byte election decapsulation key, matching the hash the
  contract stored. Yes — Booth put the election secret on chain in readable
  form, and election 2's ballot secrecy is gone permanently.
- Restructured: `contracts/` holds only Election.sol, `legacy/` holds Booth and
  its harness, `probes/` holds PqcProbe. Foundry builds the submission; the
  solc-js pipeline was repointed at legacy/ and probes/ so nothing regressed.
- Confirmed all three trustees live on chain: ML-KEM-1024 registered under
  algorithm id 2 (1,568 bytes), ML-DSA-87 registered with possessionProven, and
  each recipient card verifying against both on-chain keys. Already in PROOF.md
  rows 4, 5, 7, 8, 9, 10.
- Ran election 5 on Election.sol end to end: 5 voters each casting their own
  ballot, a refused double vote (AlreadyVoted), a refused early tally
  (StillOpen), 2 trustees agreeing to finalise, a third refused with
  TallyMismatch, and all 5 voters verifying inclusion.
  **hedgehog 3, badger 1, otter 1.** PROOF.md rows 31-37.
- Hit and diagnosed two real failures instead of guessing:
  the admin's EVM window had **expired by block count** (live=false while
  remainingTxs still read 23 — a trap now documented), and a 90,000 gas limit
  fell below the **EIP-7623 calldata floor** for a 1.7 KB ballot. Gas limits are
  now `max(estimate x 1.12, calldataFloor x 1.02)`.
- Documented who can do what: nobody can forge a ballot (msg.sender is the
  voter), the admin can censor only at registration and only visibly, the
  trustees can withhold a result but cannot fake one, and every voter gets a
  receipt that proves inclusion but not correct counting.

**What I changed or decided myself**

- *(blocked)* The push. The authenticated GitHub account has READ only on
  `Muha-law/Sealed-Booth`; the real 403 is in my notes and nothing was pushed.

**Decided by the AI, flagged for my review**

- Kept the 8 PROOF.md rows from four aborted runs of the election script,
  marked "(aborted run)", rather than deleting real transactions. Elections 1-4
  on the contract hold one ballot each and were never tallied.
- Marked all 20 Booth-era rows "(superseded by Election.sol)" in place.
- Stated the receipt's honest limit in the docs: it proves inclusion, not that
  the ballot was counted correctly, since counting happens in the trustees'
  hands.

**Could not verify**

- The push, per above.
- Election.sol source verification — no API on this explorer.
- The four screens still do not exist, and README.md with library credits is
  still unwritten.

---

## 2026-11-26 — Task 7: releaseShare, and trustees in separate processes

**What I asked**

Add releaseShare to Election.sol (trustee only, after close only, once each,
re-sealed to every trustee's registered key, ShareReleased event, commitment
check), forge tests, redeploy, and rerun the live election with each trustee as
a separate process. Keep election 5 on the old contract as the Results proof.
Also fix the stale v1 wording, and tell me the EVM window maximum.

**What the AI generated**

- `releaseShare` as specified, 11 new forge tests (49 total), redeployed to
  `0x9c9342a166835214f0f9a0c78eba790cc7340255`. The previous contract is kept
  in `.env` as `ELECTION_V1_CONTRACT_ADDRESS` so election 5 stays citable.
- Made the process separation **real, not asserted**: each trustee is spawned
  with `BOOTH_ONLY_TRUSTEE=<i>` and `loadEnv` strips every other secret, so a
  trustee process literally cannot read another trustee's key. It demonstrated
  this before relying on it.
- Ran election 1 on the new contract: 5 ballots, refused double vote, refused
  early tally, then three separate processes each released a share, collected
  the others, verified every share against its on-chain commitment, recombined
  and counted independently — all three got hedgehog 3, badger 1, otter 1.
- Measured the window cap honestly: 17,280 blocks at a measured 1.427 s/block =
  **6 h 51 m**, not the ~5 h the SDK README implies. Far short of judging, so a
  keeper is unavoidable.

**Three failures it diagnosed rather than papered over**

- A transient DNS failure mid-run. It confirmed connectivity, read the chain
  state, and resumed instead of restarting the election.
- Two `submitTally` calls "reverted". It proved they were **out of gas**, not
  rejections: `gasUsed` equalled the limit and replay at the parent block
  succeeded. Cause: `submitTally` costs 77k as a plain record and 200k when it
  finalises, trustees land in the same block, so a trustee that estimated as
  "not the k-th" executed as the k-th. Now floored at 320k.
- Two real `releaseShare` rows vanished from PROOF.md — three concurrent
  processes racing on a read-modify-write. It recovered both from the
  `ShareReleased` events on chain and put a lock file around the writer. It
  flagged this in PROOF.md rather than leaving the file quietly short.

**What I changed or decided myself**

- *(pending)* Approved the keeper on GitHub Actions; secret names and the QOR
  budget are mine to action next.

**Decided by the AI, flagged for my review**

- `releaseShare` requires exactly one envelope per trustee so index j is
  unambiguously trustee j's, and stores only a boolean plus a count; envelopes
  live in the event because storing ~5.3 KB would cost millions of gas.
- Extracted `scripts/11-tally-trustees.ts` so the spawn-and-verify path is
  reusable by the demo election rather than throwaway.

**Could not verify**

- Nothing outstanding from this task. 49 forge + 27 vitest passing, typecheck
  clean. The four screens and the keeper are still unbuilt.

---

## 2026-11-26 — Task 8: signature inside the envelope, keeper, Vote screen

**What I asked**

Seal the ML-DSA-87 signature inside the envelope, binding the choice, a random
nonce, the voter's address, electionId, contract and chain id under a fixed
domain tag — not the envelope hash. Verify at tally against the registry key
for ballotVoter. Add the voter-B-replays-voter-A test and a different-election
test. Keep the ML-DSA public key out of the envelope. Measure the new size and
gas and confirm the funding. Switch 09-trustee to tallyBallots, build Vote,
rerun, push. Also: keeper on Actions with Pages, addVoters, 30 invites.

**What the AI generated**

- The v2 ballot format, exactly as specified. The signed message binds the
  voter's own address, which is what defeats the replay; the identity comes
  from the registry and the signature from the ballot, never both from the
  ballot.
- Measured rather than guessed: envelope 6,389 bytes (was 1,747 — the
  4,627-byte signature dominates), calldata 6,500, gas 277,220 where the
  EIP-7623 floor is *exactly* the binding constraint. 0.0419 QOR a ballot plus
  0.045 a window; it raised invite funding to 0.35 for a 4x margin.
- 40 vitest tests including both replays I asked for, plus wrong-key and
  wrong-message variants it added itself.
- `addVoters` with 9 tests, redeployed, and a full election rerun so the live
  contract carries the whole proof.
- 30 invites provisioned, demo election open to 20 Dec, keeper on a 4-hourly
  Actions cron publishing to Pages with no commit — `contents: read` means it
  cannot commit even by accident.
- Vote screen, and it *tested* the path against the real chain rather than
  assuming the build passing meant it worked: demo voter #0 cast a real sealed
  ballot, inclusion verified.

**Three problems it surfaced rather than worked around**

- `fetchPqcStatus` returns HTTP 400 for a `0x` address and needs `qor1`, while
  `fetchKemKey` takes either. Ballots carry `0x`, so the first v2 tally died in
  all three trustee processes with a message that reads like a missing key.
- It had written broken placeholder code into the Vote submit handler and said
  so, rather than leaving it: the page needs the demo identity's ML-DSA-87
  secret key, which pool.json did not carry, because that key derives from a
  mnemonic and not from the secp256k1 key.
- `vite.config.mjs` setting `root: 'web'` silently made vitest find zero tests.

**What I changed or decided myself**

- Approved publishing the demo keys, and vetoed committing pool.json — a keeper
  committing every 4 hours would have polluted history past the deadline, which
  judges check. Pages artifact deploys leave history frozen.

**Decided by the AI, flagged for my review**

- Booth-era scripts moved to `legacy/scripts/` with a README; they use the old
  ballot API and are kept only because they produced cited PROOF.md rows.
- `pool.json` carries both keys per invite, ~84 KB. The master never appears.
- Results points at election 3, not 1: both had the three-process tally, but
  only 3 has signed ballots.

**Could not verify**

- The Q-Day screen is still a placeholder — agreed to come last.
- The Pages site has not been published yet: that needs the two Actions
  secrets and Settings > Pages > Source: GitHub Actions, both mine to do.
- Vote was exercised through its exact code path in node against the live
  chain, not yet clicked in a real browser.

---

## 2026-11-26 — Task 9: Q-Day screen, then testing the live site like a judge

**What I asked**

Build the Q-Day screen to the spec. Then test the live Pages site with
Playwright in a real browser at desktop and phone widths: Results first with
totals and working explorer links, a real vote with a verified receipt, a clean
second attempt, Q-Day's two columns, console errors, and no master mnemonic in
pool.json. Screenshot everything outside the repo, fix what breaks, push.

**What the AI generated**

- The Q-Day screen, with the simulation logic in `src/core/qday.ts` under 5
  tests, because the claim only means anything if the right-hand column
  genuinely fails. It does: every Booth ballot refuses with QoreSeal's own
  error code, which the screen prints rather than captioning it itself.
- `scripts/check-site.mjs`, driving the published site in the system Chrome. It
  casts a REAL ballot rather than stubbing the transaction.

**What it found, and fixed**

- **The landing screen was not reliably Results.** `boot()` imported the three
  screens with `Promise.all` and each registers itself as a side effect, so nav
  order followed whichever chunk arrived first. Stable on a warm cache, wrong
  on a cold one — which is what a first-time judge gets. One run showed
  Results/Q-Day/Vote, another Vote/Q-Day/Results, landing on Vote.
- A `/favicon.ico` 404, the only console error a judge would have seen. The
  checker had nearly hidden it from itself: it filtered console errors on
  message text, and "Failed to load resource" never contains the URL.
- Results carried a single explorer link; it now lists six transactions,
  hardcoded because this node caps `eth_getLogs` at 10,000 blocks and those
  events will be far behind the head by judging week. **The first draft of that
  list contained a hash it had reconstructed from memory, which did not exist
  on chain.** It verified all six against the chain before shipping and
  replaced them from PROOF.md.
- The workflow only ran on schedule and dispatch, so a code fix would have sat
  undeployed for up to four hours. Added a push trigger.

Final run: 42 checks, 0 failures, at both widths.

**What I changed or decided myself**

- Added the secrets and enabled Pages. The first keeper run went green.

**Decided by the AI, flagged for my review**

- Used the system Chrome rather than downloading Playwright's bundled build —
  closer to a judge's browser, and the bundled download had stalled on a stale
  lockfile.
- Testing casts real ballots, so each run consumes demo identities. The keeper
  replaces them.

**Could not verify**

- Nothing outstanding on the site. Not covered: Safari or Firefox, and the
  keeper surviving a multi-day stretch — the first scheduled tick is the real
  test of that.

## 2026-11-27 — Task 10: the first scheduled keeper run failed

**What I asked**

To resume. The AI checked the one thing the last session could not: whether the
keeper survives on its own schedule.

**What it found, and fixed**

- **The first scheduled run (05:34 UTC) went red, and every later run would
  have too.** The keeper opened all 8 windows, then failed to publish
  `pool.json`: it read the election key with `eth_getLogs`, and this node only
  reaches 10,000 blocks (~4 h) back. The election had aged past that. The
  earlier runs passed only because the election was still young. The same limit
  is already documented in `web/chain.ts`, and the keeper had missed it.
  It now reads the key from the creation transaction's receipt
  (`BOOTH_DEMO_ELECTION_TX`, public config in the workflow), which works at any
  age. It also refuses to publish unless the key's keccak256 equals the
  `electionKeyHash` stored on chain.
  Verified: the dry run gets the 1,601-byte key with a matching hash. Given the
  wrong transaction (election 2 on the *older* contract, an easy mix-up) it
  refuses.
- **The Pages deploy in the same run failed separately**, with "No artifacts
  named github-pages", although the upload step had finalized artifact
  15174603426 (141,800 bytes) one second earlier. That is a GitHub-side lag.
  Added one delayed retry of the deploy step.

**Could not verify**

- Whether the retry is enough if GitHub's lag lasts longer than 30 s.

## 2026-11-27 — Task 11: every historical read made age-proof

**What I asked**

Grep for every log read and say whether it survives an election weeks old. Then
fix the inclusion check and the trustee's event scan, test both, and re-verify
the live site.

**What the AI generated**

- **Inclusion check** (`src/core/inclusion.ts`, used by `web/vote.ts`). The
  ballot id now comes from the BallotCast event in the voter's own castBallot
  receipt. Storage must then hold the same ciphertext hash under that id.
  Before, the check took `ballotCount` as "my" ballot, so a vote landing in
  between would show a real ballot as FAILED. `test/inclusion.test.ts` covers
  exactly that case, using real ABI encodings of the event. It also covers
  events from another contract, election or voter, and a receipt with no event
  for this voter, which is refused.
- **Trustee scan** (`scripts/09-trustee.ts`). It now reads events from the
  election's creation block in 9,000-block chunks (`src/core/logRange.ts`,
  tested). The creation block comes from the creation receipt, checked to be
  this election on this contract. Release polling scans only new blocks. Every
  run now checks that the scan found exactly `ballotCount` ballots, ids 1..N,
  each matching `ballotHash` in storage, and refuses to tally otherwise.
  `--dry-run` stops before any transaction.

**Verified**

- Dry tally of demo election 2 (trustee 1): it scanned blocks
  10,808,777..10,833,770 in 3 chunks. All 7 ballots were found and each
  matched storage, with the roll at 30/30 and 3 sealed shares. The old
  last-9,000-blocks window saw only 2 of the 7 ballots and no creation event.

**Could not verify**

- A full decrypting tally of election 2. The contract refuses `releaseShare`
  until it closes on 20 Dec, and recombining shares in one process would
  defeat the trustee separation, so the dry run stops after the scan. The
  three-process tally itself is already proven on election 3.

---

## 2026-11-27 — Task 12: the final proof kit

**What I asked**

A test workflow with a README badge; the live link and a 60-second judge path
at the top of the README; every requirement row checked against the current
contract and live PROOF rows; the keeper in Architecture; two new limitations;
a 3-minute demo script; this summary; a submission checklist; a LICENSE that
matches the SPDX headers. No contract or crypto-core changes.

**What the AI generated, and what checking turned up**

- `.github/workflows/test.yml`: forge, vitest and the typecheck on every push
  and PR, `contents: read`, no secrets. **Its first run failed the typecheck.**
  `@types/node` was never a dependency: tsc had been finding Node types in a
  `node_modules` above the repo, so "typecheck clean" in earlier entries held
  only on this machine. Pinned `@types/node` 22.20.5; CI is green.
- **The README requirement rows pointed at a superseded deployment.** Checked
  on chain, 7 of the 8 Election.sol links went to `0x8a90…`. All now point at
  `0xb7d5…`:
  - ML-KEM: rows 61, 70
  - client-side tally: rows 67-69
  - AlreadyVoted and StillOpen: rows 62, 63
  - The exception is `TallyMismatch`. It has never been triggered on `0xb7d5…`,
    so that row is labelled as the previous deployment and names the Foundry
    test that covers the current code.
  - Also fixed: two links to a script since moved to `legacy/`, stale test
    counts, and "election 2" now names its contract every time. Booth.sol
    election 2 is the broken one; Election.sol election 2 is the live demo.
- **PROOF.md had two kinds of mislabelled rows.** In both three-trustee
  elections it named the wrong submission as the one that finalized. Receipts
  show rows 59 and 68 emitted `ResultFinalized`, not 57/58 and 67. Rows were not
  renumbered, because the README cites them; a *Corrections* section records
  block, transaction index and order. The trustee key registrations marked
  *superseded* are still current: every `trusteeKeyRef` on `0xb7d5…` matches
  the registry, and the registration transactions carry those keys.
- `docs/ARCHITECTURE.md`: the keeper section; the current contract, test count
  and screens (it listed a "Create" screen that does not exist); the measured
  ballot gas; the Booth.sol open decision marked resolved.
- `DEMO_SCRIPT.md`, `SUBMISSION_CHECKLIST.md`, and `LICENSE`: GitHub's
  canonical Apache-2.0 text, matching `package.json` and all five SPDX headers.
- **A review pass on the prose, after the links checked out:**
  - The README's reproducibility line still cited the first deployment's row.
    Re-checked: the code at `0xb7d5…` equals a fresh forge build except the 60
    bytes of the immutable `admin`, and the metadata hash is identical.
  - ARCHITECTURE said the admin "cannot vote for anyone". With `addVoters` it
    can allowlist addresses it controls mid-election and vote with them:
    visible, not prevented. Both docs now say so.
  - The demo script had said a receipt "proves my ballot is counted". It
    proves inclusion, which is what the README's own limitation says.

**What I changed or decided myself**

- *(your words: the AgentVault reason, in the summary above)*

**Could not verify**

- That registration is complete and the AI-native box is ticked: both are on
  the submission platform, and are left for me to tick in the checklist.
- The video, not yet recorded.


# AI_USAGE.md

Running log of how AI was used to build Booth, as the hackathon rules require.
Newest entry last.

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

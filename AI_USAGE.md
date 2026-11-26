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

# Booth architecture

Decided 2026-11-25. Every number here was measured, not estimated — see
`docs/VERIFIED-FACTS.md` for how each chain value was verified.

## What the submission is

**`contracts/Election.sol` is the contract.** It is built and tested with
Foundry (58 tests) and deployed at
`0xb7d52d7934c5c26a9a8fa623ce3669c5def336e2` on EVM chain 9800 (PROOF.md row
50). Two earlier deployments of it, `0x8a90…` and `0x9c93…`, are kept on chain
and labelled as previous in PROOF.md.

`legacy/Booth.sol` is the earlier iteration, kept because it is deployed and
PROOF.md cites its transactions. It is **superseded** and not part of the
submission. `probes/PqcProbe.sol` is deployed diagnostic evidence, not a
product contract.

### Why Booth.sol was retired

Booth's `revealShare` put each trustee's **plaintext** Shamir share into
contract storage and emitted it in an event. That was deliberate — it let
anyone recompute the tally — but it destroys ballot secrecy permanently.
Once k shares are on chain, anyone can recombine them, rebuild the election
ML-KEM-1024 decapsulation key and decrypt every ballot; and because
Booth's `BallotCast` indexes the voter address, every decrypted choice is
linked to the voter who cast it. This was verified, not assumed: reading
`getRevealedShares(2)` off chain returns the plaintext shares, two of them
recombine to the 3,168-byte election secret key, and it matches the
`electionKeyHash` the contract stored. **Election 2 on Booth.sol (`0x3270…`)
has no ballot secrecy and cannot regain it.** This is unrelated to the live
demo, which is election 2 on Election.sol (`0xb7d5…`).

Election.sol fixes this: trustees decrypt off chain and submit only **totals**.
No share and no election key ever reaches the chain, so only the trustees can
open a ballot, and only k of them colluding could deanonymise one.

## Who can do what to a ballot

### Nobody can forge a ballot

In Election.sol a ballot is admitted only from an address on the allowlist,
and the voter is taken from `msg.sender`. Casting a ballot therefore requires
that voter's own secp256k1 key — which the admin, the trustees and any
observer do not have. There is no relayer in the ballot path: each voter sends
their own transaction. **No party can put a ballot in someone else's name.**

### The admin controls the roll, in public

What the admin *can* do is leave an eligible person off the allowlist, or
choose the open and close times. It can also add voters with `addVoters` at any
time **before** the close, not only at creation, so it could allowlist
addresses it controls mid-election and vote with them. All of this is visible
on chain: every addition emits `VoterAllowed` and `isVoter()` is public, so
exclusion is detectable by the excluded voter, and late additions by anyone
comparing the roll over time. Detectable, not prevented. The admin cannot add
voters after the close, cannot cast a ballot in anyone else's name, and cannot
read a ballot — it holds no election key.

The trustees can censor differently: by refusing to submit, they can stop a
result appearing at all. They cannot fake one, because k of them must submit
byte-identical totals and the same counted-ballot set. A single dissenter is
refused with `TallyMismatch` once a result is final.

### Every voter gets a receipt

`castBallot` returns a ballot id, and the contract stores
`keccak256(ciphertext)` against it. A voter keeps that id and the ciphertext
they sealed, then checks inclusion at any time:

```solidity
ballotHash(electionId, ballotId) == keccak256(myCiphertext)   // my exact ballot is on chain
hasVoted(electionId, myAddress)  == true                       // recorded against me
```

Both are public views, so a voter needs nothing but the chain to check, and
the receipt reveals nothing: it is a hash of ciphertext. All five voters in
election 5 on the first deployment verified inclusion this way, and the Vote
screen runs the same check for every browser ballot, taking the ballot id from
the voter's own `BallotCast` receipt.

The honest limit: a receipt proves a ballot was **included**, not that it was
**counted correctly** — the counting happens off chain in the trustees' hands.
What constrains them is that k must agree on both the totals and the exact set
of counted ballot ids, and that set is pinned on chain in the final result.

## The two constraints that shaped this


1. **QoreSeal has no threshold primitive.** Sealing to 5 trustees produces a
   1-of-n envelope: each trustee opens the ballot alone (measured). So "enough
   trustees" has to be built on top of QoreSeal, not inside it.
2. **No browser wallet can submit a QoreChain EVM transaction.** QoreX rejects
   `eth_sendTransaction`; MetaMask cannot produce the hybrid native-lane
   signature that the mandatory EVM authorisation window requires. So the
   ballot cannot be sent by the voter's wallet.

## Key model: one election key, k-of-n seed shares

Ballots seal to a **single election ML-KEM-1024 key**, not to the trustees
directly. The election key's **32-byte seed** is Shamir-split k-of-n; each share
is sealed to one trustee with QoreSeal. At tally time k trustees open their
shares, the seed is recombined, and `sealKeysFromSeed` rebuilds the identical
election key pair.

Splitting the seed rather than the 3168-byte decapsulation key keeps shares at
33 bytes and ballots at one recipient entry instead of n.

Measured, 3-of-5:

| | bytes |
|---|---|
| election seed | 32 |
| election ML-KEM-1024 public key | 1568 |
| ballot envelope (1 recipient, hybrid) | 1754 |
| Shamir share | 33 |
| sealed share (1 recipient, hybrid) | 1753 |

Verified end-to-end: 3 of 5 shares rebuild the exact ML-KEM public key and open
every ballot to the correct tally. 2 of 5 produce a different key and are refused
with `NOT_A_RECIPIENT` — it fails closed.

**The honest limitation, which goes in the README:** the tallying browser briefly
holds the reconstructed election key. This is k-of-n *key recovery*, not true
threshold decryption where the key never exists in one place. Booth must not
claim otherwise.

### Seal mode

`hybrid` (ML-KEM-1024 + X25519) — QoreSeal's default, and strictly stronger than
ML-KEM alone: the shared secret is `SHA3-256` over both, so breaking X25519 does
not help an attacker. The Q-Day screen can also seal in `mode: "mlkem"`
(ML-KEM-1024 only) to show the pure post-quantum envelope side by side.
*My call, not the user's — flagged for review.*

## Ballot path in Election.sol: the voter submits

```
Browser (client-side only)
  encrypt ballot   QoreSeal -> election ML-KEM-1024 key (hybrid + X25519)
        |
        v
The VOTER's own transaction on EVM 9800
  (needs the voter's registered ML-DSA-87 key and a live EVM window)
        |
        v
Election.sol
  msg.sender on the allowlist?  -> else NotAVoter
  already voted?                -> else AlreadyVoted
  within [openAt, closeAt)?     -> else NotOpen
  store keccak256(ciphertext), emit the ciphertext, return a ballot id

After the close, off chain
  each trustee opens its OWN sealed share with its ML-KEM-1024 key
  k shares -> election key -> decrypt the ballots -> totals
        |
        v
Election.sol  submitTally(totals, countedBallotIdsHash)
  final only when k trustees submit byte-identical values
```

No relayer touches a ballot: `msg.sender` *is* the voter, so a ballot cannot be
cast in anyone else's name. The cost is provisioning — every voter needs funding,
a registered ML-DSA-87 key and an EVM authorisation window before they can vote.

## Legacy (Booth.sol): voter signs, relayer submits

*Superseded. Kept because Booth is deployed and PROOF.md cites it.*

```
Browser (client-side only)
  encrypt ballot   QoreSeal -> election ML-KEM-1024 key
  sign commitment  ML-DSA-87  (counted only if this verifies)
  sign commitment  secp256k1   (admission gate the contract can check)
        |
        v
Relayer  submits ciphertext + signature, pays gas
        |  (one funded account: PQC key + authorisation window)
        v
Booth contract on EVM 9800
  ecrecover(secp256k1 sig)  -> address on the roll?
  already voted?            -> reject
  record vote, store commitment, emit envelope + ML-DSA-87 sig

Any client, from the event log
  verify ML-DSA-87 against the roll -> count it or discard it
```

The relayer only ever sees ciphertext and cannot forge a signed ballot: it is a
**liveness** dependency, not a privacy or integrity one. If it censors a ballot,
the voter's receipt check surfaces it.

### Eligibility: how it works today, and the correction behind it

A ballot carries **two signatures over the same commitment**:

| Signature | Verified by | Enforces |
|---|---|---|
| secp256k1 | the contract, via `ecrecover`, at submission | admission: on the roll, has not voted |
| ML-DSA-87 | every client, from the event log, at tally | the post-quantum eligibility proof |

The roll stores each voter's EVM address **and** `keccak256(ML-DSA-87 public
key)`. The contract admits a ballot only from a roll address that has not voted;
the tally counts a ballot only if its ML-DSA-87 signature verifies against that
voter's registered key. A relayer would need a voter's secp256k1 key to get a
ballot admitted *and* their ML-DSA-87 key to get it counted.

**Why two, and the correction.** This shape was chosen because the PQC
precompile appeared to be unreachable from contract code. **That measurement was
wrong** — it used an `eth_call` state override, and QoreChain's precompiles are
stateful, so they decline a caller with no real Cosmos account. A deployed probe
(`contracts/PqcProbe.sol`, `0x53a39cf1a1219cb131cf4c60e7f73ab9973679a8`) shows
`pqcVerify` working from contract code: `true` for a valid ML-DSA-87 signature,
`false` for one flipped bit, about **290,438 gas** per verification.

So the on-chain ML-DSA-87 check **is** available, and the design is weaker than
it needs to be. What runs on chain today (election 2) is the two-signature
version above; moving the ML-DSA-87 check into `castBallot` is a small contract
change, a redeploy and a re-run, and it would make admission itself
post-quantum. See "Open decision" below.

**What today's deployed version does not claim:** admission is classically
secured. Ballot *secrecy* is post-quantum (ML-KEM-1024) and so is the *counting*
rule, but the on-chain admission gate is secp256k1 and would not survive Q-Day.

### Open decision: move the ML-DSA-87 check on chain

*Resolved by retiring Booth.sol.* Election.sol takes the voter from
`msg.sender` and carries the ML-DSA-87 signature sealed inside the ballot
envelope, verified at tally against the key the PQC registry holds for
`ballotVoter()` (see "Ballot path in Election.sol" above). The text below is
kept as the record of the Booth.sol option.

`castBallot` already receives the ML-DSA-87 public key and signature, so the
change is to add one `staticcall` to `0x…0a01` and drop the secp256k1 signature
entirely — the ML-DSA-87 signature over a commitment that already binds chain
id, contract, election, voter key and ciphertext is sufficient on its own.

- Cost: `castBallot` goes from ~384,440 to roughly 675,000 gas.
- Gain: one signature instead of two, and admission becomes post-quantum, which
  is what the category's "ML-DSA key binding" is really asking for.
- Price: a contract change, a redeploy and re-running the election.

### Calldata budget per ballot

ML-DSA-87 public key 2592 B + signature 4627 B + envelope 1754 B ≈ 8973 B.

Planned reduction: the roll stores `keccak256(voterPubkey)` (one word) instead of
the 2592-byte key — storing keys outright would cost ~1.6M gas per voter. The
ballot carries the full key, the contract checks the hash against the roll, then
calls the precompile. Envelopes go in **events**, with only the commitment hash
in storage.

Measured since: a browser-cast ballot carrying the signature inside a
6,387-byte envelope was charged 257,200 gas (PROOF.md row 70; on this chain the
charge is `max(real, limit / 2)`).

## Screens

Results (the landing screen) · Vote · Q-Day. No landing page, no accounts
system. Elections are created by script (`scripts/10-run-election-v2.ts`,
`scripts/12-provision-invites.ts`), not from the page.

## The keeper: keeping the demo votable on GitHub Actions

A judge's browser cannot open an EVM authorisation window (that needs a hybrid
native-lane signature, and the REST endpoints send no CORS headers), and a
window lasts at most 17,280 blocks, about 6 h 51 m. So the demo would go dead
within hours without something reopening windows.

`.github/workflows/keeper.yml` runs `scripts/keeper.mjs` every 4 hours, on
every push to `main` and on demand:

1. reads the demo election from the contract and the relayer's balance;
2. keeps 8 unvoted, allowlisted invite identities ready: reopens each one's
   EVM window and tops up its balance when needed. Nothing is sent when all is
   healthy;
3. reads the election key from the creation transaction's **receipt**
   (`BOOTH_DEMO_ELECTION_TX`), never from `eth_getLogs`, which this node caps at
   10,000 blocks, and refuses to publish unless `keccak256(key)` equals the
   on-chain `electionKeyHash`;
4. writes `pool.json` (the live invites, their single-use keys and the
   election key) into the **Pages artifact only**, checks it carries no master
   mnemonic, builds the site and deploys it.

Secrets: `BOOTH_RELAYER_MNEMONIC` and `BOOTH_INVITES_MNEMONIC` are repository
secrets, masked in the public log. Permissions are `contents: read`, so the
workflow cannot commit. Git history stays frozen at the last human commit.
Runs are serialised so two keepers never race on account sequence numbers.

What a judge's browser reads is all age-proof: contract storage (`getElection`,
`ballotHash`, results), the receipt of the ballot it just sent, and the pinned
transaction hashes in `web/chain.ts`. Nothing on the judge's path or the
keeper's reads event logs.

## Credits owed in the README

`@qorechain/qoreseal`, `@qorechain/qoresign`, `@qorechain/pqc`, `@qorechain/sdk`,
`@qorechain/evm` (+ `viem`), `@qorechain/qorex-rainbowkit`, and
`shamir-secret-sharing` (Privy, Apache-2.0, independently audited, zero
dependency) — the one non-kit dependency, used only to split and recombine
32 bytes. All encryption stays in QoreSeal.

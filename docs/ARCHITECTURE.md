# Booth architecture

Decided 2026-11-25. Every number here was measured, not estimated — see
`docs/VERIFIED-FACTS.md` for how each chain value was verified.

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

## Ballot path: voter signs, relayer submits

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

*Not yet verified: real gas cost of a ballot.*

## Screens

Create · Vote · Results · Q-Day demo. No landing page, no accounts system.

## Credits owed in the README

`@qorechain/qoreseal`, `@qorechain/qoresign`, `@qorechain/pqc`, `@qorechain/sdk`,
`@qorechain/evm` (+ `viem`), `@qorechain/qorex-rainbowkit`, and
`shamir-secret-sharing` (Privy, Apache-2.0, independently audited, zero
dependency) — the one non-kit dependency, used only to split and recombine
32 bytes. All encryption stays in QoreSeal.

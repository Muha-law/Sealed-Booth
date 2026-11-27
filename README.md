# Booth — a secret ballot that stays secret after Q-Day

[![test](https://github.com/Muha-law/Sealed-Booth/actions/workflows/test.yml/badge.svg)](https://github.com/Muha-law/Sealed-Booth/actions/workflows/test.yml)

**Live site: https://muha-law.github.io/Sealed-Booth/**

### Try it in 60 seconds

1. **Open the site.** It lands on **Results**: the proof election (#3), tallied
   by three separate trustee processes, with its final result and explorer
   links to the key transactions behind it.
2. **Click Vote**, pick an option, press **Seal and cast my ballot**. Your
   choice is sealed with ML-KEM-1024 and signed with ML-DSA-87 in your own tab,
   then sent from a pre-provisioned demo identity. The receipt shows
   **Ballot #N — inclusion check passed**, read back from contract storage,
   with an explorer link to your transaction.
3. **Click Q-Day**, press **Fast-forward to 2040**. Ten ballots sealed the
   classical way break open, voter names and all. The same ten sealed by Booth
   stay shut. It is a labelled simulation; the refusals are QoreSeal's own
   error codes.

No wallet, no faucet, no install. Results, ballot counts and your receipt are
read live from the contract.

---

**QoreChain "Build Before Q-Day" — Encrypted Apps.**
Live on QoreChain testnet `qorechain-diana`, EVM chain id **9800**.

Registered voters cast ballots that are encrypted **in the browser** with
ML-KEM-1024 and sealed to a panel of trustees. Only ciphertext goes on chain.
Ballots cannot be opened until voting closes, and not unless **k of n** trustees
take part. One registered voter, one vote. Any voter can check their ballot was
counted.

| | |
|---|---|
| Election contract | [`0xb7d52d7934c5c26a9a8fa623ce3669c5def336e2`](https://explore.qore.network/address/0xb7d52d7934c5c26a9a8fa623ce3669c5def336e2) |
| Proof election | #3 — signed ballots, tallied by **three separate trustee processes**, all reporting *counted 5 of 5, no ballots rejected* |
| Result | hedgehog 3, badger 1, otter 1 |
| Live demo | Election.sol #2, open until 20 Dec — cast a real sealed ballot in the browser |
| Transaction record | [PROOF.md](PROOF.md) — 70 rows, every claim with its tx |
| Measured chain facts | [docs/VERIFIED-FACTS.md](docs/VERIFIED-FACTS.md) |
| Design and trust model | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

---

## The problem

A secret ballot has to keep two promises that pull against each other: nobody
may learn how you voted, and everybody must be able to check the count. Today's
systems keep the first with RSA or elliptic-curve encryption — which a
cryptographically relevant quantum computer breaks retroactively. Ballots
published today as ciphertext are a *harvest-now-decrypt-later* archive: the
tally is already public, but the link from voter to choice becomes readable the
day the maths falls.

Booth's premise is that **ballot secrecy has to outlive the cryptography that
protected it in transit.** So the ciphertext on chain is ML-KEM-1024 (FIPS 203),
the key that opens it never exists in one place while voting is open, and the
identities that authorise everything are ML-DSA-87 (FIPS 204).

## How it works

An election has one ML-KEM-1024 key pair. Ballots seal to its public half.
Its **32-byte seed** is Shamir-split k-of-n and each share is sealed with
QoreSeal to one trustee's *registered* ML-KEM-1024 key, so recovering the
election key needs k trustees. The creator never holds it: the seed is split and
zeroed in the same function that generates it
([`src/core/election.ts`](src/core/election.ts)).

Voting is a window on chain. Each voter seals their choice in their own tab and
submits it themselves — `msg.sender` *is* the voter, so a ballot cannot be cast
in anyone else's name. The contract stores only `keccak256(ciphertext)` and
emits the ciphertext in an event.

After the close each trustee opens its own share with its own ML-KEM key and
**re-seals it to every other trustee's registered ML-KEM-1024 key**, publishing
those envelopes with `releaseShare`. Every entry is ciphertext only its
addressee can open, so trustees can work in separate browsers without pooling
their keys and without any share becoming readable on chain. A trustee holding k
shares recombines the seed locally, decrypts the ballots and submits **totals**.
A result is final only when k trustees submit byte-identical totals *and* the
same counted-ballot set. No share and no election key ever reaches the chain.

A trustee rejects any released share whose plaintext does not match the
`shareCommitment` the contract fixed at creation, so a trustee cannot release
junk undetected.

**Keeping the demo alive.** A browser cannot open an EVM authorisation window
on this chain, and a window lasts under 7 hours. A GitHub Actions
[keeper](.github/workflows/keeper.yml) runs every 4 hours. It reopens windows
for 8 single-use demo identities, checks the election key against the chain,
and publishes `pool.json` into the Pages artifact only, never into git. Design
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-keeper-keeping-the-demo-votable-on-github-actions).

```mermaid
flowchart TB
    subgraph setup["Setup — admin's browser"]
        K["Generate election<br/>ML-KEM-1024 key pair"]
        K --> S["Shamir-split the 32-byte seed<br/>k of n"]
        S --> Z(["Seed and secret key<br/>zeroed — creator keeps nothing"])
        S --> SS["Seal each share to a trustee's<br/>REGISTERED ML-KEM-1024 key"]
    end

    subgraph reg["On chain, before any election"]
        KEM[("QoreSeal KEM registry<br/>trustee ML-KEM-1024 keys")]
        DSA[("PQC registry<br/>trustee ML-DSA-87 identities")]
        CARD["Recipient card:<br/>binds the ML-KEM key to that<br/>ML-DSA-87 identity"]
        DSA --- CARD
        KEM --- CARD
    end

    CARD -.->|"verified before sealing"| SS
    SS --> EC["createElection<br/>key + sealed shares in events"]

    subgraph vote["Voting — each voter's own browser"]
        B["Seal choice with ML-KEM-1024<br/>(hybrid + X25519)"]
        B --> CB["castBallot from the<br/>voter's OWN account"]
    end

    EC --> B
    CB --> CH[("Election.sol<br/>stores the ciphertext hash<br/>emits the ciphertext")]
    CB --> R["Receipt:<br/>ballot id + ciphertext hash"]

    CH --> CLOSE{"closeAt reached?"}
    CLOSE -->|"no"| REJ["StillOpen —<br/>nothing can be opened"]

    subgraph tally["Tally — k trustees, each locally"]
        O["Each trustee opens its OWN share<br/>with its ML-KEM-1024 key"]
        O --> RC["Recombine seed → election key"]
        RC --> D["Decrypt ballots, count"]
    end

    CLOSE -->|"yes"| O
    D --> ST["submitTally(totals, countedBallotIdsHash)"]
    ST --> F{"k identical<br/>submissions?"}
    F -->|"yes"| FIN["Result FINAL"]
    F -->|"no"| NONE["No result —<br/>a dissenter gets TallyMismatch"]
    R -.->|"my hash matches"| FIN
```

## Category requirements, and what proves each one

Every row points at the code that does it and the **transaction** that shows it
happened. Row numbers are [PROOF.md](PROOF.md) rows. Every Election.sol
transaction linked here is on the current contract `0xb7d5…`, except the one
`TallyMismatch` row, which is labelled.

| Requirement | Where it lives | Proof on chain |
|---|---|---|
| **ML-KEM-1024 encryption** | [`src/core/election.ts`](src/core/election.ts) generates the election ML-KEM-1024 key; [`src/core/electionKey.ts`](src/core/electionKey.ts) publishes it; ballots seal in [`src/core/ballot.ts`](src/core/ballot.ts), called from the browser by [`web/vote.ts`](web/vote.ts) | Row **61** — election 3 created with the ML-KEM-1024 key on chain ([tx](https://explore.qore.network/tx/0xc1095741beb2e4ea163541ef38e59993d689c7f1401660e99d87cdefab87877a)) · Row **70** — a ballot sealed in the browser, 6,387 bytes of ciphertext ([tx](https://explore.qore.network/tx/0x1b89e5609f7f1c9e4c2354cdcbec893f2f0c26df1073bc8084cd19a78b0e4ae6)) |
| **Registered recipient keys** | [`scripts/01-register-keys.mjs`](scripts/01-register-keys.mjs) publishes each trustee's ML-KEM-1024 key via QoreSeal's KEM registry message (`algorithm_id: 2`); `Election.sol` stores only the `keccak256` **reference** (`trusteeKeyRef`), resolved against the registry. Every election on `0xb7d5…` references exactly these keys (checked; see PROOF.md *Corrections*) | Rows **5**, **8**, **10** — the three registrations ([t1](https://explore.qore.network/tx/DE8654D700BD4B2EE499E14F151405DBDC9000E5E83949D5A405773BD5240B1F) · [t2](https://explore.qore.network/tx/1CC7849F02A98D4DA3264C60AF7C2B6B6F1EA705FEB88EC73AB1B800C4D85F1D) · [t3](https://explore.qore.network/tx/1332CCB657DD390A911ECBFFC11FA9549DEAD1B38614EBEB51802342351649B3)) |
| **ML-DSA key binding** (voters) | Every ballot carries an ML-DSA-87 signature **sealed inside the envelope** over a message binding the choice, a random nonce, the voter's own address, the election, the contract and the chain id — never the envelope hash. At tally the message is rebuilt from `ballotVoter()` on chain and verified against the key the **PQC registry** holds for that address, so a ballot cannot assert who cast it. [`src/core/ballot.ts`](src/core/ballot.ts), [`src/core/tally.ts`](src/core/tally.ts) | Row **70** — a browser-cast signed ballot ([tx](https://explore.qore.network/tx/0x1b89e5609f7f1c9e4c2354cdcbec893f2f0c26df1073bc8084cd19a78b0e4ae6)) · election 3 rows 61-69, where all three trustees reported "counted 5 of 5, no ballots rejected" |
| **ML-DSA key binding** (trustees) | QoreSeal **recipient cards**: `signRecipientCard` binds the X25519 key and the SHA3-256 of the registered ML-KEM key to the account, signed with its ML-DSA-87 key. `verifyRecipientCard` checks it against the account's **on-chain** ML-DSA-87 *and* ML-KEM keys before anything is sealed — [`scripts/01-register-keys.mjs`](scripts/01-register-keys.mjs), re-verified by every trustee before it seals anything, in [`scripts/09-trustee.ts`](scripts/09-trustee.ts) | Rows **4**, **7**, **9** — ML-DSA-87 identities registered with proof of possession ([t1](https://explore.qore.network/tx/D0DA08E2C8CAC4019829103D2D7063BD93F99834311C837286E6E1AE7D015816) · [t2](https://explore.qore.network/tx/C4EADFC535CB64EB96C292F1DED59AA16942EE923F610342FCB33FC6BDB8DF85) · [t3](https://explore.qore.network/tx/8AB10F925BB3632A01921F9AE1697DFE855C9086DEFF0568ED706D6338EEC5E8)) |
| **Client-side encryption and decryption** | Sealing: [`src/core/ballot.ts`](src/core/ballot.ts) — no network calls, the plaintext choice never leaves the tab. Opening: [`src/core/tally.ts`](src/core/tally.ts) — trustees recombine and decrypt locally. There is no server anywhere in this repo | Rows **67**, **68**, **69** — three trustee processes submit **totals only**; no share or key is ever sent; row 68 finalized the result ([t1](https://explore.qore.network/tx/0x5d01214e5b9f6016df9ff0a100e84b483cc87ec91a903cdb5fb17ec104b5027a) · [t2](https://explore.qore.network/tx/0xb4c7d026494541de03d46363b1117ddace510452a3abf81c30a73671a926cdc6) · [t3](https://explore.qore.network/tx/0x5a327756b45f2cbca1049233bf0cb270eb255f062a117672054c29b56bc8f6f4)) |

Rules enforced on chain, each with a refused transaction to show it:

| Rule | Error | Proof |
|---|---|---|
| One voter, one ballot | `AlreadyVoted` | Row **62**, election 3 ([tx](https://explore.qore.network/tx/0x1010853349e9e3f7ceddb6c3448ad9a290609a833d2aa54bd28685568a0e59a9)) |
| Nothing opens before the close | `StillOpen` | Row **63**, election 3 ([tx](https://explore.qore.network/tx/0xbdb95bd5666644ec77a426f20d63767bfd098b0c6f21bd89e201369824b9ed9d)) |
| A dissenting trustee cannot rewrite a result | `TallyMismatch` | Row **37**, on the **previous** deployment `0x8a90…` ([tx](https://explore.qore.network/tx/0xc8b85a13e727e3af6f41917b82ea79239bfcd98c907f30815d319b15fb57dee2)). No trustee has dissented on `0xb7d5…`; on the current code it is `test_contradicting_a_final_result_reverts_with_TallyMismatch` in [`test/solidity/Election.t.sol`](test/solidity/Election.t.sol), run by CI |

## We broke our own v1

The first contract, `Booth.sol`, had trustees **reveal their shares on chain**
so that anyone could recompute the tally. It worked, it ran a full election, and
it is a privacy failure.

`revealShare` took each trustee's **plaintext** 33-byte Shamir share as calldata,
wrote it into contract storage and emitted it. We verified the consequence
rather than assuming it: reading `getRevealedShares(2)` straight off the chain
returns those plaintext shares, two of them recombine to the **3,168-byte
election ML-KEM-1024 decapsulation key**, and it matches the `electionKeyHash`
the contract had stored. Because `Booth.BallotCast` also *indexes the voter
address*, anybody can now decrypt every ballot in Booth.sol election 2
(contract `0x3270…`) **and** attribute each choice to the voter who cast it.
This is not the live demo, which is election 2 on Election.sol `0xb7d5…`.

The three transactions that did it:

- Row **18** — trustee 1 reveals ([tx](https://explore.qore.network/tx/0xbf380cf9a78ba75f0b2a59bbbcee453818a03f62452946d7b212cd06c3b33faf))
- Row **19** — trustee 2 reveals; two shares are now enough ([tx](https://explore.qore.network/tx/0x91c3225769f14e2300dc50e01791c388f8cf1e37a41b11bcf87bfda8faa55831))
- Row **20** — trustee 3 reveals too ([tx](https://explore.qore.network/tx/0x7d4742b1029fbe6e4a7de3f635c3dd8efff3722a2763c1e27faa343199b8c392))

**Booth.sol election 2 has no ballot secrecy and cannot regain it.** Those five
ballots are permanently readable. We left it on chain and wrote it down instead
of quietly deleting it, because the failure is the most useful thing we learned:
*public verifiability bought with published key material is not ballot secrecy.*

`Election.sol` keeps the shares off chain. Trustees decrypt locally and publish
only totals, pinned to a counted-ballot set that k of them must agree on. The
cost is that you can no longer recompute the tally yourself from chain data —
you check that k independent trustees agreed. That is the trade we chose
deliberately, with the alternative sitting in [`legacy/`](legacy/) as evidence.

## Honest limitations

- **Any trustee who collects k shares can see who voted what.** This is the
  sharpest limit in Booth. `releaseShare` means shares travel as ciphertext
  rather than being published, so the *public* can no longer open ballots — but
  a trustee that gathers k shares holds the election key, ballot ciphertexts are
  public, and `BallotCast` carries the voter's address. It can therefore open
  every ballot and attribute each choice to the voter who cast it. Booth reduces
  ballot secrecy to a k-of-n trustee assumption; it does not remove it.
- **This is k-of-n key *recovery*, not threshold decryption.** The tallying
  machine briefly holds the reconstructed election key. A real threshold scheme
  never assembles it anywhere.
- **You cannot recompute the tally from chain data.** You verify that k trustees
  agreed on identical totals and an identical counted-ballot set. Trustees who
  all lie the same way would not be caught by the contract.
- **A receipt proves inclusion, not correct counting.** `ballotHash()` shows
  your exact ciphertext is on chain; the counting happens off chain.
- **The admin controls the roll.** It chooses the allowlist and the open/close
  times, so it can leave an eligible voter out. This is public (`VoterAllowed`
  events, `isVoter()`), so it is detectable — but it is not prevented.
- **The admin can add voters mid-election.** `addVoters` is admin-only and
  works at any time before the close, so the roll is not frozen when voting
  opens. The real cost: **an admin could allowlist addresses it controls
  mid-election and vote with them.** Each addition emits `VoterAllowed`, so
  ballot stuffing would be visible to anyone comparing the roll over time, but
  nothing stops it. It exists so the demo election's invite pool can be topped
  up.
- **Trustees can stall indefinitely.** Fewer than k submissions means no result.
  There is no timeout or fallback.
- **The Q-Day screen is a simulation, and says so on screen.** No quantum
  computer exists; the adversary is simply handed the classical X25519 private
  keys, which is the honest consequence of one. The refusals shown are
  QoreSeal's own error codes, and the ballots really do open with the correct
  key — but it is a demonstration, not an audit.
- **Voting needs a published demo key.** QoreX rejects
  `eth_sendTransaction`, `personal_sign` and `eth_signTypedData_v4`
  (measured — docs/VERIFIED-FACTS.md), and MetaMask cannot produce the hybrid
  native-lane signature that opening an EVM window needs. Nor can a page reach
  the REST or Tendermint endpoints, which send no CORS headers. So a voter must
  use a pre-provisioned identity whose keys are published in the page.
  **These demo voter keys are public by design**: anyone can read them from
  `pool.json`. Each is single-use, allowlisted only for the demo election, and
  holds a few cents of worthless testnet QOR, and the Vote screen says so
  plainly. But anyone can burn those ballots, and a demo vote proves the
  cryptography, not the voter's identity. The master mnemonic they derive from
  is a repository secret and never leaves the keeper.
- **The contract is not source-verified**, because `explore.qore.network`
  exposes no verification API and Sourcify does not list chain 9800. Instead the
  compiler and settings are pinned and the deployed runtime is checked against
  the Foundry artifact (row 50). Re-checked 2026-11-27: `cast code` at
  `0xb7d5…` equals a fresh `forge build` of this repository except for the 60
  bytes where the immutable `admin` address is patched in. The metadata hash is
  identical, so the source has not changed since deployment.
- **Testnet only.** Nothing here has been audited.

## Credits

Booth is mostly other people's cryptography. Nothing cryptographic was
implemented here.

**QoreChain official kits**

| Package | Version | Used for |
|---|---|---|
| [`@qorechain/qoreseal`](https://github.com/qorechain/qoreseal) | 0.1.0 | ML-KEM-1024 sealing, recipient cards, the KEM registry message |
| [`@qorechain/qoresign`](https://github.com/qorechain/qoresign) | 0.2.0 | ML-DSA-87 identities, hybrid signing, proof of possession |
| [`@qorechain/pqc`](https://github.com/qorechain/qorechain-pqc) | 0.2.3 | FIPS 203 / 204 primitives |
| [`@qorechain/sdk`](https://github.com/qorechain/qorechain-sdk) | 0.14.0 | unified accounts, native-lane signing, EVM window messages |
| [`@qorechain/evm`](https://github.com/qorechain/qorechain-sdk) | 0.14.0 | chain definitions, precompile bindings, window helpers |

All Apache-2.0, © QoreChain Association.

**Other libraries**

| Library | Version | Used for |
|---|---|---|
| [`shamir-secret-sharing`](https://github.com/privy-io/shamir-secret-sharing) (Privy) | 0.0.4 | splitting and recombining the 32-byte election seed — the only non-kit cryptographic dependency, Apache-2.0, independently audited, zero-dependency |
| [`viem`](https://viem.sh) | ^2.58.6 | EVM client and ABI encoding |
| [`@noble/curves`](https://github.com/paulmillr/noble-curves) · [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) · [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) | 2.4.0 | **only** in `src/core/qday.ts`, to model today's X25519-only ballot for the Q-Day comparison. Booth's real ballots never touch them directly — those go through QoreSeal |
| [`@cosmjs/stargate`](https://github.com/cosmos/cosmjs) | 0.39.0 | native-lane broadcasting |
| [`solc`](https://soliditylang.org) | 0.8.28 | legacy and probe contracts |
| [`forge-std`](https://github.com/foundry-rs/forge-std) | v1.17.0 | Solidity tests |
| [`vitest`](https://vitest.dev) · [`tsx`](https://tsx.is) · [`typescript`](https://www.typescriptlang.org) | — | tests and tooling |

Built with [Foundry](https://getfoundry.sh) 1.10.0. QoreSeal's ML-KEM is backed
by [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum).
AI assistance is logged in [AI_USAGE.md](AI_USAGE.md), as the rules require.

## Repository layout

```
contracts/Election.sol      the submission — k-of-n trustee tally
web/                        the site: Results, Vote, Q-Day
src/core/                   sealing, k-of-n shares, tally, inclusion — no DOM
test/solidity/              58 Foundry tests
test/*.test.ts              57 vitest tests, incl. live-EVM contract checks
scripts/                    account setup, registration, deploy, election runs,
                            trustee, keeper, check-site (real-browser check)
.github/workflows/          test (forge, vitest, typecheck) and keeper
legacy/                     Booth.sol and its scripts, superseded (see "We broke our own v1")
probes/PqcProbe.sol         deployed evidence about the PQC precompile
docs/VERIFIED-FACTS.md      every chain fact, measured, with how
docs/ARCHITECTURE.md        design, trust model, the keeper, who can censor what
PROOF.md                    70 transactions, each with what it proves
```

## Running it

```bash
npm install
git submodule update --init --recursive   # forge-std
npm test                                  # 57 vitest
forge test                                # 58 Foundry
npm run typecheck
node scripts/generate-accounts.mjs        # writes .env, prints only addresses
#   fund the printed qor1 address at https://dashboard.qorechain.io/faucet
node scripts/status.mjs                   # preflight: balances, keys, windows
node scripts/01-register-keys.mjs         # trustee ML-DSA-87 + ML-KEM-1024
npx tsx scripts/07-deploy-election.ts     # deploy Election.sol
npx tsx scripts/10-run-election-v2.ts     # one full election, 3 trustee processes
npx tsx scripts/09-trustee.ts 0 2 --dry-run   # a trustee's read-only scan of election 2
node scripts/check-site.mjs               # drive the live site in Chrome (casts a real ballot)
```

Secrets live only in `.env`, which is gitignored. No script ever prints a
mnemonic or a private key.

Licensed under [Apache-2.0](LICENSE).

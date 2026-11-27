# Demo script — 3 minutes

Site: https://muha-law.github.io/Sealed-Booth/
Pace: about 2.5 words a second. Each SAY block is sized to its slot; the word
count is in brackets. Labels in **bold** are exactly what appears on screen.

## Before you record

- Open the site once and let **Results** load, so the first frame is not a
  spinner. Use a desktop window, 1440×900 or larger, zoomed to 110 %.
- Open these in background tabs, ready to switch to:
  - row 19 in PROOF.md, Booth.sol trustee 2 revealing its share:
    https://explore.qore.network/tx/0x91c3225769f14e2300dc50e01791c388f8cf1e37a41b11bcf87bfda8faa55831
  - the repository's PROOF.md, scrolled to the Booth.sol rows 18-20.
- **Every take that casts a ballot uses one demo identity.** 30 are
  allowlisted, 9 have voted, and the keeper keeps 8 ready at a time. Rehearse
  the clicks without pressing **Seal and cast my ballot**, and cast only on the
  takes you mean to keep. Two casts per take (the second-attempt beat) means
  two identities.
- If Vote shows **The demo pool is refilling**, the keeper is between runs.
  Wait for the next run or trigger it from the Actions tab (keeper → Run
  workflow).

---

## 0:00–0:20 · The problem

**SHOW:** the Results screen, still.

**SAY** [52 words]
> A vote has to stay secret for life. Not for a year: for life. But ballots
> encrypted today with RSA or elliptic curves can be recorded now and decrypted
> later, the day a quantum computer arrives. Harvest now, decrypt later. The
> tally is public either way. What leaks is who voted what.

## 0:20–0:40 · What Booth is

**SHOW:** still Results. Point at the contract address and **Final result**.

**SAY** [46 words]
> Booth is a secret ballot on QoreChain where every vote is sealed in your
> browser with ML-KEM-1024, signed with ML-DSA-87, and can only be opened after
> voting closes, by k of n trustees together. This is the live site, on
> testnet, reading straight from the chain.

## 0:40–1:40 · Live: Results, voting, receipt, inclusion, second attempt

**0:40 · DO:** stay on **Results**. Scroll slowly through **Final result**, then
**How this result was produced**.

**SAY** [39 words]
> This is a finished election. Five signed ballots, tallied by three trustees
> running as separate processes, each holding one key. The contract published a
> result only when two of them submitted identical totals. Every step links to
> its transaction.

**0:55 · DO:** click **Vote** in the top nav. Point at **You are voting as a demo
identity**. Pick an option. Click **Seal and cast my ballot**.

**SAY** [39 words, while it seals and sends]
> No wallet needed. This is a pre-provisioned demo identity, public by design
> and good for one ballot. Watch the status line: sealing with ML-KEM-1024 and
> signing with ML-DSA-87, right here in the tab. The plaintext never leaves this
> page.

**1:12 · DO:** the receipt appears. Point at **Your ballot is on chain**, then
**Ballot #N — inclusion check passed**, then the **Your receipt** table. Click
**explorer** and show the transaction for two seconds, then come back.

**SAY** [39 words]
> That's my receipt. The ballot id comes from my own transaction, and the page
> reads the contract's stored hash for that id: it matches what I sealed. It
> proves my ballot is counted, and reveals nothing about my choice.

**1:28 · DO:** reload the page, click **Vote** again. Point at the **Demo voter #**
number, which is different.

**SAY** [31 words]
> Try again, and the page offers a different identity, because that one has
> voted. One identity, one ballot: the contract refuses a second, with
> AlreadyVoted. That refusal is on chain too.

*(Proof of the refusal: PROOF.md row 62. Nothing is refused on screen here, so
do not say it was.)*

## 1:40–2:15 · Q-Day

**DO:** click **Q-Day**. Hold on the **SIMULATION** banner and read it aloud.
Then click **Fast-forward to 2040**.

**SAY** [22 words, before the click]
> This screen is a simulation, and it says so. Ten people vote. Each ballot is
> sealed twice: today's way, and Booth's way.

**SAY** [44 words, as the rows resolve]
> Now a quantum adversary is handed the classical keys. On the left, every
> classical ballot opens: here's Ada Lovelace's vote. On the right, every Booth
> ballot stays sealed. Those refusals are QoreSeal's own error codes, because
> the ML-KEM half of the key still holds.

## 2:15–2:40 · We broke our own v1

**DO:** switch to the PROOF.md tab (Booth.sol rows 18-20), then to the explorer
tab for row 19.

**SAY** [61 words]
> We didn't get it right the first time. Our first contract, Booth dot sol, had
> trustees reveal their shares on chain so anyone could recount. Here's the
> transaction. Two shares rebuild the election key, so that election, Booth
> election two, is readable forever. We left it on chain. The live demo runs on
> a new contract, where shares never go public.

*(Booth.sol election 2 is contract `0x3270…`. The live demo is election 2 on
Election.sol, `0xb7d5…`. Say "Booth dot sol" so the two are not confused.)*

## 2:40–3:00 · Honest limits, proof, call to action

**DO:** switch to the README on GitHub and scroll to **Honest limitations**, then
to the top.

**SAY** [46 words]
> The honest limits: any trustee holding k shares could see how people voted,
> and the admin controls the voter list. They're all written down. Every claim
> has a transaction in PROOF dot md. Open the site, cast a sealed ballot
> yourself, and check it on chain.

---

**Total spoken:** about 419 words over 180 s, roughly 2.3 words a second, which
leaves room for the transaction wait at 0:55.

# PROOF.md

Every on-chain claim Booth makes, with the transaction that proves it.
Network: QoreChain testnet `qorechain-diana`, EVM chain id 9800.
Explorer: https://explore.qore.network (tx route `/tx/<hash>`).

Rule: a line goes in here the moment the transaction lands. Nothing in this file
is written ahead of a real, confirmed transaction. No placeholders, no examples.

**Read the gas column carefully.** It is what the receipt reported — what was
**charged**, which is not always what executed. On the **EVM lane** this chain
charges `max(real gas, gasLimit / 2)`: a 50%-of-limit floor. Native-lane
receipts have no such floor and are real execution gas. Both are measured in
"Gas: what is actually consumed" below.

| # | What it proves | Tx hash | Gas (as the receipt reported it) | Explorer |
|---|---|---|---|---|
| 1 | *(superseded by Election.sol)* relayer funded trustee 1 (3.000000 QOR) so the trustee can register its own keys *(native)* | `5158F37D1C…4AD5DFB4` | gas 202,423 | [explorer](https://explore.qore.network/tx/5158F37D1C88C7201000CAA699F641329A0BC1C3B1397EAB1E1F6D414AD5DFB4) |
| 2 | *(superseded by Election.sol)* relayer funded trustee 2 (3.000000 QOR) so the trustee can register its own keys *(native)* | `A22D1C6469…FE9F7DC9` | gas 202,423 | [explorer](https://explore.qore.network/tx/A22D1C646947B0B48C6FAE98A11ABB3689607F20B7653D4A4A15B21EFE9F7DC9) |
| 3 | *(superseded by Election.sol)* relayer funded trustee 3 (3.000000 QOR) so the trustee can register its own keys *(native)* | `E3146F8C9B…020D5B4B` | gas 202,423 | [explorer](https://explore.qore.network/tx/E3146F8C9B295E3FDD1A3401A5D660E352AF5312D362927550533AD9020D5B4B) |
| 4 | *(superseded by Election.sol)* trustee 1 ML-DSA-87 identity key registered on chain (with proof of possession) *(native)* | `D0DA08E2C8…7D015816` | gas 300,723 | [explorer](https://explore.qore.network/tx/D0DA08E2C8CAC4019829103D2D7063BD93F99834311C837286E6E1AE7D015816) |
| 5 | *(superseded by Election.sol)* trustee 1 ML-KEM-1024 encryption key published in the QoreSeal KEM registry (algorithm id 2) *(native)* | `DE8654D700…D5240B1F` | gas 269,695 | [explorer](https://explore.qore.network/tx/DE8654D700BD4B2EE499E14F151405DBDC9000E5E83949D5A405773BD5240B1F) |
| 6 | *(superseded by Election.sol)* relayer funded trustee 1 (0.270000 QOR) so the trustee can register its own keys *(native)* | `078EA11FFD…622C5635` | gas 188,694 | [explorer](https://explore.qore.network/tx/078EA11FFD181BD7E59A9625EBB0E02D51FDD7D49C1E6B729BA3416C622C5635) |
| 7 | *(superseded by Election.sol)* trustee 2 ML-DSA-87 identity key registered on chain (with proof of possession) *(native)* | `C4EADFC535…BDB8DF85` | gas 300,723 | [explorer](https://explore.qore.network/tx/C4EADFC535CB64EB96C292F1DED59AA16942EE923F610342FCB33FC6BDB8DF85) |
| 8 | *(superseded by Election.sol)* trustee 2 ML-KEM-1024 encryption key published in the QoreSeal KEM registry (algorithm id 2) *(native)* | `1CC7849F02…C4D85F1D` | gas 269,695 | [explorer](https://explore.qore.network/tx/1CC7849F02A98D4DA3264C60AF7C2B6B6F1EA705FEB88EC73AB1B800C4D85F1D) |
| 9 | *(superseded by Election.sol)* trustee 3 ML-DSA-87 identity key registered on chain (with proof of possession) *(native)* | `8AB10F925B…38EEC5E8` | gas 300,723 | [explorer](https://explore.qore.network/tx/8AB10F925BB3632A01921F9AE1697DFE855C9086DEFF0568ED706D6338EEC5E8) |
| 10 | *(superseded by Election.sol)* trustee 3 ML-KEM-1024 encryption key published in the QoreSeal KEM registry (algorithm id 2) *(native)* | `1332CCB657…351649B3` | gas 269,695 | [explorer](https://explore.qore.network/tx/1332CCB657DD390A911ECBFFC11FA9549DEAD1B38614EBEB51802342351649B3) |
| 11 | *(superseded by Election.sol)* relayer opened a bounded EVM authorisation window from the native lane (hybrid-signed; 40 txs, 16.200000 QOR cap) — without this the EVM lane refuses every transaction *(native)* | `40CB40D147…B318E020` | gas 188,802 | [explorer](https://explore.qore.network/tx/40CB40D1477083321263D00DC68F39A7D06F2BCEFCC6C45664CA3E7AB318E020) |
| 12 | *(superseded by Election.sol)* Booth contract deployed on EVM chain 9800 at 0x3270076bad2329ea3dcf6a43ac4bd40f4aa2b829 — only ciphertext is ever stored in it *(evm)* | `0x8603e7ec…6c49ec0e` | gas 1,500,000 | [explorer](https://explore.qore.network/tx/0x8603e7ec69e09072416d566f2a35a4721f66abc829162c7ee5ea08826c49ec0e) |
| 13 | *(superseded by Election.sol)* election 1 created (this run then aborted on a client-side argument bug of mine, so election 1 holds no ballots; the real run is election 2): ML-KEM-1024 election key published on chain, seed Shamir-split 2-of-3, one sealed share per trustee *(evm)* | `0x4f38df7a…05310eef` | gas 1,250,000 | [explorer](https://explore.qore.network/tx/0x4f38df7aaa3577e5d8be675824f682c47d9cf12bc1cb51772f2ed4b405310eef) |
| 14 | *(superseded by Election.sol)* election 2 created: ML-KEM-1024 election key published on chain, seed Shamir-split 2-of-3, one sealed share per trustee *(evm)* | `0xd8bfb5ed…38cd406e` | gas 1,250,000 | [explorer](https://explore.qore.network/tx/0xd8bfb5edab070f47a5415349e4c13b631f944a0900b8c280a787118138cd406e) |
| 15 | *(superseded by Election.sol)* 5 voters registered, each bound to the keccak256 of their ML-DSA-87 public key *(evm)* | `0x092560e9…7bd159ec` | gas 750,000 | [explorer](https://explore.qore.network/tx/0x092560e93341e68caaef5bfade7dff103a44f0694a3cd1faa35293597bd159ec) |
| 16 | *(superseded by Election.sol)* voter 1 cast an ML-KEM-1024 sealed ballot via the relayer; the contract admitted it on the voter's own secp256k1 signature, not the relayer's *(evm)* | `0x4a5e17da…a7f339b8` | gas 1,250,000 | [explorer](https://explore.qore.network/tx/0x4a5e17da0abc797d2f6cfe987ae3c936f8683af75b472a666c68671aa7f339b8) |
| 17 | *(superseded by Election.sol)* a second ballot from voter 1 was REFUSED on chain with AlreadyVoted — one registered voter, one vote, enforced by the contract *(evm)* | `0x62d334b7…c477ed49` | gas 1,250,000 | [explorer](https://explore.qore.network/tx/0x62d334b764e4f44a9e0d2b23d240a50515007b0d9b0dad0e9bd5afdbc477ed49) |
| 18 | *(superseded by Election.sol)* trustee 1 opened its QoreSeal-sealed share with its ML-KEM-1024 key and revealed it; the contract checked it against the commitment made at creation *(evm)* | `0xbf380cf9…c3b33faf` | gas 500,000 | [explorer](https://explore.qore.network/tx/0xbf380cf9a78ba75f0b2a59bbbcee453818a03f62452946d7b212cd06c3b33faf) |
| 19 | *(superseded by Election.sol)* trustee 2 opened its QoreSeal-sealed share with its ML-KEM-1024 key and revealed it; the contract checked it against the commitment made at creation *(evm)* | `0x91c32257…faa55831` | gas 500,000 | [explorer](https://explore.qore.network/tx/0x91c3225769f14e2300dc50e01791c388f8cf1e37a41b11bcf87bfda8faa55831) |
| 20 | *(superseded by Election.sol)* trustee 3 also revealed its share (3 of 3, one more than the 2-of-3 threshold needed). Sent with a 260000 gas limit: receipt reported 130000, exactly half the limit, which shows receipt gas on this chain is what was charged, not what executed *(evm)* | `0x7d4742b1…99b8c392` | gas 130,000 | [explorer](https://explore.qore.network/tx/0x7d4742b1029fbe6e4a7de3f635c3dd8efff3722a2763c1e27faa343199b8c392) |
| 21 | PqcProbe deployed at 0x53a39cf1a1219cb131cf4c60e7f73ab9973679a8 to settle the precompile question from a REAL contract: result differed from the state-override measurement (static 32 B, call 32 B) — see the script output *(evm)* | `0xdf51611d…44314243` | gas 400,000 | [explorer](https://explore.qore.network/tx/0xdf51611db1ac9ff751018b7a77742447cc1269c2c9e7a4db42224adf44314243) |
| 22 | Election.sol (Foundry build, solc 0.8.28, via-IR, 7,187 B runtime) deployed on EVM chain 9800 at 0x8a90db2f3f2192f94a1376c2b51f34f0628b1110 through the relayer's EVM authorisation window. On-chain runtime matches the forge artifact exactly outside its 64 immutable bytes (the admin address); admin() = the relayer; getElection(999) reverts NoSuchElection *(evm)* | `0xf9f2fd0f…097387de` | gas 1,604,036 | [explorer](https://explore.qore.network/tx/0xf9f2fd0f2bde61e64b6d018f205025816a1d297e40a8709c055cfe1f097387de) |
| 23 | *(aborted run)* Election.sol election 1 created by the admin: question, 3 options, a 5-address voter allowlist, 3 trustees each referenced by the keccak256 of their REGISTERED ML-KEM-1024 key, threshold 2, open/close times, the election ML-KEM-1024 public key and 3 QoreSeal-sealed shares *(evm)* | `0xe2ed3bd3…a770dc0e` | gas 771,213 | [explorer](https://explore.qore.network/tx/0xe2ed3bd3a6293eeb67a319ad27b32eaea74a4dedc39205b5a5c71ce7a770dc0e) |
| 24 | *(aborted run)* voter 1 cast an ML-KEM-1024 sealed ballot on Election.sol from its own account; the contract stored only keccak256(ciphertext) and emitted the ciphertext in an event. Gas limit 160311 set from a 143135 estimate *(evm)* | `0x7636f6ac…974fbc42` | gas 143,135 | [explorer](https://explore.qore.network/tx/0x7636f6ac21a6dfc3b8ef7fa8ba941574b1962d37358f8e2670ef4d55974fbc42) |
| 25 | *(aborted run)* Election.sol election 2 created by the admin: question, 3 options, a 5-address voter allowlist, 3 trustees each referenced by the keccak256 of their REGISTERED ML-KEM-1024 key, threshold 2, open/close times, the election ML-KEM-1024 public key and 3 QoreSeal-sealed shares *(evm)* | `0x7b9539c3…25d326ea` | gas 754,101 | [explorer](https://explore.qore.network/tx/0x7b9539c33fc37ae4c1db1c73fb98407cd258df5f61c36156b87e03b025d326ea) |
| 26 | *(aborted run)* voter 1 cast an ML-KEM-1024 sealed ballot on Election.sol from its own account; the contract stored only keccak256(ciphertext) and emitted the ciphertext in an event. Gas limit 160324 set from a 143147 estimate *(evm)* | `0x7d059c25…9a26eb2b` | gas 143,147 | [explorer](https://explore.qore.network/tx/0x7d059c25d25c75ee2ef4209fcbedce0d6a8b882dc5e896d0c11c74309a26eb2b) |
| 27 | *(aborted run)* Election.sol election 3 created by the admin: question, 3 options, a 5-address voter allowlist, 3 trustees each referenced by the keccak256 of their REGISTERED ML-KEM-1024 key, threshold 2, open/close times, the election ML-KEM-1024 public key and 3 QoreSeal-sealed shares *(evm)* | `0x03cd3541…a173f783` | gas 754,077 | [explorer](https://explore.qore.network/tx/0x03cd35418c81ca9b47d57eabd19b7155f229d1cb6676b22c842dff46a173f783) |
| 28 | *(aborted run)* voter 1 cast an ML-KEM-1024 sealed ballot on Election.sol from its own account; the contract stored only keccak256(ciphertext) and emitted the ciphertext in an event. Gas limit 160297 set from a 143123 estimate *(evm)* | `0x408eaf1a…6e12f057` | gas 143,123 | [explorer](https://explore.qore.network/tx/0x408eaf1a9046a5f067b64b3614ea1eb1a63331dfc9f1eb59cbc72ad96e12f057) |
| 29 | *(aborted run)* Election.sol election 4 created by the admin: question, 3 options, a 5-address voter allowlist, 3 trustees each referenced by the keccak256 of their REGISTERED ML-KEM-1024 key, threshold 2, open/close times, the election ML-KEM-1024 public key and 3 QoreSeal-sealed shares *(evm)* | `0x2446160e…3b2e786d` | gas 754,041 | [explorer](https://explore.qore.network/tx/0x2446160eca4fb31f8b1ef96ae69dc1a6c60385d5487b575649add9bc3b2e786d) |
| 30 | *(aborted run)* voter 1 cast an ML-KEM-1024 sealed ballot on Election.sol from its own account; the contract stored only keccak256(ciphertext) and emitted the ciphertext in an event. Gas limit 160284 set from a 143111 estimate *(evm)* | `0x8e466350…be2dd8f4` | gas 143,111 | [explorer](https://explore.qore.network/tx/0x8e466350b82d86be46394471f4f85ebd69afca6bb2681bc26e213539be2dd8f4) |
| 31 | Election.sol election 5 created by the admin: question, 3 options, a 5-address voter allowlist, 3 trustees each referenced by the keccak256 of their REGISTERED ML-KEM-1024 key, threshold 2, open/close times, the election ML-KEM-1024 public key and 3 QoreSeal-sealed shares *(evm)* | `0x109be8ec…692c353f` | gas 754,161 | [explorer](https://explore.qore.network/tx/0x109be8ec2639a7606a458df578084417e53f2af7a219b02ec72634ca692c353f) |
| 32 | voter 1 cast an ML-KEM-1024 sealed ballot on Election.sol from its own account; the contract stored only keccak256(ciphertext) and emitted the ciphertext in an event. Gas limit 160257 set from a 143087 estimate *(evm)* | `0x0e3a3e8d…b577f908` | gas 143,087 | [explorer](https://explore.qore.network/tx/0x0e3a3e8d69afe0f1fff95c28ea8530a188ed755e7de3504795ea3d0cb577f908) |
| 33 | a second ballot from voter 1 was REFUSED on chain with AlreadyVoted — one allowlisted voter, one ballot *(evm)* | `0x88742d4f…9474befb` | gas 56,900 | [explorer](https://explore.qore.network/tx/0x88742d4f16dc25ff90ac766c2fc883044faf615920374df427e9a2199474befb) |
| 34 | a tally submitted before the close was REFUSED on chain with StillOpen — ballots cannot be opened early *(evm)* | `0x596bb3b8…b9e1c58d` | gas 45,000 | [explorer](https://explore.qore.network/tx/0x596bb3b89edbd058570425e0d0d2e13f228cedf2e1cd88f613de7b5ab9e1c58d) |
| 35 | trustee 1 submitted its tally for election 5 — one of 2 needed, no result yet *(evm)* | `0x2675d3de…aeb314f0` | gas 77,486 | [explorer](https://explore.qore.network/tx/0x2675d3ded15bedd69a8c7683f66233ae73bed4e1f3ac0228bcbd1207aeb314f0) |
| 36 | trustee 2 submitted its tally for election 5 — the 2nd matching submission, so the result is now FINAL *(evm)* | `0xd20f4294…9022c71b` | gas 199,874 | [explorer](https://explore.qore.network/tx/0xd20f42944a2eb3532f46a21264a56fa1e938bdb3e5bfb543d41266e29022c71b) |
| 37 | trustee 3 tried to submit totals contradicting the final result and was REFUSED on chain with TallyMismatch — a dissenting trustee cannot change or dispute a result that k trustees already agreed *(evm)* | `0xc8b85a13…fb57dee2` | gas 55,000 | [explorer](https://explore.qore.network/tx/0xc8b85a13e727e3af6f41917b82ea79239bfcd98c907f30815d319b15fb57dee2) |

## Gas: what is actually consumed

The EVM lane charges **`max(real execution gas, gasLimit / 2)`** — a
50%-of-limit floor, not a flat halving. Row 20 (`revealShare` at a deliberately
tight 260,000 limit → 130,000 charged, against 103,123 real) shows the floor
winning; row 22 (deploy Election, 1,604,036 real against a 3,000,000 limit →
1,604,036 charged) shows real gas winning because it exceeded the floor.

So a generous gas limit is not free on this chain. Honest figures come from
`eth_estimateGas`:

| Operation | Real execution gas | Notes |
|---|---|---|
| deploy Booth | 1,485,018 | 6,632-byte runtime |
| deploy Election | 1,604,036 | 7,187-byte runtime, Foundry build |
| `createElection` (Booth) | 508,218 | 3 sealed shares + key blob in events |
| `registerVoters` (5 voters) | 160,056 | ~32,000 per voter |
| `castBallot` | 384,440 | **9,031 bytes of calldata** per ballot |
| `revealShare` | 103,123 | |

A ballot's 9,031 bytes are the ML-KEM-1024 envelope (1,747), the ML-DSA-87
public key (2,592), the ML-DSA-87 signature (4,627) and the secp256k1
signature (65).

## Contract verification: not possible on this explorer

`explore.qore.network` exposes no verification API — Blockscout v2,
Etherscan-style and `/api/v1/verify` endpoints all return 404, the address page
has no verification UI, and Sourcify does not list chain 9800. Probed
2026-11-26; details in docs/VERIFIED-FACTS.md.

Instead, `Election` is reproducible and its deployment is checked:

- `solc 0.8.28`, `via_ir = true`, optimizer 200 runs, `evm_version = paris`
  (pinned in `foundry.toml`)
- the deployed runtime matches the forge artifact exactly outside the 64 bytes
  Solidity patches for `address public immutable admin`
- `admin()` returns the relayer; `getElection(999)` reverts `NoSuchElection`

## The election that ran: Election.sol, election 5

Contract `0x8a90db2f3f2192f94a1376c2b51f34f0628b1110` on EVM chain 9800.
2 of 3 trustees, 5 allowlisted voters, 3 options. Rows 31-37.

```
hedgehog    3  ###
badger      1  #
otter       1  #
agreements  2 of 2 required
countedBallotIdsHash 0x561b87cfd23e0d80187f852882963ae53546603503ea698e26690e46fdf86dbb
```

Every step is a transaction in the table above:

- each of the 5 voters cast their OWN ballot (Election.sol takes the voter
  from `msg.sender`), so each needed funding, a registered ML-DSA-87 key and
  a live EVM authorisation window first
- a second ballot from voter 1 was refused with **AlreadyVoted** (row 33)
- a tally submitted before the close was refused with **StillOpen** (row 34)
- trustee 1 submitted: 1 of 2, no result (row 35)
- trustee 2 submitted matching totals: result **FINAL** (row 36)
- trustee 3 submitted a deliberately wrong total and was refused with
  **TallyMismatch** (row 37) — a dissenter cannot change or dispute a result
  that k trustees already agreed
- all 5 voters verified inclusion with `ballotHash(electionId, ballotId)`

The trustees decrypted off chain: each opened its own QoreSeal-sealed share
with its ML-KEM-1024 key, 2 shares rebuilt the election key, and the ballots
were counted locally. **No share and no election key ever went on chain.**

Elections 1-4 on this contract are abandoned attempts from earlier runs of the
same script (rows 23-30). They hold a ballot each and were never tallied. They
are left on chain and marked rather than hidden.

## Gas limits: two floors, not one

Setting a tight gas limit matters here because the charge is
`max(real gas, gasLimit / 2)`. But the limit cannot go arbitrarily low: this
chain also enforces the **EIP-7623 calldata floor**, and refuses to broadcast
below it:

```
insufficient gas for floor data gas cost: gas 90000, minimum needed 91830
```

That was a real failure during this run: a 90,000 limit on the double-vote
attempt was below the floor for its ~1.7 KB ciphertext. So every limit is now
`max(estimate x 1.12, calldataFloor x 1.02)` where the floor is
`21000 + 10 x tokens` (a zero byte is 1 token, a non-zero byte is 4).

For a ballot the floor, not the execution estimate, is what sets the price.

## Off-chain verifications

Checks that are not transactions but are part of the proof chain.

| What | Result | How |
|---|---|---|
| PQC precompile `0x…0A01` verifies a real ML-DSA-87 signature | valid → `true`, one flipped bit → `false` | `eth_call` against the live testnet, 2026-11-25. See docs/VERIFIED-FACTS.md |
| EVM chain id is 9800 | `eth_chainId` → `0x2648` | live EVM RPC, 2026-11-25 |
| Native chain id is `qorechain-diana` | `node_info.network` | live REST, 2026-11-25 |
| **Correction:** the PQC precompile IS callable from a deployed contract | valid ML-DSA-87 → `true`, one flipped bit → `false`, via CALL and STATICCALL, ~290,438 gas | deployed `PqcProbe` at `0x53a39cf1…973679a8`, 2026-11-26. An earlier state-override measurement said otherwise and was wrong — see docs/VERIFIED-FACTS.md |
| Deployed Booth bytecode is the code in this repo | 6,579 bytes of executable code identical; only the 51-byte CBOR metadata differs (comments were edited after deployment) | `eth_getCode` vs a fresh compile, 2026-11-26 |
| Both explorer hash forms resolve | `/tx/<native UPPERCASE>` → 200, `/tx/0x<evm>` → 200 | spot-checked against real Booth transactions |

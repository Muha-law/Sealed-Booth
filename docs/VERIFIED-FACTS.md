# Verified facts

Every chain parameter, endpoint, address and ABI Booth relies on, with how it was
verified. Project rule: never invent message formats, contract addresses,
precompile addresses or chain parameters. If a value is not in this file, it has
not been verified — do not use it.

Verified 2026-11-25 against the live testnet.

## Kit versions (npm, publisher `qorechain`, Apache-2.0)

| Package | Version |
|---|---|
| `@qorechain/qoreseal` | 0.1.0 |
| `@qorechain/qoresign` | 0.2.0 |
| `@qorechain/pqc` | 0.2.3 |
| `@qorechain/sdk` | 0.14.0 |
| `@qorechain/evm` | 0.14.0 |
| `@qorechain/react` | 0.14.0 |
| `@qorechain/qorex-rainbowkit` | 0.1.0 |

Note: `@qorechain/qoreseal@0.1.0` depends on `@qorechain/qoresign@0.1.0`, while the
latest `qoresign` is 0.2.0. Installing both can produce two copies of qoresign.
Not yet resolved — see "Open questions".

## Network

| Fact | Value | How verified |
|---|---|---|
| Native chain id | `qorechain-diana` | `GET /cosmos/base/tendermint/v1beta1/node_info` → `network` |
| EVM chain id | 9800 (`0x2648`) | `eth_chainId` on the EVM RPC |
| Native REST | `https://api-testnet.qore.host` | SDK `PUBLIC_ENDPOINTS` + live response |
| Native RPC | `https://rpc-testnet.qore.host` | SDK `PUBLIC_ENDPOINTS` |
| EVM RPC | `https://evm-testnet.qore.host` | live `eth_chainId` / `eth_blockNumber` |
| Explorer | `https://explore.qore.network` | HTTP 200, title "QoreChain Explorer" |
| Explorer tx route | `https://explore.qore.network/tx/<hash>` | `/tx/<32-byte hash>` → 200; bogus route → 404 |
| EVM denom | `uqor`; extended `aqor` | `GET /cosmos/evm/vm/v1/params` |
| EVM native currency | QOR, 18 decimals (EVM side) | `@qorechain/evm` README; native base is `uqor` at 10^6 |
| Contract deployment | permissionless | `params.access_control.create` = `ACCESS_TYPE_PERMISSIONLESS` |

Testnet runs chain v3.2.6, mainnet v3.2.5 (`@qorechain/sdk` README, Network reference).

## Active EVM precompiles

From `GET /cosmos/evm/vm/v1/params` → `active_static_precompiles`:

- `0x…0901` CrossVM Bridge
- `0x…0A01` PQC verify
- `0x…0A02` PQC key status
- `0x…0C01` Consensus params

**Doc/chain discrepancy:** the `@qorechain/evm` README says the testnet lists
`0x0A01`, `0x0A02` and `0x0C01`. The chain also lists `0x0901`. The chain is the
source of truth; the extra entry is additive and harmless, but the README is
incomplete. `0x0B01`/`0x0B02` (AI) are **not** active on this testnet — a call to
an inactive precompile returns empty data and the kit helpers then throw.

### `0x…0A01` — PQC verify (tested live)

```
pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool valid)
```

ABI exported as `IQORE_PQC_ABI`; address as `PRECOMPILE_ADDRESSES.pqcVerify`.

Probed via `eth_call` with a real ML-DSA-87 keypair from `@qorechain/pqc`:

- ML-DSA-87 public key: **2592 bytes**; signature: **4627 bytes**
- valid signature → `true`
- one flipped bit in the signature → `false`

This means **a contract can verify a voter's ML-DSA-87 signature on chain.**

### `0x…0A02` — PQC key status

```
pqcKeyStatus(address account) view returns (bool registered, uint256 algorithmId, …)
```

## Funding and the two different `qor1` addresses

**Faucet:** <https://dashboard.qorechain.io/faucet> — 100 QOR per claim, once per
24 hours per account *and* per address, `qor1…` only (it rejects `0x…`), and it
**requires signing in to the dashboard**. Documented at
<https://docs.qorechain.io/dashboard/faucet/>. No faucet is mentioned in any kit
README.

**Trap — one mnemonic gives two different accounts.** Measured 2026-11-26:

| Derivation | Path | Address |
|---|---|---|
| `deriveEvmAccount` / qoresign `eth_secp256k1` | `m/44'/60'/0'/0/i` | the **unified identity** |
| `deriveNativeAccount` / qoresign `secp256k1` | `m/44'/118'/0'/0/i` | a **different account** |

Only the coin-type-60 derivation is the unified identity QoreChain documents —
one 20-byte account rendered as both `qor1…` and `0x…`. Verified:
`toQorAddress(deriveEvmAccount(m).address)` equals the qoresign `eth_secp256k1`
bech32 exactly, while `deriveNativeAccount(m).address` is a different account
whose `toEvmAddress` is a different `0x` too.

**So always fund `toQorAddress(deriveEvmAccount(m).address)`.** Funding the
`deriveNativeAccount` address puts QOR in an account the EVM lane cannot spend,
and with a 24-hour faucet limit that costs a day. Booth derives every account
through `scripts/lib/accounts.mjs`, which only ever uses coin type 60.

## Fees observed on testnet (2026-11-26)

| Fact | Value | Source |
|---|---|---|
| `eth_gasPrice` | `0x1a3185c500` = 112.5 gwei | live EVM RPC |
| feemarket `min_gas_price` | 0.1 | `/cosmos/evm/feemarket/v1/params` |
| feemarket `base_fee` | 0.1 | `/cosmos/evm/feemarket/v1/base_fee` |
| EVM denom | `uqor`, extended `aqor` | `/cosmos/evm/vm/v1/params` |

PQC module params: `hybrid_signature_mode: required`,
`allow_classical_fallback: false`, `min_security_level: 5`,
`default_signature_algo_name: dilithium5` (`/qorechain/pqc/v1/params`). So every
native transaction must be hybrid-signed; there is no classical-only path.

## What a contract on EVM 9800 can call

**CORRECTED 2026-11-26.** An earlier entry here claimed QoreChain's PQC
precompile was unreachable from contract code. **That was wrong.** Both
measurements are below, because the difference between them is the lesson.

### The correct result — from a deployed contract

`contracts/PqcProbe.sol`, deployed at
`0x53a39cf1a1219cb131cf4c60e7f73ab9973679a8`:

| Target | From the deployed contract | Direct `eth_call` |
|---|---|---|
| `0x0a01` pqcVerify, valid ML-DSA-87 signature | **32 bytes, `true`** (CALL and STATICCALL) | 32 bytes, `true` |
| `0x0a01` pqcVerify, one flipped bit | **32 bytes, `false`** | 32 bytes, `false` |
| `0x02` sha256 (control) | 32 bytes | — |

**So a contract on this chain CAN verify ML-DSA-87.** It really verifies — a
tampered signature returns `false`, not an echo.

Cost, by `eth_estimateGas` against the deployed probe:

| | gas |
|---|---|
| `probeCall` → `pqcVerify` (7,460 bytes of calldata) | 313,240 |
| `probeCall` → `sha256` (baseline overhead) | 22,802 |
| **one ML-DSA-87 verification, with its calldata** | **~290,438** |

### The earlier wrong result — and why it was wrong

The first measurement injected the probe's bytecode with an `eth_call`
**state override** instead of deploying it. Under that override, `0x0a01` and
`0x0c01` returned **success with zero bytes** via both CALL and STATICCALL,
while `sha256`, `ripemd160`, `identity` and `ecrecover` all answered normally
from the very same injected contract.

That control is what made the wrong conclusion look safe, and it was not
enough. QoreChain's precompiles are **stateful**: they consult chain state for
the caller, and a state-override address has no real Cosmos account, so they
decline. Standard EVM precompiles are pure and do not care.

**The rule this gives Booth:** a state override is fine for testing pure EVM
behaviour (ecrecover, hashing, the contract's own arithmetic and storage) but
tells you **nothing** about a QoreChain precompile. Those must be tested from a
deployed contract.

### Trap: ecrecover refuses well-known leaked keys

`0x01` returned **empty** — reproducibly, directly and from contract code — for
the publicly leaked Hardhat/Anvil account
`0x70997970C51812dc3A010C7d01b50e0d17dc79C8`, with a valid low-`s`, `v = 28`,
correctly serialised 128-byte input that an independent implementation recovers
correctly. Three freshly generated keys recovered correctly in the same code
path. So ecrecover is sound, but this chain appears to refuse recovery for
well-known compromised keys. **Never use Hardhat/Anvil default keys anywhere in
Booth** — the failure looks exactly like a signature bug.

### Trap: precompile address casing

The kit exports `PRECOMPILE_ADDRESSES.pqcVerify` as `0x…0A01`, which is **not**
EIP-55 checksummed, so Solidity rejects that literal. Use
`0x0000000000000000000000000000000000000a01`; same address.

## Gas reporting on the EVM lane: a 50%-of-limit minimum charge

**REFINED 2026-11-26.** An earlier entry said EVM `gasUsed` is "always exactly
half the gas limit". That was too strong. The actual rule, from every
measurement so far:

> `gasUsed = max(real execution gas, gasLimit / 2)`

The chain charges at least half of whatever limit you set. Evidence:

| Operation | `eth_estimateGas` | limit sent | receipt `gasUsed` | which won |
|---|---|---|---|---|
| deploy Booth | 1,485,018 | 3,000,000 | 1,500,000 | half the limit |
| deploy Election | 1,604,036 | 3,000,000 | **1,604,036** | **real gas** |
| `createElection` | 508,218 | 2,500,000 | 1,250,000 | half the limit |
| `registerVoters` (5) | 160,056 | 1,500,000 | 750,000 | half the limit |
| `castBallot` | 384,440 | 2,500,000 | 1,250,000 | half the limit |
| `revealShare` | 103,123 | 1,000,000 | 500,000 | half the limit |
| `revealShare`, tight limit | 103,123 | 260,000 | 130,000 | half the limit |

The Election deployment is what settled it: its real cost exceeded half the
limit, and the receipt then reported the real figure. So receipts are not
lying — they report what was **charged**, and the charge has a floor.

**Practical consequence: set a tight gas limit.** A generous limit is not free
here; it doubles as a minimum fee. Use `eth_estimateGas` plus a modest margin,
not a round number.

**Native-lane receipts have no such floor** (250,000 → 202,423;
900,000 → 300,723), so native gas is real execution gas.

Honest EVM figures for Booth and Election, by `eth_estimateGas`:

| Operation | real gas |
|---|---|
| deploy Booth | 1,485,018 |
| deploy Election | 1,604,036 |
| `createElection` (Booth, 3 trustees) | 508,218 |
| `registerVoters`, 5 voters | 160,056 |
| `castBallot` (9,031 bytes calldata) | 384,440 |
| `revealShare` | 103,123 |

## Contract verification is not available

Probed 2026-11-26 for `explore.qore.network`:

| Endpoint | Result |
|---|---|
| `/api/v2/smart-contracts/{address}` (Blockscout v2) | 404 |
| `/api?module=contract&action=getabi` (Etherscan-style) | 404 |
| `/api/v1/verify` | 404 |
| `/address/{address}/contract_verifications` | 404 |
| Sourcify support for chain 9800 | not in Sourcify's chain list |

The address page shows no verification UI. **So source verification cannot be
done on this explorer today.** The substitute Booth uses is reproducibility:
pinned compiler and settings (`solc 0.8.28`, `via_ir = true`, optimizer 200
runs, `evm_version = paris`) plus a check that the deployed runtime matches the
build artifact.

### Comparing deployed bytecode when the contract has immutables

Solidity patches `immutable` values into the runtime at deployment, so a plain
byte comparison against the artifact **always fails** for such a contract.
`Election` has `address public immutable admin`, and the artifact's
`immutableReferences` reports it at two 32-byte windows (offsets 323 and 3797).
The 40 differing bytes were exactly the admin address in those windows.

`runtimeMatches()` in `scripts/lib/evm.mjs` masks those windows before
comparing. With them masked, the deployed `Election` matches its forge artifact
exactly.

## Two gas floors, not one

Measured 2026-11-26 while running an election on Election.sol.

A tight gas limit saves money (the charge is `max(real, limit/2)`), but the
limit cannot go below the **EIP-7623 calldata floor**, which this chain
enforces at broadcast:

```
insufficient gas for floor data gas cost: gas 90000, minimum needed 91830
```

The floor is `21000 + 10 x tokens`, where a zero calldata byte is 1 token and
a non-zero byte is 4. For a ballot carrying ~1.7 KB of ciphertext the floor is
about 92,000 gas, well above what the execution itself needs (~45,000). So for
calldata-heavy calls **the floor, not `eth_estimateGas`, sets the minimum.**

Booth sizes every limit as `max(estimate x 1.12, floor x 1.02)`.

## EVM authorisation windows expire by BLOCK COUNT

Measured 2026-11-26. A window opened with `blocks: 17280` (~4.9 hours at this
testnet's ~1.03 s blocks) goes dead when the blocks run out, and the status
then looks like this:

```
found=true  live=false  txs=23  value=11.534400 QOR  blocks=0
```

`remainingTxs` and `remainingValue` are still healthy; only `live` is false.
**Testing `remainingTxs > 0` is therefore wrong — test `live`.** The chain
refuses every EVM transaction from that account, and viem surfaces it as a
bare `-32602 Missing or invalid parameters` from `eth_sendRawTransaction`,
which looks nothing like a window problem. The real text is in the RPC
`details` field:

```
failed to broadcast transaction: the EVM authorisation window for qor1... does
not admit this transaction (remaining: 0 block...)
```

`classifyEvmWindowRejection(err)` from `@qorechain/evm/window` correctly
returns `"exhausted"` for this. Use it rather than reading the message.

## Other node limits## Other node limits

- `eth_getLogs` is capped at a **10,000-block** range: `fromBlock: 'earliest'`
  fails with `maximum [from, to] blocks distance: 10000`.
- `eth_call` **state overrides are supported** on this node.

## QoreSeal (ML-KEM-1024)## QoreSeal (ML-KEM-1024)

| Fact | Value |
|---|---|
| Registry algorithm id for ML-KEM-1024 | `2` (`ALGORITHM_ML_KEM_1024`) |
| ML-KEM-1024 public (encapsulation) key | 1568 bytes |
| ML-KEM-1024 secret (decapsulation) key | 3168 bytes |
| ML-KEM-1024 ciphertext | 1568 bytes |
| Default seal mode | `hybrid` = ML-KEM-1024 + X25519 |
| ML-KEM-1024-only mode | `mode: "mlkem"`, must be chosen explicitly |
| Recipient entry size | hybrid 1664 B, mlkem 1632 B |
| Envelope size | `56 + n × entry + plaintextLength` |
| Max recipients | 1024 |
| KDF info | `"qorechain-kem-v1|" + chainId + "|" + purpose` |
| Envelope text form | `"qoreseal:" + base64url(envelope)`, unpadded |

Registry messages (native lane, Cosmos):

- `/qorechain.pqc.v1.MsgRegisterKEMKey` — `{ sender, algorithm_id: 2, public_key }`; registering again replaces the key
- `/qorechain.pqc.v1.MsgRemoveKEMKey` — `{ sender }`

REST reads:

- `/qorechain/pqc/v1/kem/{address}` — registered ML-KEM key (`fetchKemKey` accepts `qor1…` or `0x…`)
- `/qorechain/pqc/v1/account/{address}` — registered ML-DSA-87 key

### Recipient card = the ML-DSA key binding

`RecipientCard` binds an account's X25519 key and the SHA3-256 of its registered
ML-KEM-1024 key to its address, signed with QoreSign (secp256k1 + ML-DSA-87).
`verifyRecipientCard` checks that signature against the account's **on-chain**
ML-DSA-87 key and its **on-chain** ML-KEM key. This is the category's
"ML-DSA key binding" requirement, served directly by the kit.

### Tested locally: multi-recipient is 1-of-n

`seal()` to 5 trustees → 8414-byte envelope (matches `envelopeSize`), 5 entries.
**Each trustee opened the ballot alone.** A non-recipient is refused with
`NOT_A_RECIPIENT`; a wrong `purpose` with `DECRYPTION_FAILED`.

Epoch keys (`sealEpochKey` / `EpochKeyManager`) are the same shape: the group key
is sealed to every member, so any one member recovers it.

**QoreSeal contains no threshold, Shamir, or k-of-n primitive.** Verified by
reading every exported type in `dist/*.d.ts`.

## EVM write path constraints

From `@qorechain/sdk` and `@qorechain/evm` READMEs:

- An EVM transaction is admitted only from an account that has a **registered
  ML-DSA-87 key** *and* a **live authorisation window**.
- The window is opened by a **native-lane message, hybrid-signed**
  (secp256k1 + ML-DSA-87). A classical key cannot authorise spending alone.
- `openEvmWindowMsg({ sender, blocks, maxTxs, maxValue })`; `blocks` 1…17280,
  `maxTxs` 1…1000, `maxValue` in `uqor` covers **value plus maximum fee**.
- **Opening advances the EVM nonce** (Cosmos sequence *is* the EVM nonce).
  Order: open the window, then read the nonce, then sign the EVM transaction.
- `classifyEvmWindowRejection(err)` → `no-pqc-key` | `no-window` | `exhausted` | `invalid`.
- ~17280 blocks ≈ 5 hours on testnet (~1.03 s blocks).

### QoreX wallet cannot sign EVM transactions

`@qorechain/qorex-rainbowkit` README: QoreX answers only `eth_chainId`,
`eth_accounts`, `eth_requestAccounts` and `wallet_switchEthereumChain`.
`eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4` and
`wallet_addEthereumChain` are **not supported yet** and reject.

Consequence: no browser wallet can submit a QoreChain EVM transaction today —
QoreX cannot sign one, and MetaMask cannot produce the hybrid native-lane
signature the authorisation window requires. EVM writes need a key held by
`@qorechain/sdk` (`deriveEvmAccount` → `privateKey`, `signHybrid` for the
native lane).

## Shamir seed splitting (chosen k-of-n mechanism)

`shamir-secret-sharing@0.0.4` (Privy, Apache-2.0, independently audited, zero
dependency). Used **only** to split and recombine the 32-byte election seed —
never for encryption.

Measured end-to-end, 3-of-5, with `@qorechain/qoreseal`:

| | bytes |
|---|---|
| election seed | 32 |
| Shamir share | 33 |
| sealed share (1 recipient, hybrid) | 1753 |
| ballot envelope (1 recipient, hybrid) | 1754 |

- 3 of 5 shares recombine to the **exact** seed; `sealKeysFromSeed` rebuilds the
  identical ML-KEM-1024 public key and opens every ballot to the correct tally.
- 2 of 5 shares recombine to a **different** seed, producing a different key that
  cannot open a ballot (`NOT_A_RECIPIENT`). It fails closed.

## Open questions

- qoreseal 0.1.0 pins qoresign 0.1.0 while 0.2.0 is current; not yet confirmed
  whether this resolves to a single copy.
- Contract source verification: no API exists on this explorer (see above), so
  reproducibility is the substitute.

Settled since first written, kept here so the record is readable:

- The PQC precompile IS callable from a deployed contract. The earlier
  "unreachable" finding came from an `eth_call` state override and was wrong.
- EVM gas is charged at `max(real, limit/2)`, not always half the limit.
- The explorer `/tx/<hash>` route renders real hashes in both the native
  (uppercase, no prefix) and EVM (`0x`, lowercase) conventions.
- Real gas for every Booth and Election operation is measured above.

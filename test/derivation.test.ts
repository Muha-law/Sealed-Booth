/**
 * The two derivation paths Booth uses must agree.
 *
 * `boothAccount` (QoreSign, eth_secp256k1) and `unifiedAccount`
 * (`deriveUnifiedAccount` from the SDK) are used in different places: the
 * former to address and seal, the latter to sign. If they ever disagreed at a
 * non-zero HD index, the keeper would fund and PQC-register one account while
 * the Vote page published the key of a different one — and provisioning would
 * fail silently for 29 of 30 invites.
 *
 * `deriveUnifiedAccount` also takes a BARE index, not a DerivationOptions
 * object like `deriveNativeAccount` does. Passing `{ accountIndex }` throws.
 * That asymmetry is easy to get wrong, so it is pinned here too.
 */
import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@qorechain/sdk';

// @ts-expect-error - .mjs helper, no type declarations
import { boothAccount, inviteAccount, INVITE_COUNT, INVITE_MAX } from '../scripts/lib/accounts.mjs';
// @ts-expect-error - .mjs helper, no type declarations
import { unifiedAccount } from '../scripts/lib/chain.mjs';

describe('HD derivation agreement', () => {
  it('boothAccount and unifiedAccount agree at every index Booth uses', async () => {
    const mnemonic = generateMnemonic();

    for (const index of [0, 1, 7, 15, 29]) {
      const unified = await unifiedAccount(mnemonic, index);
      const booth = boothAccount(mnemonic, index);

      expect(unified.evm.toLowerCase(), `evm at index ${index}`).toBe(booth.evm.toLowerCase());
      expect(unified.cosmos, `bech32 at index ${index}`).toBe(booth.bech32);
      expect(Buffer.from(unified.pqc.publicKey), `ML-DSA-87 at index ${index}`).toEqual(
        Buffer.from(booth.pqKey.publicKey),
      );
    }
  }, 60_000);

  it('every invite index derives a distinct account', async () => {
    const mnemonic = generateMnemonic();
    const addresses = new Set<string>();

    for (let i = 0; i < INVITE_COUNT; i++) {
      addresses.add(inviteAccount(mnemonic, i).evm.toLowerCase());
    }
    expect(addresses.size).toBe(INVITE_COUNT);
  }, 60_000);

  it('allows indices past the initial batch, so the keeper can top up', () => {
    const mnemonic = generateMnemonic();
    // INVITE_COUNT is only what the one-time script provisions; the keeper
    // provisions beyond it with addVoters as invites are used up.
    expect(INVITE_MAX).toBeGreaterThan(INVITE_COUNT);
    expect(() => inviteAccount(mnemonic, INVITE_COUNT)).not.toThrow();
    expect(() => inviteAccount(mnemonic, INVITE_MAX - 1)).not.toThrow();
  });

  it('refuses an index outside the derivable range', () => {
    const mnemonic = generateMnemonic();
    expect(() => inviteAccount(mnemonic, INVITE_MAX)).toThrow(/invite index must be/);
    expect(() => inviteAccount(mnemonic, -1)).toThrow(/invite index must be/);
  });

  it('is deterministic: the same mnemonic and index give the same account', async () => {
    const mnemonic = generateMnemonic();
    const a = boothAccount(mnemonic, 3);
    const b = boothAccount(mnemonic, 3);
    expect(a.evm).toBe(b.evm);
    expect(a.bech32).toBe(b.bech32);
  });
});

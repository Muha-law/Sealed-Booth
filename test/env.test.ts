/**
 * loadEnv must work with no .env file, because that is exactly the CI case:
 * configuration arrives as repository secrets in process.env.
 *
 * An earlier version returned {} early when the file was missing, which would
 * have made the first keeper run on GitHub Actions report every secret as
 * unconfigured. Caught by pre-flighting the workflow on a fresh clone.
 */
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error - .mjs helper, no type declarations
import { loadEnv } from '../scripts/lib/env.mjs';

const KEY = 'BOOTH_TEST_ONLY_VALUE';

afterEach(() => {
  delete process.env[KEY];
  delete process.env.BOOTH_ONLY_TRUSTEE;
});

describe('loadEnv', () => {
  it('reads process.env when no .env file exists', () => {
    process.env[KEY] = 'from-the-environment';
    const env = loadEnv('definitely-not-a-file.env');
    expect(env[KEY]).toBe('from-the-environment');
  });

  it('lets process.env win over the file', () => {
    process.env[KEY] = 'wins';
    const env = loadEnv('.env.example');
    expect(env[KEY]).toBe('wins');
  });

  it('still reads the file when one exists', () => {
    const env = loadEnv('.env.example');
    // .env.example pins the network, with empty secrets.
    expect(env.QORECHAIN_CHAIN_ID).toBe('qorechain-diana');
    expect(env.QORECHAIN_EVM_CHAIN_ID).toBe('9800');
  });

  it('isolates a trustee process even with no .env file', () => {
    process.env.BOOTH_ONLY_TRUSTEE = '1';
    process.env.BOOTH_TRUSTEE_1_MNEMONIC = 'a';
    process.env.BOOTH_TRUSTEE_2_MNEMONIC = 'b';
    process.env.BOOTH_RELAYER_MNEMONIC = 'c';
    try {
      const env = loadEnv('definitely-not-a-file.env');
      expect(env.BOOTH_TRUSTEE_2_MNEMONIC).toBe('b');
      expect(env.BOOTH_TRUSTEE_1_MNEMONIC).toBeUndefined();
      expect(env.BOOTH_RELAYER_MNEMONIC).toBeUndefined();
    } finally {
      delete process.env.BOOTH_TRUSTEE_1_MNEMONIC;
      delete process.env.BOOTH_TRUSTEE_2_MNEMONIC;
      delete process.env.BOOTH_RELAYER_MNEMONIC;
    }
  });
});

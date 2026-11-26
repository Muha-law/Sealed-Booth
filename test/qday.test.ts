/**
 * The Q-Day simulation must be true, not theatrical. These tests assert the
 * claim the screen makes: handed the recovered classical secret, every
 * classical ballot opens and every Booth ballot refuses.
 */
import { describe, expect, it } from 'vitest';
import {
  attackClassical,
  attackPostQuantum,
  buildSimulation,
  openWithRealKey,
  prepareAttacker,
} from '../src/core/qday.js';

const VOTERS = [
  { name: 'Ada', choice: 'hedgehog' },
  { name: 'Grace', choice: 'badger' },
  { name: 'Alan', choice: 'otter' },
];

describe('Q-Day simulation', () => {
  it('opens every classical ballot with the recovered secret', () => {
    const sim = buildSimulation(VOTERS);
    for (const ballot of sim.ballots) {
      const revealed = attackClassical(ballot.classical, sim.recovered.classicalSecret);
      expect(revealed).toBe(`${ballot.voter.name} voted ${ballot.voter.choice}`);
    }
  }, 60_000);

  it('refuses every Booth ballot, with the same recovered X25519 secret', () => {
    const sim = buildSimulation(VOTERS);
    const attacker = prepareAttacker(sim);
    for (const ballot of sim.ballots) {
      const result = attackPostQuantum(ballot.postQuantum, attacker);
      expect(result.opened, 'the hybrid construction must not yield to a classical key').toBe(
        false,
      );
      if (!result.opened) expect(result.code).toMatch(/DECRYPTION_FAILED|NOT_A_RECIPIENT/);
    }
  }, 60_000);

  it('the Booth ballots are real: they open with the real key', () => {
    const sim = buildSimulation(VOTERS);
    for (const ballot of sim.ballots) {
      expect(openWithRealKey(ballot.postQuantum, sim)).toBe(
        `${ballot.voter.name} voted ${ballot.voter.choice}`,
      );
    }
  }, 60_000);

  it('the attacker really does hold the correct X25519 secret', () => {
    const sim = buildSimulation(VOTERS);
    // Not a straw man: the secret handed over IS Booth's classical half.
    expect(sim.recovered.boothX25519Secret).toEqual(sim.boothKeys.x25519SecretKey);
    expect(sim.boothPublic.mlkemPublicKey).toEqual(sim.boothKeys.mlkemPublicKey);
  }, 60_000);

  it('keeps the names out of both ciphertexts until they are opened', () => {
    const sim = buildSimulation(VOTERS);
    for (const ballot of sim.ballots) {
      const classical = Buffer.from(ballot.classical.ciphertext).toString('latin1');
      const pq = Buffer.from(ballot.postQuantum).toString('latin1');
      expect(classical).not.toContain(ballot.voter.name);
      expect(pq).not.toContain(ballot.voter.name);
    }
  }, 60_000);
});

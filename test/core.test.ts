/**
 * The whole Booth lifecycle, with no chain and no server: set up an election,
 * cast signed ballots, recover the key from k shares, count.
 *
 * Note on keys: every key here is freshly generated. Booth never uses the
 * Hardhat/Anvil default accounts — this chain refuses ecrecover for those
 * well-known leaked keys, and the failure looks exactly like a signature bug
 * (docs/VERIFIED-FACTS.md).
 */
import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@qorechain/sdk';
import { open, seal } from '@qorechain/qoreseal';
import { pqSign } from '@qorechain/qoresign';
import { hexToBytes, keccak256 } from 'viem';
import { setUpElection, recipientOf } from '../src/core/election.js';
import { trusteeFromMnemonic, voterFromMnemonic } from '../src/core/identity.js';
import {
  ballotAad,
  ballotEnvelopeSize,
  ballotSigMessage,
  castBallot,
  decodeBallotPlaintext,
  encodeBallotPlaintext,
  receiptFor,
  type CastBallotArgs,
  type ElectionRef,
} from '../src/core/ballot.js';
import {
  recoverElectionKeys,
  tallyBallots,
  type OnChainBallot,
  type RegistryKeys,
} from '../src/core/tally.js';
import { ELECTION_KEY_BLOB_LENGTH, unpackElectionKey } from '../src/core/electionKey.js';
import {
  BALLOT_PURPOSE,
  SHARE_PURPOSE,
  ML_DSA_87_SIGNATURE_BYTES,
} from '../src/core/constants.js';

const CHAIN_ID = 'qorechain-diana';
const REF: ElectionRef = {
  evmChainId: 9800,
  contract: '0x1111111111111111111111111111111111111111',
  electionId: 7n,
};
const OPTIONS = ['hedgehog', 'badger', 'otter'] as const;

function panel(n: number) {
  return Array.from({ length: n }, () => trusteeFromMnemonic(generateMnemonic()));
}

function openShare(sealed: Uint8Array[], trustees: ReturnType<typeof panel>, i: number) {
  return open({
    chainId: CHAIN_ID,
    purpose: SHARE_PURPOSE,
    envelope: sealed[i]!,
    keys: trustees[i]!.sealKeys,
  });
}

/** An election plus its trustees, ready to cast into. */
async function setup(threshold = 2, trusteeCount = 3) {
  const trustees = panel(trusteeCount);
  const election = await setUpElection({
    chainId: CHAIN_ID,
    trustees: trustees.map((t) => recipientOf(t.sealKeys)),
    threshold,
  });
  const keys = await recoverElectionKeys(
    Array.from({ length: threshold }, (_, i) => openShare(election.sealedShares, trustees, i)),
    keccak256(election.electionPublicKey),
  );
  return { trustees, election, keys };
}

function voter() {
  return voterFromMnemonic(generateMnemonic());
}

function args(
  election: { electionPublicKey: Uint8Array },
  v: ReturnType<typeof voter>,
  choice: string,
  ref: ElectionRef = REF,
): CastBallotArgs {
  return {
    ...ref,
    chainId: CHAIN_ID,
    electionPublicKey: election.electionPublicKey,
    choice,
    voter: v.evmAddress,
    mldsaSecretKey: v.mldsaSecretKey,
  };
}

/**
 * Seal a ballot with an arbitrary signature, so a test can craft the exact
 * mismatch it wants to check. `castBallot` always signs correctly, by design.
 */
function sealWith(
  election: { electionPublicKey: Uint8Array },
  choice: string,
  nonce: Uint8Array,
  signature: Uint8Array,
  ref: ElectionRef,
): Uint8Array {
  return seal({
    chainId: CHAIN_ID,
    purpose: BALLOT_PURPOSE,
    mode: 'hybrid',
    recipients: [unpackElectionKey(election.electionPublicKey)],
    plaintext: encodeBallotPlaintext({ choice, nonce, signature }),
    aad: ballotAad(ref),
  });
}

function registry(voters: ReturnType<typeof voter>[]): RegistryKeys {
  return new Map(voters.map((v) => [v.evmAddress.toLowerCase(), v.mldsaPublicKey]));
}

function roll(voters: ReturnType<typeof voter>[]): Set<string> {
  return new Set(voters.map((v) => v.evmAddress.toLowerCase()));
}

describe('election setup', () => {
  it('publishes an ML-KEM-1024 + X25519 key blob and one sealed share per trustee', async () => {
    const { election } = await setup(3, 5);
    expect(election.electionPublicKey).toHaveLength(ELECTION_KEY_BLOB_LENGTH);
    expect(election.sealedShares).toHaveLength(5);
    expect(election.shareCommitments).toHaveLength(5);

    const recipient = unpackElectionKey(election.electionPublicKey);
    expect(recipient.mlkemPublicKey).toHaveLength(1568);
    expect(recipient.x25519PublicKey).toHaveLength(32);
  });

  it('never hands the creator the election key', async () => {
    const trustees = panel(3);
    const election = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 2,
    });
    expect(Object.keys(election).sort()).toEqual(
      ['electionPublicKey', 'sealedShares', 'shareCommitments', 'threshold', 'trusteeCount'].sort(),
    );
  });

  it('commits to each share so a trustee cannot reveal a junk one', async () => {
    const trustees = panel(3);
    const election = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 2,
    });
    for (let i = 0; i < 3; i++) {
      expect(keccak256(openShare(election.sealedShares, trustees, i))).toBe(
        election.shareCommitments[i],
      );
    }
  });

  it('seals each share so only its own trustee can open it', async () => {
    const trustees = panel(3);
    const election = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 2,
    });
    expect(() =>
      open({
        chainId: CHAIN_ID,
        purpose: SHARE_PURPOSE,
        envelope: election.sealedShares[0]!,
        keys: trustees[1]!.sealKeys,
      }),
    ).toThrow();
  });

  it('rejects an impossible threshold', async () => {
    const trustees = panel(2).map((t) => recipientOf(t.sealKeys));
    await expect(setUpElection({ chainId: CHAIN_ID, trustees, threshold: 3 })).rejects.toThrow(
      /threshold must be an integer in 1\.\.2/,
    );
    await expect(
      setUpElection({ chainId: CHAIN_ID, trustees: [], threshold: 1 }),
    ).rejects.toThrow(/at least one trustee/);
  });
});

describe('threshold', () => {
  it('opens with exactly k shares and refuses with k-1', async () => {
    const trustees = panel(5);
    const election = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 3,
    });
    const hash = keccak256(election.electionPublicKey);

    const three = [4, 0, 2].map((i) => openShare(election.sealedShares, trustees, i));
    await expect(recoverElectionKeys(three, hash)).resolves.toBeDefined();

    const two = [4, 0].map((i) => openShare(election.sealedShares, trustees, i));
    await expect(recoverElectionKeys(two, hash)).rejects.toThrow(/do not rebuild/);
  });

  it('refuses shares from a different election', async () => {
    const trustees = panel(3);
    const recipients = trustees.map((t) => recipientOf(t.sealKeys));
    const a = await setUpElection({ chainId: CHAIN_ID, trustees: recipients, threshold: 2 });
    const b = await setUpElection({ chainId: CHAIN_ID, trustees: recipients, threshold: 2 });

    const sharesOfB = [0, 1].map((i) => openShare(b.sealedShares, trustees, i));
    await expect(recoverElectionKeys(sharesOfB, keccak256(a.electionPublicKey))).rejects.toThrow(
      /different election/,
    );
  });
});

describe('ballot plaintext codec', () => {
  it('round-trips', () => {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const signature = crypto.getRandomValues(new Uint8Array(ML_DSA_87_SIGNATURE_BYTES));
    const encoded = encodeBallotPlaintext({ choice: 'hedgehog', nonce, signature });
    const decoded = decodeBallotPlaintext(encoded);

    expect(decoded.choice).toBe('hedgehog');
    expect(decoded.nonce).toEqual(nonce);
    expect(decoded.signature).toEqual(signature);
  });

  it('does not carry the voter ML-DSA public key', () => {
    const v = voter();
    const encoded = encodeBallotPlaintext({
      choice: 'otter',
      nonce: new Uint8Array(32),
      signature: new Uint8Array(ML_DSA_87_SIGNATURE_BYTES),
    });
    // The 2592-byte public key must be nowhere in the plaintext.
    expect(encoded.length).toBe(2 + 5 + 32 + ML_DSA_87_SIGNATURE_BYTES);
    const hay = Buffer.from(encoded).toString('latin1');
    expect(hay.includes(Buffer.from(v.mldsaPublicKey.slice(0, 32)).toString('latin1'))).toBe(false);
  });

  it('rejects malformed input', () => {
    const nonce = new Uint8Array(32);
    const signature = new Uint8Array(ML_DSA_87_SIGNATURE_BYTES);
    expect(() => encodeBallotPlaintext({ choice: '', nonce, signature })).toThrow(/1\.\.255/);
    expect(() =>
      encodeBallotPlaintext({ choice: 'x', nonce: new Uint8Array(31), signature }),
    ).toThrow(/nonce must be 32/);
    expect(() =>
      encodeBallotPlaintext({ choice: 'x', nonce, signature: new Uint8Array(10) }),
    ).toThrow(/signature must be 4627/);

    expect(() => decodeBallotPlaintext(new Uint8Array([9, 1, 65]))).toThrow(/unsupported/);
    expect(() => decodeBallotPlaintext(new Uint8Array([2, 1, 65]))).toThrow(/must be/);
  });
});

describe('signed message binding', () => {
  it('changes with every bound field, and not with the envelope', () => {
    const v = voter();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const base = { ...REF, voter: v.evmAddress, choice: 'hedgehog', nonce };
    const message = ballotSigMessage(base);

    expect(ballotSigMessage({ ...base, choice: 'badger' })).not.toBe(message);
    expect(ballotSigMessage({ ...base, electionId: 8n })).not.toBe(message);
    expect(ballotSigMessage({ ...base, evmChainId: 9801 })).not.toBe(message);
    expect(
      ballotSigMessage({ ...base, contract: '0x2222222222222222222222222222222222222222' }),
    ).not.toBe(message);
    expect(ballotSigMessage({ ...base, voter: voter().evmAddress })).not.toBe(message);
    expect(
      ballotSigMessage({ ...base, nonce: crypto.getRandomValues(new Uint8Array(32)) }),
    ).not.toBe(message);

    // Same inputs, same message. Nothing envelope-derived is involved.
    expect(ballotSigMessage({ ...base })).toBe(message);
  });

  it('refuses a wrong-length nonce', () => {
    const v = voter();
    expect(() =>
      ballotSigMessage({ ...REF, voter: v.evmAddress, choice: 'x', nonce: new Uint8Array(16) }),
    ).toThrow(/nonce must be 32/);
  });
});

describe('ballots and tally', () => {
  it('counts the ballots it should', async () => {
    const { election, keys } = await setup();
    const choices = ['hedgehog', 'badger', 'hedgehog', 'otter', 'hedgehog'];
    const voters = choices.map(() => voter());

    const ballots: OnChainBallot[] = choices.map((choice, i) => {
      const v = voters[i]!;
      const sealed = castBallot(args(election, v, choice));
      return { ballotId: BigInt(i + 1), voter: v.evmAddress, ciphertext: sealed.envelope };
    });

    const result = tallyBallots({
      ...REF,
      chainId: CHAIN_ID,
      options: OPTIONS,
      ballots,
      roll: roll(voters),
      registryKeys: registry(voters),
      keys,
    });

    expect(result.rejected).toEqual([]);
    expect(result.counted).toBe(5);
    expect(Object.fromEntries(result.counts)).toEqual({ hedgehog: 3, badger: 1, otter: 1 });
    expect(result.countedBallotIds).toEqual([1n, 2n, 3n, 4n, 5n]);
  }, 60_000);

  it('reports every option, including ones nobody picked', async () => {
    const { election, keys } = await setup();
    const v = voter();
    const sealed = castBallot(args(election, v, 'badger'));
    const result = tallyBallots({
      ...REF,
      chainId: CHAIN_ID,
      options: OPTIONS,
      ballots: [{ ballotId: 1n, voter: v.evmAddress, ciphertext: sealed.envelope }],
      roll: roll([v]),
      registryKeys: registry([v]),
      keys,
    });
    expect(Object.fromEntries(result.counts)).toEqual({ hedgehog: 0, badger: 1, otter: 0 });
  }, 30_000);

  it('keeps the choice and the signature unreadable in the ciphertext', async () => {
    const { election } = await setup();
    const v = voter();
    const sealed = castBallot(args(election, v, 'hedgehog'));
    const text = Buffer.from(sealed.envelope).toString('latin1');
    for (const option of OPTIONS) expect(text).not.toContain(option);
  }, 30_000);

  it('a voter can check their own ballot landed', async () => {
    const { election } = await setup();
    const v = voter();
    const a = args(election, v, 'otter');
    const sealed = castBallot(a);
    const receipt = receiptFor(sealed, a, 3n);

    expect(receipt.envelopeHash).toBe(keccak256(sealed.envelope));
    expect(receipt.voter).toBe(v.evmAddress);
    expect(receipt.ballotId).toBe(3n);
    expect(JSON.stringify(receipt, (_k, x) => (typeof x === 'bigint' ? String(x) : x))).not.toContain(
      'otter',
    );
  }, 30_000);
});

describe('tally rejections', () => {
  async function one(choice = 'badger') {
    const { election, keys } = await setup();
    const v = voter();
    const sealed = castBallot(args(election, v, choice));
    return {
      election,
      keys,
      v,
      ballot: { ballotId: 1n, voter: v.evmAddress, ciphertext: sealed.envelope } as OnChainBallot,
    };
  }

  const run = (
    ballots: OnChainBallot[],
    voters: ReturnType<typeof voter>[],
    keys: Awaited<ReturnType<typeof recoverElectionKeys>>,
    ref: ElectionRef = REF,
  ) =>
    tallyBallots({
      ...ref,
      chainId: CHAIN_ID,
      options: OPTIONS,
      ballots,
      roll: roll(voters),
      registryKeys: registry(voters),
      keys,
    });

  it('rejects a voter who is not on the roll', async () => {
    const { ballot, keys } = await one();
    const result = run([ballot], [], keys);
    expect(result.counted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('not-on-roll');
  }, 30_000);

  it('rejects a voter with no registered ML-DSA-87 key', async () => {
    const { ballot, keys, v } = await one();
    const result = tallyBallots({
      ...REF,
      chainId: CHAIN_ID,
      options: OPTIONS,
      ballots: [ballot],
      roll: roll([v]),
      registryKeys: new Map(), // registry says nothing about this voter
      keys,
    });
    expect(result.counted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('no-registered-pq-key');
  }, 30_000);

  /**
   * The headline replay test: B recasts A's ciphertext from B's own account.
   *
   * The contract would accept it — B is allowlisted and has not voted, and the
   * ciphertext is just bytes. The tally must not: it rebuilds the signed
   * message with B's address, taken from the chain, so A's signature fails.
   */
  it('rejects voter B recasting voter A ciphertext from B account', async () => {
    const { election, keys } = await setup();
    const a = voter();
    const b = voter();

    const sealed = castBallot(args(election, a, 'hedgehog'));

    // Same bytes, but the chain says B cast it.
    const replay: OnChainBallot = { ballotId: 1n, voter: b.evmAddress, ciphertext: sealed.envelope };

    const result = run([replay], [a, b], keys);
    expect(result.counted).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe('bad-mldsa-signature');
    expect(result.rejected[0]?.voter).toBe(b.evmAddress);

    // And the original, from A's own account, still counts.
    const honest: OnChainBallot = { ballotId: 1n, voter: a.evmAddress, ciphertext: sealed.envelope };
    const ok = run([honest], [a, b], keys);
    expect(ok.counted).toBe(1);
  }, 60_000);

  /**
   * A ballot built for a different election, presented here.
   *
   * Two defences fire. The AAD binds the ciphertext to its election, so a
   * ballot sealed for election 7 will not even decrypt under election 8. To
   * show the SIGNATURE binding independently, the second case seals with this
   * election's AAD but signs for another election id.
   */
  /**
   * A ballot from a different election.
   *
   * Two independent defences fire, and both are checked:
   *   (a) the envelope AAD binds the ciphertext to its election, so a ballot
   *       sealed for election 7 will not decrypt under election 8 at all;
   *   (b) the signed message binds the election id, so even a ballot sealed
   *       with the RIGHT AAD but signed for another election is refused.
   */
  it('rejects a ballot from a different election', async () => {
    const { election, keys } = await setup();
    const v = voter();

    // (a) sealed and signed for election 7, presented as election 8.
    const honest = castBallot(args(election, v, 'hedgehog'));
    const wrongElection = tallyBallots({
      ...REF,
      electionId: 8n,
      chainId: CHAIN_ID,
      options: OPTIONS,
      ballots: [{ ballotId: 1n, voter: v.evmAddress, ciphertext: honest.envelope }],
      roll: roll([v]),
      registryKeys: registry([v]),
      keys,
    });
    expect(wrongElection.counted).toBe(0);
    expect(wrongElection.rejected[0]?.reason).toBe('undecryptable');

    // (b) correct AAD for election 7, but the signature binds election 999.
    // This decrypts, so it isolates the signature binding on its own.
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const signedForAnother = pqSign(
      v.mldsaSecretKey,
      hexToBytes(
        ballotSigMessage({ ...REF, electionId: 999n, voter: v.evmAddress, choice: 'hedgehog', nonce }),
      ),
    );
    const crafted = sealWith(election, 'hedgehog', nonce, signedForAnother, REF);
    const result = run([{ ballotId: 1n, voter: v.evmAddress, ciphertext: crafted }], [v], keys);

    expect(result.counted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('bad-mldsa-signature');
  }, 60_000);

  it('rejects a signature over the wrong message', async () => {
    const { election, keys } = await setup();
    const v = voter();
    const nonce = crypto.getRandomValues(new Uint8Array(32));

    // A valid ML-DSA-87 signature by the right key, over the wrong bytes.
    const wrong = pqSign(v.mldsaSecretKey, new Uint8Array(32));
    const envelope = sealWith(election, 'badger', nonce, wrong, REF);

    const result = run([{ ballotId: 1n, voter: v.evmAddress, ciphertext: envelope }], [v], keys);
    expect(result.counted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('bad-mldsa-signature');
  }, 60_000);

  it('rejects a signature by the wrong key', async () => {
    const { election, keys } = await setup();
    const v = voter();
    const impostor = voter();
    const nonce = crypto.getRandomValues(new Uint8Array(32));

    // The right message, signed by someone else's ML-DSA-87 key.
    const message = ballotSigMessage({ ...REF, voter: v.evmAddress, choice: 'otter', nonce });
    const byImpostor = pqSign(impostor.mldsaSecretKey, hexToBytes(message));
    const envelope = sealWith(election, 'otter', nonce, byImpostor, REF);

    const result = run([{ ballotId: 1n, voter: v.evmAddress, ciphertext: envelope }], [v], keys);
    expect(result.counted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('bad-mldsa-signature');
  }, 60_000);

  it('rejects the same voter twice even if the events are replayed', async () => {
    const { ballot, keys, v } = await one();
    const result = run([ballot, { ...ballot, ballotId: 2n }], [v], keys);
    expect(result.counted).toBe(1);
    expect(result.rejected.map((r) => r.reason)).toEqual(['duplicate-voter']);
  }, 30_000);

  it('rejects a choice that is not on the ballot paper', async () => {
    const { ballot, keys, v } = await one('write-in-candidate');
    const result = run([ballot], [v], keys);
    expect(result.counted).toBe(0);
    expect(result.rejected[0]).toMatchObject({ reason: 'unknown-option', detail: 'write-in-candidate' });
  }, 30_000);
});

describe('ballot size', () => {
  it('matches the measured envelope size', async () => {
    const { election } = await setup();
    const v = voter();
    const sealed = castBallot(args(election, v, 'hedgehog'));
    expect(sealed.envelope.length).toBe(ballotEnvelopeSize('hedgehog'));
  }, 30_000);
});

describe('secret hygiene', () => {
  it('does not leak key material through stringify', () => {
    const v = voterFromMnemonic(generateMnemonic());
    const dumped = JSON.stringify(v);
    expect(dumped).toContain(v.evmAddress);
    expect(dumped).toContain('withheld');
    expect(dumped).not.toContain(v.evmPrivateKey.slice(2, 34));
  });

  it('derives one identity: the EVM and qor1 forms are the same account', () => {
    const mnemonic = generateMnemonic();
    const v = voterFromMnemonic(mnemonic);
    expect(v.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(v.bech32Address.startsWith('qor1')).toBe(true);
    expect(voterFromMnemonic(mnemonic).evmAddress).toBe(v.evmAddress);
  });
});

/**
 * The whole Booth lifecycle, with no chain and no server: set up an election,
 * cast ballots, reveal k shares, count.
 *
 * Note on keys: every key here is freshly generated. Booth never uses the
 * Hardhat/Anvil default accounts — this chain refuses ecrecover for those
 * well-known leaked keys, and the failure looks exactly like a signature bug
 * (docs/VERIFIED-FACTS.md).
 */
import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@qorechain/sdk';
import { keccak256, type Hex } from 'viem';
import { setUpElection, recipientOf } from '../src/core/election.js';
import { trusteeFromMnemonic, voterFromMnemonic } from '../src/core/identity.js';
import { castBallot, receiptFor, type ElectionRef } from '../src/core/ballot.js';
import { recoverElectionKeys, tallyBallots, type OnChainBallot } from '../src/core/tally.js';
import { ELECTION_KEY_BLOB_LENGTH, unpackElectionKey } from '../src/core/electionKey.js';
import { open } from '@qorechain/qoreseal';
import { SHARE_PURPOSE } from '../src/core/constants.js';

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

/** Open trustee i's sealed share, the way that trustee would in their browser. */
function openShare(sealed: Uint8Array[], trustees: ReturnType<typeof panel>, i: number) {
  const trustee = trustees[i]!;
  return open({
    chainId: CHAIN_ID,
    purpose: SHARE_PURPOSE,
    envelope: sealed[i]!,
    keys: trustee.sealKeys,
  });
}

describe('election setup', () => {
  it('publishes an ML-KEM-1024 + X25519 key blob and one sealed share per trustee', async () => {
    const trustees = panel(5);
    const setup = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 3,
    });

    expect(setup.electionPublicKey).toHaveLength(ELECTION_KEY_BLOB_LENGTH);
    expect(setup.sealedShares).toHaveLength(5);
    expect(setup.shareCommitments).toHaveLength(5);
    expect(setup.trusteeCount).toBe(5);

    const recipient = unpackElectionKey(setup.electionPublicKey);
    expect(recipient.mlkemPublicKey).toHaveLength(1568);
    expect(recipient.x25519PublicKey).toHaveLength(32);
  });

  it('never hands the creator the election key — only trustees can get it back', async () => {
    const trustees = panel(3);
    const setup = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 2,
    });

    // Nothing in the returned object is a secret key: the only fields are the
    // public blob, commitments and ciphertexts.
    expect(Object.keys(setup).sort()).toEqual(
      ['electionPublicKey', 'sealedShares', 'shareCommitments', 'threshold', 'trusteeCount'].sort(),
    );
  });

  it('commits to each share so a trustee cannot later reveal a junk one', async () => {
    const trustees = panel(3);
    const setup = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 2,
    });

    for (let i = 0; i < 3; i++) {
      expect(keccak256(openShare(setup.sealedShares, trustees, i))).toBe(setup.shareCommitments[i]);
    }
  });

  it('seals each share so only its own trustee can open it', async () => {
    const trustees = panel(3);
    const setup = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 2,
    });

    expect(() =>
      open({
        chainId: CHAIN_ID,
        purpose: SHARE_PURPOSE,
        envelope: setup.sealedShares[0]!,
        keys: trustees[1]!.sealKeys,
      }),
    ).toThrow();
  });

  it('rejects an impossible threshold', async () => {
    const trustees = panel(2).map((t) => recipientOf(t.sealKeys));
    await expect(setUpElection({ chainId: CHAIN_ID, trustees, threshold: 3 })).rejects.toThrow(
      /threshold must be an integer in 1\.\.2/,
    );
    await expect(setUpElection({ chainId: CHAIN_ID, trustees, threshold: 0 })).rejects.toThrow();
    await expect(
      setUpElection({ chainId: CHAIN_ID, trustees: [], threshold: 1 }),
    ).rejects.toThrow(/at least one trustee/);
  });
});

describe('threshold', () => {
  it('opens with exactly k shares and refuses with k-1', async () => {
    const trustees = panel(5);
    const setup = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 3,
    });
    const keyHash = keccak256(setup.electionPublicKey);

    // Three trustees, deliberately not the first three and out of order.
    const three = [4, 0, 2].map((i) => openShare(setup.sealedShares, trustees, i));
    const keys = await recoverElectionKeys(three, keyHash);
    expect(keccak256(keys.mlkemPublicKey)).toBe(keccak256(unpackElectionKey(setup.electionPublicKey).mlkemPublicKey));

    const two = [4, 0].map((i) => openShare(setup.sealedShares, trustees, i));
    await expect(recoverElectionKeys(two, keyHash)).rejects.toThrow(
      /do not rebuild the election key/,
    );
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

describe('ballots and tally', () => {
  async function runElection(choices: string[], threshold = 3, trusteeCount = 5) {
    const trustees = panel(trusteeCount);
    const setup = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold,
    });

    const voters = choices.map(() => voterFromMnemonic(generateMnemonic()));
    const roll = new Map<string, Hex>(
      voters.map((v) => [v.evmAddress.toLowerCase(), keccak256(v.mldsaPublicKey)]),
    );

    const ballots: OnChainBallot[] = [];
    for (let i = 0; i < voters.length; i++) {
      const sealed = await castBallot({
        ...REF,
        chainId: CHAIN_ID,
        electionPublicKey: setup.electionPublicKey,
        choice: choices[i]!,
        voter: voters[i]!,
      });
      ballots.push({
        voter: voters[i]!.evmAddress,
        envelope: sealed.envelope,
        mldsaPublicKey: sealed.mldsaPublicKey,
        mldsaSignature: sealed.mldsaSignature,
      });
    }

    const shares = Array.from({ length: threshold }, (_, i) =>
      openShare(setup.sealedShares, trustees, i),
    );
    const keys = await recoverElectionKeys(shares, keccak256(setup.electionPublicKey));

    return { setup, voters, roll, ballots, keys, trustees };
  }

  it('counts the ballots it should', async () => {
    const { roll, ballots, keys } = await runElection([
      'hedgehog',
      'badger',
      'hedgehog',
      'otter',
      'hedgehog',
    ]);

    const result = tallyBallots({
      ...REF,
      chainId: CHAIN_ID,
      options: OPTIONS,
      ballots,
      roll,
      keys,
    });

    expect(result.rejected).toEqual([]);
    expect(result.counted).toBe(5);
    expect(Object.fromEntries(result.counts)).toEqual({ hedgehog: 3, badger: 1, otter: 1 });
  });

  it('reports every option, including ones nobody picked', async () => {
    const { roll, ballots, keys } = await runElection(['badger']);
    const result = tallyBallots({ ...REF, chainId: CHAIN_ID, options: OPTIONS, ballots, roll, keys });
    expect(Object.fromEntries(result.counts)).toEqual({ hedgehog: 0, badger: 1, otter: 0 });
  });

  it('keeps the ballot unreadable until the shares are in', async () => {
    const { ballots, setup } = await runElection(['hedgehog']);
    // The envelope is just bytes; without the election key there is no choice in it.
    const text = Buffer.from(ballots[0]!.envelope).toString('latin1');
    for (const option of OPTIONS) expect(text).not.toContain(option);
    expect(ballots[0]!.envelope.length).toBeGreaterThan(1600);
    expect(setup.electionPublicKey.length).toBe(ELECTION_KEY_BLOB_LENGTH);
  });

  it('a voter can check their own ballot landed', async () => {
    const trustees = panel(3);
    const setup = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 2,
    });
    const voter = voterFromMnemonic(generateMnemonic());
    const args = {
      ...REF,
      chainId: CHAIN_ID,
      electionPublicKey: setup.electionPublicKey,
      choice: 'otter',
      voter,
    };
    const sealed = await castBallot(args);
    const receipt = receiptFor(sealed, args);

    expect(receipt.envelopeHash).toBe(keccak256(sealed.envelope));
    expect(receipt.voter).toBe(voter.evmAddress);
    // A receipt carries nothing secret.
    expect(JSON.stringify(receipt, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(
      'otter',
    );
  });
});

describe('tally rejections', () => {
  async function oneBallot(choice = 'badger') {
    const trustees = panel(3);
    const setup = await setUpElection({
      chainId: CHAIN_ID,
      trustees: trustees.map((t) => recipientOf(t.sealKeys)),
      threshold: 2,
    });
    const voter = voterFromMnemonic(generateMnemonic());
    const sealed = await castBallot({
      ...REF,
      chainId: CHAIN_ID,
      electionPublicKey: setup.electionPublicKey,
      choice,
      voter,
    });
    const keys = await recoverElectionKeys(
      [0, 1].map((i) => openShare(setup.sealedShares, trustees, i)),
      keccak256(setup.electionPublicKey),
    );
    const ballot: OnChainBallot = {
      voter: voter.evmAddress,
      envelope: sealed.envelope,
      mldsaPublicKey: sealed.mldsaPublicKey,
      mldsaSignature: sealed.mldsaSignature,
    };
    const roll = new Map<string, Hex>([
      [voter.evmAddress.toLowerCase(), keccak256(voter.mldsaPublicKey)],
    ]);
    return { ballot, roll, keys, voter, setup };
  }

  const tally = (ballots: OnChainBallot[], roll: Map<string, Hex>, keys: Awaited<ReturnType<typeof recoverElectionKeys>>) =>
    tallyBallots({ ...REF, chainId: CHAIN_ID, options: OPTIONS, ballots, roll, keys });

  it('rejects a voter who is not on the roll', async () => {
    const { ballot, keys } = await oneBallot();
    const result = tally([ballot], new Map(), keys);
    expect(result.counted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('not-on-roll');
  });

  it('rejects a tampered ML-DSA-87 signature', async () => {
    const { ballot, roll, keys } = await oneBallot();
    const tampered = Uint8Array.from(ballot.mldsaSignature);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    ballot.mldsaSignature = tampered;

    const result = tally([ballot], roll, keys);
    expect(result.counted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('bad-mldsa-signature');
  });

  it('rejects a ballot signed by a key that is not the registered one', async () => {
    const { ballot, roll, keys } = await oneBallot();
    const impostor = voterFromMnemonic(generateMnemonic());
    ballot.mldsaPublicKey = impostor.mldsaPublicKey;

    const result = tally([ballot], roll, keys);
    expect(result.counted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('wrong-pq-key');
  });

  it('rejects the same voter twice even if the events are replayed', async () => {
    const { ballot, roll, keys } = await oneBallot();
    const result = tally([ballot, ballot], roll, keys);
    expect(result.counted).toBe(1);
    expect(result.rejected.map((r) => r.reason)).toEqual(['duplicate-voter']);
  });

  it('rejects a choice that is not on the ballot paper', async () => {
    const { ballot, roll, keys } = await oneBallot('write-in-candidate');
    const result = tally([ballot], roll, keys);
    expect(result.counted).toBe(0);
    expect(result.rejected[0]).toMatchObject({
      reason: 'unknown-option',
      detail: 'write-in-candidate',
    });
  });

  it('rejects a ballot sealed for a different election', async () => {
    const { ballot, roll, keys } = await oneBallot();
    // Same ciphertext, presented as a ballot in another election: the AAD no
    // longer matches, so it will not open.
    const result = tallyBallots({
      ...REF,
      electionId: REF.electionId + 1n,
      chainId: CHAIN_ID,
      options: OPTIONS,
      ballots: [ballot],
      roll,
      keys,
    });
    expect(result.counted).toBe(0);
    // The commitment changes with the election id, so the signature fails first.
    expect(['bad-mldsa-signature', 'undecryptable']).toContain(result.rejected[0]?.reason);
  });
});

describe('secret hygiene', () => {
  it('does not leak key material through stringify or inspect', async () => {
    const voter = voterFromMnemonic(generateMnemonic());
    const dumped = JSON.stringify(voter);

    expect(dumped).toContain(voter.evmAddress);
    expect(dumped).toContain('withheld');
    expect(dumped).not.toContain(voter.evmPrivateKey.slice(2, 34));

    const trustee = trusteeFromMnemonic(generateMnemonic());
    expect(JSON.stringify(trustee)).toContain('withheld');
    expect(JSON.stringify(trustee)).not.toContain(
      Buffer.from(trustee.sealKeys.seed).toString('hex'),
    );
  });

  it('derives one identity: the EVM and qor1 forms are the same account', async () => {
    const mnemonic = generateMnemonic();
    const voter = voterFromMnemonic(mnemonic);
    expect(voter.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(voter.bech32Address.startsWith('qor1')).toBe(true);
    // Same mnemonic, same identity, every time.
    expect(voterFromMnemonic(mnemonic).evmAddress).toBe(voter.evmAddress);
    expect(Buffer.from(voterFromMnemonic(mnemonic).mldsaPublicKey)).toEqual(
      Buffer.from(voter.mldsaPublicKey),
    );
  });
});

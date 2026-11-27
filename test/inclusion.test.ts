/**
 * The Vote screen's inclusion check must find the voter's ballot by the id in
 * the voter's OWN receipt, not by assuming the newest ballot is theirs.
 *
 * Logs here are real ABI encodings of Election.sol's BallotCast event, built
 * from the same ABI the page decodes with.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type Abi,
  type Hex,
} from 'viem';
import ELECTION_ABI from '../src/abi/Election.json' with { type: 'json' };
import { castFromReceipt, verifyInclusion, type ReceiptLike } from '../src/core/inclusion.js';

const abi = ELECTION_ABI as unknown as Abi;
const CONTRACT = '0xb7d52d7934c5c26a9a8fa623ce3669c5def336e2' as Hex;
const OTHER_CONTRACT = '0x8a90db2f3f2192f94a1376c2b51f34f0628b1110' as Hex;
const ELECTION = 2n;
const ME = '0xdBEF137A63BdB02FB72a7Bd644Cae35f414f1e79' as Hex;
const SOMEONE_ELSE = '0xA1f23E85A59ba6e3bccDc08E780e493ff6284bDf' as Hex;

function ballotCastLog(opts: {
  address?: Hex;
  electionId?: bigint;
  ballotId: bigint;
  voter: Hex;
  ciphertext: Hex;
}) {
  const topics = encodeEventTopics({
    abi,
    eventName: 'BallotCast',
    args: { electionId: opts.electionId ?? ELECTION, ballotId: opts.ballotId, voter: opts.voter },
  }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes' }],
    [keccak256(opts.ciphertext), opts.ciphertext],
  );
  return { address: opts.address ?? CONTRACT, topics, data };
}

const myCiphertext = toHex('my sealed ballot');
const theirCiphertext = toHex('their sealed ballot');

describe('inclusion check', () => {
  it('uses the id from my receipt when another ballot lands in between', async () => {
    // I cast ballot 7. Before my page reads storage, someone else casts 8.
    const myReceipt: ReceiptLike = {
      status: 'success',
      logs: [ballotCastLog({ ballotId: 7n, voter: ME, ciphertext: myCiphertext })],
    };
    const storage = new Map<bigint, Hex>([
      [7n, keccak256(myCiphertext)],
      [8n, keccak256(theirCiphertext)],
    ]);
    const ballotCount = 8n;
    const readBallotHash = async (_e: bigint, id: bigint) =>
      storage.get(id) ?? (`0x${'00'.repeat(32)}` as Hex);

    const result = await verifyInclusion({
      receipt: myReceipt,
      contract: CONTRACT,
      electionId: ELECTION,
      voter: ME,
      envelopeHash: keccak256(myCiphertext),
      readBallotHash,
    });
    expect(result.ballotId).toBe(7n);
    expect(result.included).toBe(true);

    // The old logic, "newest ballot is mine", reports my real ballot as missing.
    const newest = await readBallotHash(ELECTION, ballotCount);
    expect(newest).not.toBe(keccak256(myCiphertext));
  });

  it('fails when storage under my id does not hold my ciphertext', async () => {
    const result = await verifyInclusion({
      receipt: {
        status: 'success',
        logs: [ballotCastLog({ ballotId: 7n, voter: ME, ciphertext: myCiphertext })],
      },
      contract: CONTRACT,
      electionId: ELECTION,
      voter: ME,
      envelopeHash: keccak256(myCiphertext),
      readBallotHash: async () => keccak256(theirCiphertext),
    });
    expect(result.included).toBe(false);
  });

  it('ignores BallotCast events from another contract, election or voter', () => {
    const receipt: ReceiptLike = {
      status: 'success',
      logs: [
        ballotCastLog({ address: OTHER_CONTRACT, ballotId: 1n, voter: ME, ciphertext: myCiphertext }),
        ballotCastLog({ electionId: 3n, ballotId: 2n, voter: ME, ciphertext: myCiphertext }),
        ballotCastLog({ ballotId: 3n, voter: SOMEONE_ELSE, ciphertext: theirCiphertext }),
        ballotCastLog({ ballotId: 4n, voter: ME, ciphertext: myCiphertext }),
      ],
    };
    expect(castFromReceipt(receipt, CONTRACT, ELECTION, ME).ballotId).toBe(4n);
  });

  it('refuses to guess when the receipt has no BallotCast for me', () => {
    const receipt: ReceiptLike = {
      status: 'success',
      logs: [ballotCastLog({ ballotId: 3n, voter: SOMEONE_ELSE, ciphertext: theirCiphertext })],
    };
    expect(() => castFromReceipt(receipt, CONTRACT, ELECTION, ME)).toThrow(/found 0/);
  });

  it('refuses a reverted receipt', () => {
    expect(() =>
      castFromReceipt({ status: 'reverted', logs: [] }, CONTRACT, ELECTION, ME),
    ).toThrow(/reverted/);
  });
});

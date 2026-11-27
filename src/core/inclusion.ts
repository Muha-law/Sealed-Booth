/**
 * The voter's inclusion check: is MY ballot on chain, exactly as I sealed it?
 *
 * The ballot id comes from the voter's OWN castBallot receipt (the BallotCast
 * event it emitted), never from `ballotCount`. Reading the newest ballot
 * after the receipt arrives is a race: if anyone else votes in between, the
 * newest ballot is theirs, and a ballot that IS on chain gets reported as
 * missing.
 *
 * The event says which id the contract assigned. Contract storage
 * (`ballotHash`) then confirms that id holds this voter's ciphertext hash.
 * A receipt is fetched by transaction hash, so this has no log-range limit.
 */
import { decodeEventLog, type Abi, type Hex } from 'viem';
import ELECTION_ABI from '../abi/Election.json' with { type: 'json' };

const abi = ELECTION_ABI as unknown as Abi;

/** The parts of a transaction receipt this check uses. */
export interface ReceiptLike {
  status: 'success' | 'reverted';
  logs: readonly { address: Hex; data: Hex; topics: readonly Hex[] }[];
}

export interface CastRecord {
  ballotId: bigint;
  /** The hash the contract emitted for this ballot. */
  ballotHash: Hex;
}

/**
 * The ballot this receipt cast for `voter` in `electionId` on `contract`.
 * Throws if the receipt holds no such event: nothing is guessed.
 */
export function castFromReceipt(
  receipt: ReceiptLike,
  contract: Hex,
  electionId: bigint,
  voter: Hex,
): CastRecord {
  if (receipt.status !== 'success') {
    throw new Error(`the castBallot transaction reverted (status ${receipt.status})`);
  }
  const found: CastRecord[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    let parsed;
    try {
      parsed = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    if (parsed.eventName !== 'BallotCast') continue;
    const a = parsed.args as unknown as {
      electionId: bigint;
      ballotId: bigint;
      voter: Hex;
      ballotHash: Hex;
    };
    if (a.electionId !== electionId) continue;
    if (a.voter.toLowerCase() !== voter.toLowerCase()) continue;
    found.push({ ballotId: a.ballotId, ballotHash: a.ballotHash });
  }
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one BallotCast for ${voter} in election ${electionId} in this receipt, found ${found.length}`,
    );
  }
  return found[0]!;
}

export interface InclusionResult extends CastRecord {
  /** What contract storage holds for that ballot id. */
  storedHash: Hex;
  included: boolean;
}

/**
 * Full check: id from the receipt, then storage must hold `envelopeHash`
 * for that id, and the event must agree.
 */
export async function verifyInclusion(opts: {
  receipt: ReceiptLike;
  contract: Hex;
  electionId: bigint;
  voter: Hex;
  envelopeHash: Hex;
  readBallotHash: (electionId: bigint, ballotId: bigint) => Promise<Hex>;
}): Promise<InclusionResult> {
  const cast = castFromReceipt(opts.receipt, opts.contract, opts.electionId, opts.voter);
  const storedHash = await opts.readBallotHash(opts.electionId, cast.ballotId);
  const want = opts.envelopeHash.toLowerCase();
  const included = storedHash.toLowerCase() === want && cast.ballotHash.toLowerCase() === want;
  return { ...cast, storedHash, included };
}

/**
 * LEGACY (Booth v1). The ballot commitment the superseded Booth.sol verifies.
 *
 * Kept only so test/contract.test.ts can keep cross-checking the TypeScript
 * against Booth's Solidity, which is still deployed and cited in PROOF.md.
 * The current scheme lives in src/core/ballot.ts and is different in kind: the
 * ML-DSA-87 signature is sealed inside the envelope and binds the voter's
 * address rather than the envelope hash.
 */
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Hex } from 'viem';

/** keccak256("booth-ballot-v1") — must equal `Booth.BALLOT_DOMAIN`. */
export const BOOTH_BALLOT_DOMAIN: Hex = keccak256(stringToHex('booth-ballot-v1'));

export interface BoothElectionRef {
  evmChainId: number;
  contract: Hex;
  electionId: bigint;
}

/** Mirrors `Booth.ballotCommitment`. */
export function boothBallotCommitment(
  ref: BoothElectionRef,
  mldsaKeyHash: Hex,
  envelopeHash: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, uint256, address, uint256, bytes32, bytes32'),
      [
        BOOTH_BALLOT_DOMAIN,
        BigInt(ref.evmChainId),
        ref.contract,
        ref.electionId,
        mldsaKeyHash,
        envelopeHash,
      ],
    ),
  );
}

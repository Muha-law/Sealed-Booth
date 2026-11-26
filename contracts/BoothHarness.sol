// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import "./Booth.sol";

/// @title Test-only harness. NOT part of the Booth deployment.
/// @notice Booth's admission control spans several transactions (create,
///         register, cast). An `eth_call` is one transaction, so this harness
///         drives the whole sequence in a single call. That lets the contract's
///         real logic run on the real chain's EVM — via an `eth_call` state
///         override, with no deployment and no funds — before anything is spent.
///
/// The Booth address is passed in rather than deployed with `new`, so the
/// caller knows it up front: a ballot signature commits to the Booth address,
/// and it has to be made off chain before this runs.
contract BoothHarness {
    struct VoteOutcome {
        uint256 electionId;
        bool accepted;
        bool receiptOk;
        uint32 ballotCount;
        bytes32 storedEnvelopeHash;
    }

    /// @notice create -> register -> cast, then read back what the contract thinks.
    /// @param expectVoter the address whose signature is being presented.
    /// @param rollVoter the address actually put on the roll. Pass a different
    ///        address to check that an unregistered signer is refused.
    function runVote(
        address boothAddr,
        address expectVoter,
        address rollVoter,
        bytes calldata envelope,
        bytes calldata mldsaPublicKey,
        bytes calldata mldsaSignature,
        bytes calldata secpSignature
    ) external returns (VoteOutcome memory out) {
        Booth booth = Booth(boothAddr);
        out.electionId = _open(booth, rollVoter, keccak256(mldsaPublicKey));

        try booth.castBallot(
            out.electionId, envelope, mldsaPublicKey, mldsaSignature, secpSignature
        ) {
            out.accepted = true;
        } catch {
            out.accepted = false;
        }

        out.receiptOk = booth.verifyReceipt(out.electionId, expectVoter, keccak256(envelope));
        out.ballotCount = booth.getElection(out.electionId).ballotCount;
        out.storedEnvelopeHash = booth.ballotOf(out.electionId, expectVoter);
    }

    /// @notice Cast the same ballot twice. The second must be refused.
    function runDoubleVote(
        address boothAddr,
        address voter,
        bytes calldata envelope,
        bytes calldata mldsaPublicKey,
        bytes calldata mldsaSignature,
        bytes calldata secpSignature
    ) external returns (bool firstAccepted, bool secondAccepted, uint32 ballotCount) {
        Booth booth = Booth(boothAddr);
        uint256 id = _open(booth, voter, keccak256(mldsaPublicKey));

        try booth.castBallot(id, envelope, mldsaPublicKey, mldsaSignature, secpSignature) {
            firstAccepted = true;
        } catch {
            firstAccepted = false;
        }
        try booth.castBallot(id, envelope, mldsaPublicKey, mldsaSignature, secpSignature) {
            secondAccepted = true;
        } catch {
            secondAccepted = false;
        }
        ballotCount = booth.getElection(id).ballotCount;
    }

    /// @notice What the contract computes for a ballot commitment, for the
    ///         cross-check against the TypeScript implementation.
    function commitmentVia(
        address boothAddr,
        uint256 electionId,
        bytes32 mldsaKeyHash,
        bytes32 envelopeHash
    ) external view returns (bytes32) {
        return Booth(boothAddr).ballotCommitment(electionId, mldsaKeyHash, envelopeHash);
    }

    /// @notice A share may only be revealed once voting has closed.
    function revealTooEarly(address boothAddr, bytes calldata share)
        external
        returns (bool refused)
    {
        Booth booth = Booth(boothAddr);
        uint256 id = _openWithShare(booth, keccak256(share));
        try booth.revealShare(id, 0, share) {
            refused = false;
        } catch {
            refused = true;
        }
    }

    /// @notice A share that does not match its commitment must be refused even
    ///         after voting closes.
    function revealMismatch(address boothAddr, bytes calldata share)
        external
        returns (bool refused)
    {
        Booth booth = Booth(boothAddr);
        // Commit to something else entirely.
        uint256 id = _openWithShare(booth, keccak256("a different share"));
        try booth.revealShare(id, 0, share) {
            refused = false;
        } catch {
            refused = true;
        }
    }

    // ------------------------------------------------------------- internals

    function _open(Booth booth, address voter, bytes32 keyHash) private returns (uint256 id) {
        id = _openWithShare(booth, keccak256("share-0"));
        address[] memory voters = new address[](1);
        bytes32[] memory hashes = new bytes32[](1);
        voters[0] = voter;
        hashes[0] = keyHash;
        booth.registerVoters(id, voters, hashes);
    }

    function _openWithShare(Booth booth, bytes32 shareCommitment) private returns (uint256 id) {
        string[] memory options = new string[](2);
        options[0] = "hedgehog";
        options[1] = "badger";

        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = shareCommitment;

        bytes[] memory sealedShares = new bytes[](1);
        sealedShares[0] = hex"00";

        id = booth.createElection(
            "harness election",
            options,
            uint64(block.timestamp + 1000),
            1,
            hex"00",
            commitments,
            sealedShares
        );
    }
}

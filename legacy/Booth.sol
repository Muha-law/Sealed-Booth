// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title Booth - a secret ballot that stays secret after Q-Day
/// @notice Holds only ciphertext. Ballots are sealed off chain to a single
///         election ML-KEM-1024 key whose seed is Shamir-split k-of-n across a
///         trustee panel, so nothing can be opened until voting closes and k
///         trustees reveal their share.
///
/// Why two signatures per ballot: a relayer submits ballots (no browser wallet
/// can sign a QoreChain EVM transaction today), so msg.sender says nothing
/// about the voter. Eligibility therefore comes from signatures in the
/// calldata:
///   * secp256k1 signature -> verified HERE via ecrecover, gates admission
///     (one registered voter, one vote)
///   * ML-DSA-87 signature -> stored in the event and verified by every client
///     at tally time against the voter's registered key. A ballot without a
///     valid ML-DSA-87 signature is not counted by any honest client.
///
/// NOTE: this shape was chosen while the PQC precompile 0x..0a01 was believed
/// unreachable from contract code. That measurement was wrong - it used an
/// eth_call state override, and QoreChain's precompiles decline a caller with
/// no real Cosmos account. A deployed probe shows pqcVerify working from
/// contract code at about 290k gas. So the ML-DSA-87 check COULD move in here,
/// replacing the secp256k1 gate and making admission post-quantum. See
/// docs/ARCHITECTURE.md "Open decision" and docs/VERIFIED-FACTS.md.
contract Booth {
    /// Domain tag so a signature for one election can never be replayed in another.
    bytes32 public constant BALLOT_DOMAIN = keccak256("booth-ballot-v1");

    struct Election {
        address creator;
        uint64 closesAt; // unix seconds; ballots refused from this point
        uint8 threshold; // k: shares needed to open the ballots
        uint8 trusteeCount; // n
        uint32 voterCount;
        uint32 ballotCount;
        uint32 shareCount;
        bool exists;
        bytes32 electionKeyHash; // keccak256 of the election ML-KEM-1024 public key
        string title;
    }

    uint256 public electionCount;

    mapping(uint256 => Election) private _elections;
    mapping(uint256 => string[]) private _options;

    /// electionId => voter => keccak256(their ML-DSA-87 public key). Zero = not on the roll.
    mapping(uint256 => mapping(address => bytes32)) public rollKeyHash;
    /// electionId => voter => keccak256(their ballot envelope). Zero = has not voted.
    mapping(uint256 => mapping(address => bytes32)) public ballotOf;
    /// electionId => trustee index => keccak256 of that trustee's plaintext share.
    mapping(uint256 => mapping(uint8 => bytes32)) public shareCommitment;
    /// electionId => trustee index => the revealed share, after voting closed.
    mapping(uint256 => mapping(uint8 => bytes)) public revealedShare;

    event ElectionCreated(
        uint256 indexed electionId,
        address indexed creator,
        string title,
        string[] options,
        uint64 closesAt,
        uint8 threshold,
        uint8 trusteeCount,
        bytes electionPublicKey
    );
    event VoterRegistered(uint256 indexed electionId, address indexed voter, bytes32 mldsaKeyHash);
    /// Carries the whole ciphertext. Storage keeps only the commitment.
    event BallotCast(
        uint256 indexed electionId,
        address indexed voter,
        bytes32 indexed envelopeHash,
        bytes envelope,
        bytes mldsaPublicKey,
        bytes mldsaSignature
    );
    event ShareSealed(uint256 indexed electionId, uint8 indexed trusteeIndex, bytes sealedShare);
    event ShareRevealed(uint256 indexed electionId, uint8 indexed trusteeIndex, bytes share);

    error NoSuchElection();
    error NotCreator();
    error VotingClosed();
    error VotingStillOpen();
    error BadThreshold();
    error BadTrusteeIndex();
    error NoOptions();
    error RollMismatch();
    error AlreadyVoted();
    error AlreadyRevealed();
    error ShareMismatch();
    error LengthMismatch();
    error EmptyEnvelope();

    modifier electionExists(uint256 id) {
        if (!_elections[id].exists) revert NoSuchElection();
        _;
    }

    /// @notice Open an election. The election public key and every sealed share
    ///         go in events; only commitments are stored.
    /// @param shareCommitments keccak256 of each trustee's plaintext share, in
    ///        trustee order. Committing here is what stops a trustee revealing
    ///        a junk share later.
    /// @param sealedShares each trustee's share, already sealed to that trustee
    ///        with QoreSeal. Public by design: only that trustee can open it.
    function createElection(
        string calldata title,
        string[] calldata options,
        uint64 closesAt,
        uint8 threshold,
        bytes calldata electionPublicKey,
        bytes32[] calldata shareCommitments,
        bytes[] calldata sealedShares
    ) external returns (uint256 id) {
        if (options.length == 0) revert NoOptions();
        if (closesAt <= block.timestamp) revert VotingClosed();
        uint256 n = shareCommitments.length;
        if (sealedShares.length != n) revert LengthMismatch();
        if (threshold == 0 || n == 0 || threshold > n || n > 255) revert BadThreshold();

        id = ++electionCount;
        Election storage e = _elections[id];
        e.creator = msg.sender;
        e.closesAt = closesAt;
        e.threshold = threshold;
        e.trusteeCount = uint8(n);
        e.exists = true;
        e.electionKeyHash = keccak256(electionPublicKey);
        e.title = title;

        for (uint256 i = 0; i < options.length; ++i) {
            _options[id].push(options[i]);
        }
        for (uint256 i = 0; i < n; ++i) {
            shareCommitment[id][uint8(i)] = shareCommitments[i];
            emit ShareSealed(id, uint8(i), sealedShares[i]);
        }

        emit ElectionCreated(
            id, msg.sender, title, options, closesAt, threshold, uint8(n), electionPublicKey
        );
    }

    /// @notice Put voters on the roll. Creator only, and only while voting is open.
    /// @param mldsaKeyHashes keccak256 of each voter's ML-DSA-87 public key.
    function registerVoters(
        uint256 id,
        address[] calldata voters,
        bytes32[] calldata mldsaKeyHashes
    ) external electionExists(id) {
        Election storage e = _elections[id];
        if (msg.sender != e.creator) revert NotCreator();
        if (block.timestamp >= e.closesAt) revert VotingClosed();
        if (voters.length != mldsaKeyHashes.length) revert LengthMismatch();

        for (uint256 i = 0; i < voters.length; ++i) {
            if (rollKeyHash[id][voters[i]] == bytes32(0)) {
                e.voterCount++;
            }
            rollKeyHash[id][voters[i]] = mldsaKeyHashes[i];
            emit VoterRegistered(id, voters[i], mldsaKeyHashes[i]);
        }
    }

    /// @notice The 32 bytes both of a voter's signatures cover.
    /// @dev Binds the domain, this chain, this contract, this election, the
    ///      voter's PQ identity and the exact ciphertext together.
    function ballotCommitment(uint256 id, bytes32 mldsaKeyHash, bytes32 envelopeHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(BALLOT_DOMAIN, block.chainid, address(this), id, mldsaKeyHash, envelopeHash)
        );
    }

    /// @notice Submit a sealed ballot. Anyone may relay it; the secp256k1
    ///         signature decides whose ballot it is.
    function castBallot(
        uint256 id,
        bytes calldata envelope,
        bytes calldata mldsaPublicKey,
        bytes calldata mldsaSignature,
        bytes calldata secpSignature
    ) external electionExists(id) {
        Election storage e = _elections[id];
        if (block.timestamp >= e.closesAt) revert VotingClosed();
        if (envelope.length == 0) revert EmptyEnvelope();

        bytes32 keyHash = keccak256(mldsaPublicKey);
        bytes32 envelopeHash = keccak256(envelope);
        bytes32 digest = _ethSigned(ballotCommitment(id, keyHash, envelopeHash));
        address voter = _recover(digest, secpSignature);

        // One check covers both: on the roll, and the ML-DSA key presented is
        // the one registered for that voter.
        if (voter == address(0) || rollKeyHash[id][voter] != keyHash) revert RollMismatch();
        if (ballotOf[id][voter] != bytes32(0)) revert AlreadyVoted();

        ballotOf[id][voter] = envelopeHash;
        e.ballotCount++;

        emit BallotCast(id, voter, envelopeHash, envelope, mldsaPublicKey, mldsaSignature);
    }

    /// @notice A trustee reveals its share once voting has closed. Checked
    ///         against the commitment made at creation.
    function revealShare(uint256 id, uint8 trusteeIndex, bytes calldata share)
        external
        electionExists(id)
    {
        Election storage e = _elections[id];
        if (block.timestamp < e.closesAt) revert VotingStillOpen();
        if (trusteeIndex >= e.trusteeCount) revert BadTrusteeIndex();
        if (revealedShare[id][trusteeIndex].length != 0) revert AlreadyRevealed();
        if (keccak256(share) != shareCommitment[id][trusteeIndex]) revert ShareMismatch();

        revealedShare[id][trusteeIndex] = share;
        e.shareCount++;
        emit ShareRevealed(id, trusteeIndex, share);
    }

    // ------------------------------------------------------------------ reads

    function getElection(uint256 id)
        external
        view
        electionExists(id)
        returns (Election memory)
    {
        return _elections[id];
    }

    function getOptions(uint256 id)
        external
        view
        electionExists(id)
        returns (string[] memory)
    {
        return _options[id];
    }

    /// @notice True once k trustees have revealed, i.e. the ballots can be opened.
    function tallyUnlocked(uint256 id) external view electionExists(id) returns (bool) {
        return _elections[id].shareCount >= _elections[id].threshold;
    }

    function votingOpen(uint256 id) external view electionExists(id) returns (bool) {
        return block.timestamp < _elections[id].closesAt;
    }

    /// @notice A voter's receipt check: did my exact ciphertext land on chain?
    function verifyReceipt(uint256 id, address voter, bytes32 envelopeHash)
        external
        view
        electionExists(id)
        returns (bool)
    {
        return ballotOf[id][voter] != bytes32(0) && ballotOf[id][voter] == envelopeHash;
    }

    /// @notice Every share revealed so far, for the client that recombines them.
    function getRevealedShares(uint256 id)
        external
        view
        electionExists(id)
        returns (uint8[] memory indexes, bytes[] memory shares)
    {
        Election storage e = _elections[id];
        uint256 found;
        for (uint8 i = 0; i < e.trusteeCount; ++i) {
            if (revealedShare[id][i].length != 0) found++;
        }
        indexes = new uint8[](found);
        shares = new bytes[](found);
        uint256 w;
        for (uint8 i = 0; i < e.trusteeCount; ++i) {
            if (revealedShare[id][i].length != 0) {
                indexes[w] = i;
                shares[w] = revealedShare[id][i];
                ++w;
            }
        }
    }

    // -------------------------------------------------------------- internals

    function _ethSigned(bytes32 h) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    /// @dev 65-byte r||s||v. Rejects high-s and v outside {27,28} so one
    ///      signature cannot be reshaped into a second valid one.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) {
            return address(0);
        }
        return ecrecover(digest, v, r, s);
    }
}

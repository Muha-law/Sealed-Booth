// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title Election - encrypted ballots with a k-of-n trustee tally
/// @notice Only ciphertext reaches this contract. Ballots are sealed off chain
///         to the election's ML-KEM-1024 key; the key's seed is split k-of-n
///         across a trustee panel, so nothing can be opened before the close.
///         After the close, trustees decrypt off chain and submit totals here.
///         A result becomes final only when k trustees submit identical totals.
///
/// Storage choices follow the gas measurements in docs/VERIFIED-FACTS.md:
/// bulk bytes (ciphertexts, the election public key, sealed shares) go in
/// EVENTS and only their keccak256 commitments are stored. Events cost about
/// 8 gas per byte against 20,000 per storage word, and nothing here needs to
/// read those bytes back on chain.
///
/// A trustee's encryption key is referenced, not stored: the 1568-byte
/// ML-KEM-1024 key lives in QoreChain's own KEM registry (algorithm id 2, at
/// /qorechain/pqc/v1/kem/{address}) and this contract keeps the keccak256 of
/// it. A client resolves the address against the registry and checks the hash.
contract Election {
    // ----------------------------------------------------------- data types

    struct ElectionData {
        string question;
        uint8 optionCount;
        uint8 trusteeCount;
        /// k: how many trustees must agree before a result is final.
        uint8 threshold;
        uint32 voterCount;
        uint32 ballotCount;
        /// How many trustees have released their share to the others.
        uint8 releasedCount;
        uint64 openAt;
        uint64 closeAt;
        bool exists;
        bool finalized;
        /// keccak256 of the election's ML-KEM-1024 public key material.
        bytes32 electionKeyHash;
    }

    struct Result {
        bool finalized;
        /// How many trustees have submitted the winning (agreeing) values.
        uint8 agreements;
        uint256[] totals;
        /// Which ballots the trustees counted, so the set is pinned too.
        bytes32 countedBallotIdsHash;
    }

    // ------------------------------------------------------------- storage

    address public immutable admin;
    uint256 public electionCount;

    mapping(uint256 => ElectionData) private _elections;
    mapping(uint256 => string[]) private _options;

    /// electionId => voter => on the allowlist.
    mapping(uint256 => mapping(address => bool)) public isVoter;
    /// electionId => voter => has cast a ballot.
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    /// electionId => ballotId => keccak256 of the ciphertext.
    mapping(uint256 => mapping(uint256 => bytes32)) private _ballotHash;
    /// electionId => ballotId => who cast it.
    mapping(uint256 => mapping(uint256 => address)) public ballotVoter;

    /// electionId => trustee => on the panel.
    mapping(uint256 => mapping(address => bool)) public isTrustee;
    /// electionId => trustee => its index in share order. Only meaningful when isTrustee.
    mapping(uint256 => mapping(address => uint8)) public trusteeIndexOf;
    /// electionId => trustee => keccak256 of its registered ML-KEM-1024 key.
    mapping(uint256 => mapping(address => bytes32)) public trusteeKeyRef;
    /// electionId => trustee index => keccak256 of that trustee's plaintext share.
    mapping(uint256 => mapping(uint8 => bytes32)) public shareCommitment;
    /// electionId => trustee index => has released its share to the other trustees.
    mapping(uint256 => mapping(uint8 => bool)) public shareReleased;

    /// electionId => trustee => keccak256 of the (totals, countedBallotIdsHash) it submitted.
    mapping(uint256 => mapping(address => bytes32)) public tallySubmission;
    /// electionId => submission hash => how many trustees submitted exactly that.
    mapping(uint256 => mapping(bytes32 => uint8)) public tallyAgreements;
    mapping(uint256 => Result) private _results;

    // -------------------------------------------------------------- events

    event ElectionCreated(
        uint256 indexed electionId,
        string question,
        string[] options,
        uint64 openAt,
        uint64 closeAt,
        uint8 threshold,
        address[] trustees,
        bytes32[] trusteeKeyRefs,
        bytes electionPublicKey
    );
    event VoterAllowed(uint256 indexed electionId, address indexed voter);
    /// Carries each trustee's sealed share. Public by design: only that
    /// trustee's ML-KEM-1024 key can open it.
    event ShareSealed(uint256 indexed electionId, uint8 indexed trusteeIndex, bytes sealedShare);
    /// @notice Trustee `trusteeIndex` has handed its share to the whole panel.
    /// @param sealedToTrustees One envelope per trustee, in trustee order: entry
    ///        `j` is that trustee's share re-sealed to trustee `j`'s registered
    ///        ML-KEM-1024 key. Every entry is ciphertext only its addressee can
    ///        open, so nothing readable reaches the chain.
    event ShareReleased(
        uint256 indexed electionId, uint8 indexed trusteeIndex, bytes[] sealedToTrustees
    );
    /// Carries the whole ciphertext. Storage keeps only `_ballotHash`.
    event BallotCast(
        uint256 indexed electionId,
        uint256 indexed ballotId,
        address indexed voter,
        bytes32 ballotHash,
        bytes ciphertext
    );
    event TallySubmitted(
        uint256 indexed electionId,
        address indexed trustee,
        bytes32 submissionHash,
        uint256[] totals,
        bytes32 countedBallotIdsHash,
        uint8 agreements
    );
    event ResultFinalized(
        uint256 indexed electionId,
        uint256[] totals,
        bytes32 countedBallotIdsHash,
        uint8 agreements
    );

    // -------------------------------------------------------------- errors

    error NotAVoter();
    error AlreadyVoted();
    error NotOpen();
    error StillOpen();
    error NotATrustee();
    error TallyMismatch();

    error NotAdmin();
    error NoSuchElection();
    error BadOptionCount();
    error BadThreshold();
    error BadWindow();
    error LengthMismatch();
    error EmptyCiphertext();
    error AlreadySubmitted();
    error AlreadyReleased();
    /// Voting has closed, so the roll can no longer change.
    error VotingClosed();
    error DuplicateTrustee();
    error ZeroAddress();
    error NotFinalized();

    // ------------------------------------------------------------ modifiers

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier electionExists(uint256 electionId) {
        if (!_elections[electionId].exists) revert NoSuchElection();
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    // ---------------------------------------------------------------- write

    /// @notice Open an election.
    /// @param question What is being decided.
    /// @param options 2 to 6 choices.
    /// @param openAt  Ballots accepted from this timestamp (inclusive).
    /// @param closeAt Ballots refused from this timestamp (inclusive).
    /// @param threshold k: trustees who must agree for a final result.
    /// @param voters The allowlist. Only these addresses may cast a ballot.
    /// @param trustees The panel, in share order.
    /// @param trusteeKeyRefs keccak256 of each trustee's ML-KEM-1024 key as
    ///        registered in QoreChain's KEM registry, in the same order.
    /// @param electionPublicKey The election's ML-KEM-1024 key material. Emitted
    ///        in full; only its hash is stored.
    /// @param shareCommitments keccak256 of each trustee's plaintext share.
    ///        Committing here is what stops a trustee revealing a junk share.
    /// @param sealedShares Each trustee's share, already sealed to that trustee.
    function createElection(
        string calldata question,
        string[] calldata options,
        uint64 openAt,
        uint64 closeAt,
        uint8 threshold,
        address[] calldata voters,
        address[] calldata trustees,
        bytes32[] calldata trusteeKeyRefs,
        bytes calldata electionPublicKey,
        bytes32[] calldata shareCommitments,
        bytes[] calldata sealedShares
    ) external onlyAdmin returns (uint256 electionId) {
        if (options.length < 2 || options.length > 6) revert BadOptionCount();
        if (closeAt <= openAt || closeAt <= block.timestamp) revert BadWindow();

        uint256 n = trustees.length;
        if (trusteeKeyRefs.length != n || shareCommitments.length != n || sealedShares.length != n) {
            revert LengthMismatch();
        }
        if (threshold == 0 || n == 0 || threshold > n || n > 255) revert BadThreshold();

        electionId = ++electionCount;
        ElectionData storage e = _elections[electionId];
        e.question = question;
        e.optionCount = uint8(options.length);
        e.trusteeCount = uint8(n);
        e.threshold = threshold;
        e.openAt = openAt;
        e.closeAt = closeAt;
        e.exists = true;
        e.electionKeyHash = keccak256(electionPublicKey);

        for (uint256 i = 0; i < options.length; ++i) {
            _options[electionId].push(options[i]);
        }

        for (uint256 i = 0; i < voters.length; ++i) {
            address voter = voters[i];
            if (voter == address(0)) revert ZeroAddress();
            if (!isVoter[electionId][voter]) {
                isVoter[electionId][voter] = true;
                e.voterCount++;
                emit VoterAllowed(electionId, voter);
            }
        }

        for (uint256 i = 0; i < n; ++i) {
            address trustee = trustees[i];
            if (trustee == address(0)) revert ZeroAddress();
            if (isTrustee[electionId][trustee]) revert DuplicateTrustee();
            isTrustee[electionId][trustee] = true;
            trusteeIndexOf[electionId][trustee] = uint8(i);
            trusteeKeyRef[electionId][trustee] = trusteeKeyRefs[i];
            shareCommitment[electionId][uint8(i)] = shareCommitments[i];
            emit ShareSealed(electionId, uint8(i), sealedShares[i]);
        }

        emit ElectionCreated(
            electionId,
            question,
            options,
            openAt,
            closeAt,
            threshold,
            trustees,
            trusteeKeyRefs,
            electionPublicKey
        );
    }

    /// @notice Add voters to an open election's allowlist. Admin only.
    ///
    /// @dev Exists so a long-running demo election can be topped up with freshly
    ///      provisioned voters as earlier ones are used, without closing it.
    ///      Idempotent per address: re-adding someone already on the roll is a
    ///      no-op and does not inflate `voterCount`.
    ///
    ///      This widens admin power — the admin can enlarge the electorate
    ///      mid-election. It is public (`VoterAllowed` events, `isVoter`), so it
    ///      is detectable, but it is not prevented. Stated in the README.
    function addVoters(uint256 electionId, address[] calldata voters)
        external
        onlyAdmin
        electionExists(electionId)
    {
        ElectionData storage e = _elections[electionId];
        if (block.timestamp >= e.closeAt) revert VotingClosed();

        for (uint256 i = 0; i < voters.length; ++i) {
            address voter = voters[i];
            if (voter == address(0)) revert ZeroAddress();
            if (isVoter[electionId][voter]) continue; // already on the roll
            isVoter[electionId][voter] = true;
            e.voterCount++;
            emit VoterAllowed(electionId, voter);
        }
    }

    /// @notice Cast one sealed ballot. Allowlist only, while open, once each.
    /// @return ballotId This ballot's id within the election, from 1.
    function castBallot(uint256 electionId, bytes calldata ciphertext)
        external
        electionExists(electionId)
        returns (uint256 ballotId)
    {
        ElectionData storage e = _elections[electionId];

        if (block.timestamp < e.openAt || block.timestamp >= e.closeAt) revert NotOpen();
        if (!isVoter[electionId][msg.sender]) revert NotAVoter();
        if (hasVoted[electionId][msg.sender]) revert AlreadyVoted();
        if (ciphertext.length == 0) revert EmptyCiphertext();

        hasVoted[electionId][msg.sender] = true;
        ballotId = ++e.ballotCount;

        bytes32 hash = keccak256(ciphertext);
        _ballotHash[electionId][ballotId] = hash;
        ballotVoter[electionId][ballotId] = msg.sender;

        emit BallotCast(electionId, ballotId, msg.sender, hash, ciphertext);
    }

    /// @notice A trustee hands its share to the rest of the panel, so trustees
    ///         can tally in separate browsers without ever pooling their keys.
    ///         Panel only, after the close, once each.
    ///
    /// @dev The trustee opens its OWN sealed share locally, then re-seals that
    ///      same share once per trustee to each trustee's registered
    ///      ML-KEM-1024 key. Entry `j` of `sealedToTrustees` is for trustee `j`.
    ///      Every entry is ciphertext, so no share is ever readable on chain —
    ///      which is exactly what the superseded Booth.sol got wrong.
    ///
    ///      This contract cannot inspect an envelope, and does not need to:
    ///      `shareCommitment[electionId][trusteeIndex]` was fixed at creation,
    ///      so every recipient checks `keccak256(share)` against it after
    ///      opening. A trustee that releases junk is caught by every other
    ///      trustee, deterministically.
    ///
    ///      Envelopes go in the event only. Storing them would cost millions of
    ///      gas and nothing on chain ever reads them back.
    function releaseShare(uint256 electionId, bytes[] calldata sealedToTrustees)
        external
        electionExists(electionId)
    {
        ElectionData storage e = _elections[electionId];

        if (block.timestamp < e.closeAt) revert StillOpen();
        if (!isTrustee[electionId][msg.sender]) revert NotATrustee();
        if (sealedToTrustees.length != e.trusteeCount) revert LengthMismatch();

        uint8 index = trusteeIndexOf[electionId][msg.sender];
        if (shareReleased[electionId][index]) revert AlreadyReleased();

        shareReleased[electionId][index] = true;
        e.releasedCount++;

        emit ShareReleased(electionId, index, sealedToTrustees);
    }

    /// @notice A trustee submits the totals it decrypted. Panel only, after the
    ///         close. The result is final once `threshold` trustees have
    ///         submitted identical totals AND the same counted-ballot set.
    /// @dev Submitting values that contradict an already-final result reverts
    ///      with TallyMismatch. Trustees who merely disagree before anything is
    ///      final simply never reach the threshold, which is the honest outcome:
    ///      no result at all rather than a disputed one.
    function submitTally(
        uint256 electionId,
        uint256[] calldata totals,
        bytes32 countedBallotIdsHash
    ) external electionExists(electionId) returns (bool finalized) {
        ElectionData storage e = _elections[electionId];

        if (block.timestamp < e.closeAt) revert StillOpen();
        if (!isTrustee[electionId][msg.sender]) revert NotATrustee();
        if (totals.length != e.optionCount) revert LengthMismatch();
        if (tallySubmission[electionId][msg.sender] != bytes32(0)) revert AlreadySubmitted();

        bytes32 submissionHash = keccak256(abi.encode(totals, countedBallotIdsHash));

        // Once a result is final, a trustee cannot contradict it.
        if (e.finalized) {
            bytes32 finalHash = keccak256(
                abi.encode(_results[electionId].totals, _results[electionId].countedBallotIdsHash)
            );
            if (submissionHash != finalHash) revert TallyMismatch();
        }

        tallySubmission[electionId][msg.sender] = submissionHash;
        uint8 agreements = tallyAgreements[electionId][submissionHash] + 1;
        tallyAgreements[electionId][submissionHash] = agreements;

        emit TallySubmitted(
            electionId, msg.sender, submissionHash, totals, countedBallotIdsHash, agreements
        );

        if (!e.finalized && agreements >= e.threshold) {
            e.finalized = true;
            Result storage r = _results[electionId];
            r.finalized = true;
            r.totals = totals;
            r.countedBallotIdsHash = countedBallotIdsHash;
            r.agreements = agreements;
            emit ResultFinalized(electionId, totals, countedBallotIdsHash, agreements);
        } else if (e.finalized) {
            _results[electionId].agreements = agreements;
        }

        return _elections[electionId].finalized;
    }

    // ----------------------------------------------------------------- read

    function getElection(uint256 electionId)
        external
        view
        electionExists(electionId)
        returns (ElectionData memory)
    {
        return _elections[electionId];
    }

    function getOptions(uint256 electionId)
        external
        view
        electionExists(electionId)
        returns (string[] memory)
    {
        return _options[electionId];
    }

    /// @notice keccak256 of a ballot's ciphertext, or zero if there is no such ballot.
    function ballotHash(uint256 electionId, uint256 ballotId)
        external
        view
        electionExists(electionId)
        returns (bytes32)
    {
        return _ballotHash[electionId][ballotId];
    }

    /// @notice The final result. Reverts with NotFinalized until k trustees agree.
    function finalResult(uint256 electionId)
        external
        view
        electionExists(electionId)
        returns (uint256[] memory totals, bytes32 countedBallotIdsHash, uint8 agreements)
    {
        Result storage r = _results[electionId];
        if (!r.finalized) revert NotFinalized();
        return (r.totals, r.countedBallotIdsHash, r.agreements);
    }

    /// @notice Non-reverting view, for a UI that needs to show "not yet".
    function resultStatus(uint256 electionId)
        external
        view
        electionExists(electionId)
        returns (bool finalized, uint8 agreements, uint8 threshold)
    {
        return (
            _results[electionId].finalized,
            _results[electionId].agreements,
            _elections[electionId].threshold
        );
    }

    /// @notice How many trustees have released their share, and how many are
    ///         needed before any one of them can tally.
    function releaseStatus(uint256 electionId)
        external
        view
        electionExists(electionId)
        returns (uint8 released, uint8 threshold, bool enough)
    {
        ElectionData storage e = _elections[electionId];
        return (e.releasedCount, e.threshold, e.releasedCount >= e.threshold);
    }

    function isOpen(uint256 electionId) external view electionExists(electionId) returns (bool) {
        ElectionData storage e = _elections[electionId];
        return block.timestamp >= e.openAt && block.timestamp < e.closeAt;
    }
}

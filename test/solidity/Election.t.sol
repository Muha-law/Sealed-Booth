// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Election} from "../../contracts/Election.sol";

/// Every rule in Election, including the four the brief names explicitly:
/// a double vote, a vote after close, a tally before close, and two trustees
/// submitting different totals.
contract ElectionTest is Test {
    Election internal election;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    address internal voterA = makeAddr("voterA");
    address internal voterB = makeAddr("voterB");
    address internal voterC = makeAddr("voterC");

    address internal trustee1 = makeAddr("trustee1");
    address internal trustee2 = makeAddr("trustee2");
    address internal trustee3 = makeAddr("trustee3");

    uint64 internal openAt;
    uint64 internal closeAt;

    bytes internal constant CIPHERTEXT = hex"deadbeefcafe";
    bytes internal constant ELECTION_KEY = hex"0102030405";

    function setUp() public {
        // Start from a sane timestamp so openAt can sit in the future.
        vm.warp(1_700_000_000);
        openAt = uint64(block.timestamp + 100);
        closeAt = uint64(block.timestamp + 1000);

        vm.prank(admin);
        election = new Election();
    }

    // ------------------------------------------------------------- helpers

    function _voters() internal view returns (address[] memory v) {
        v = new address[](3);
        v[0] = voterA;
        v[1] = voterB;
        v[2] = voterC;
    }

    function _trustees() internal view returns (address[] memory t) {
        t = new address[](3);
        t[0] = trustee1;
        t[1] = trustee2;
        t[2] = trustee3;
    }

    function _bytes32s(uint256 n) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            a[i] = keccak256(abi.encodePacked("item", i));
        }
    }

    function _sealedShares(uint256 n) internal pure returns (bytes[] memory s) {
        s = new bytes[](n);
        for (uint256 i = 0; i < n; ++i) {
            s[i] = abi.encodePacked("sealed-share-", i);
        }
    }

    function _options(uint256 n) internal pure returns (string[] memory o) {
        string[6] memory all = ["a", "b", "c", "d", "e", "f"];
        o = new string[](n);
        for (uint256 i = 0; i < n; ++i) {
            o[i] = all[i];
        }
    }

    /// 3 options, 3 trustees, threshold 2, 3 allowlisted voters.
    function _create() internal returns (uint256 id) {
        vm.prank(admin);
        id = election.createElection(
            "Which animal guards the ballot box?",
            _options(3),
            openAt,
            closeAt,
            2,
            _voters(),
            _trustees(),
            _bytes32s(3),
            ELECTION_KEY,
            _bytes32s(3),
            _sealedShares(3)
        );
    }

    function _createWith(uint8 optionCount, uint8 threshold, uint64 _openAt, uint64 _closeAt)
        internal
        returns (uint256 id)
    {
        vm.prank(admin);
        id = election.createElection(
            "q",
            _options(optionCount),
            _openAt,
            _closeAt,
            threshold,
            _voters(),
            _trustees(),
            _bytes32s(3),
            ELECTION_KEY,
            _bytes32s(3),
            _sealedShares(3)
        );
    }

    function _totals(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory t) {
        t = new uint256[](3);
        t[0] = a;
        t[1] = b;
        t[2] = c;
    }

    function _openVoting() internal {
        vm.warp(openAt);
    }

    function _closeVoting() internal {
        vm.warp(closeAt);
    }

    // ------------------------------------------------------- createElection

    function test_admin_creates_election() public {
        uint256 id = _create();
        assertEq(id, 1);
        assertEq(election.electionCount(), 1);

        Election.ElectionData memory e = election.getElection(id);
        assertEq(e.question, "Which animal guards the ballot box?");
        assertEq(e.optionCount, 3);
        assertEq(e.trusteeCount, 3);
        assertEq(e.threshold, 2);
        assertEq(e.voterCount, 3);
        assertEq(e.ballotCount, 0);
        assertEq(e.openAt, openAt);
        assertEq(e.closeAt, closeAt);
        assertTrue(e.exists);
        assertFalse(e.finalized);
        assertEq(e.electionKeyHash, keccak256(ELECTION_KEY));

        string[] memory opts = election.getOptions(id);
        assertEq(opts.length, 3);
        assertEq(opts[0], "a");

        assertTrue(election.isVoter(id, voterA));
        assertFalse(election.isVoter(id, stranger));
        assertTrue(election.isTrustee(id, trustee1));
        assertFalse(election.isTrustee(id, stranger));
    }

    function test_only_admin_can_create() public {
        vm.prank(stranger);
        vm.expectRevert(Election.NotAdmin.selector);
        election.createElection(
            "q",
            _options(3),
            openAt,
            closeAt,
            2,
            _voters(),
            _trustees(),
            _bytes32s(3),
            ELECTION_KEY,
            _bytes32s(3),
            _sealedShares(3)
        );
    }

    function test_option_count_must_be_2_to_6() public {
        vm.expectRevert(Election.BadOptionCount.selector);
        _createWith(1, 2, openAt, closeAt);

        // 2 and 6 are both accepted.
        _createWith(2, 2, openAt, closeAt);
        _createWith(6, 2, openAt, closeAt);
    }

    function test_option_count_rejects_seven() public {
        string[] memory seven = new string[](7);
        for (uint256 i = 0; i < 7; ++i) {
            seven[i] = "x";
        }
        vm.prank(admin);
        vm.expectRevert(Election.BadOptionCount.selector);
        election.createElection(
            "q",
            seven,
            openAt,
            closeAt,
            2,
            _voters(),
            _trustees(),
            _bytes32s(3),
            ELECTION_KEY,
            _bytes32s(3),
            _sealedShares(3)
        );
    }

    function test_threshold_must_fit_the_panel() public {
        vm.expectRevert(Election.BadThreshold.selector);
        _createWith(3, 0, openAt, closeAt);

        vm.expectRevert(Election.BadThreshold.selector);
        _createWith(3, 4, openAt, closeAt); // only 3 trustees
    }

    function test_window_must_be_sane() public {
        vm.expectRevert(Election.BadWindow.selector);
        _createWith(3, 2, closeAt, openAt); // close before open

        vm.expectRevert(Election.BadWindow.selector);
        _createWith(3, 2, uint64(block.timestamp - 10), uint64(block.timestamp)); // already closed
    }

    function test_array_lengths_must_agree() public {
        vm.prank(admin);
        vm.expectRevert(Election.LengthMismatch.selector);
        election.createElection(
            "q",
            _options(3),
            openAt,
            closeAt,
            2,
            _voters(),
            _trustees(),
            _bytes32s(2), // one key ref short
            ELECTION_KEY,
            _bytes32s(3),
            _sealedShares(3)
        );
    }

    function test_duplicate_trustee_rejected() public {
        address[] memory dupes = new address[](3);
        dupes[0] = trustee1;
        dupes[1] = trustee1;
        dupes[2] = trustee3;

        vm.prank(admin);
        vm.expectRevert(Election.DuplicateTrustee.selector);
        election.createElection(
            "q",
            _options(3),
            openAt,
            closeAt,
            2,
            _voters(),
            dupes,
            _bytes32s(3),
            ELECTION_KEY,
            _bytes32s(3),
            _sealedShares(3)
        );
    }

    function test_trustee_key_reference_is_stored() public {
        uint256 id = _create();
        bytes32[] memory refs = _bytes32s(3);
        assertEq(election.trusteeKeyRef(id, trustee1), refs[0]);
        assertEq(election.trusteeKeyRef(id, trustee2), refs[1]);
        assertEq(election.trusteeKeyRef(id, trustee3), refs[2]);
        assertEq(election.trusteeKeyRef(id, stranger), bytes32(0));
    }

    function test_share_commitments_are_stored() public {
        uint256 id = _create();
        bytes32[] memory commits = _bytes32s(3);
        for (uint8 i = 0; i < 3; ++i) {
            assertEq(election.shareCommitment(id, i), commits[i]);
        }
    }

    function test_unknown_election_reverts() public {
        vm.expectRevert(Election.NoSuchElection.selector);
        election.getElection(99);
    }

    // ------------------------------------------------------------ castBallot

    function test_allowlisted_voter_casts_a_ballot() public {
        uint256 id = _create();
        _openVoting();

        assertFalse(election.hasVoted(id, voterA));

        vm.prank(voterA);
        uint256 ballotId = election.castBallot(id, CIPHERTEXT);

        assertEq(ballotId, 1);
        assertTrue(election.hasVoted(id, voterA));
        assertEq(election.ballotHash(id, 1), keccak256(CIPHERTEXT));
        assertEq(election.ballotVoter(id, 1), voterA);
        assertEq(election.getElection(id).ballotCount, 1);
    }

    function test_ballot_ids_increment_per_election() public {
        uint256 id = _create();
        _openVoting();

        vm.prank(voterA);
        assertEq(election.castBallot(id, hex"01"), 1);
        vm.prank(voterB);
        assertEq(election.castBallot(id, hex"02"), 2);
        vm.prank(voterC);
        assertEq(election.castBallot(id, hex"03"), 3);

        assertEq(election.ballotHash(id, 2), keccak256(hex"02"));
    }

    function test_ballot_event_carries_the_ciphertext() public {
        uint256 id = _create();
        _openVoting();

        vm.expectEmit(true, true, true, true, address(election));
        emit Election.BallotCast(id, 1, voterA, keccak256(CIPHERTEXT), CIPHERTEXT);

        vm.prank(voterA);
        election.castBallot(id, CIPHERTEXT);
    }

    function test_non_voter_cannot_cast() public {
        uint256 id = _create();
        _openVoting();

        vm.prank(stranger);
        vm.expectRevert(Election.NotAVoter.selector);
        election.castBallot(id, CIPHERTEXT);
    }

    /// The brief: a double-vote attempt.
    function test_double_vote_is_refused() public {
        uint256 id = _create();
        _openVoting();

        vm.prank(voterA);
        election.castBallot(id, CIPHERTEXT);

        vm.prank(voterA);
        vm.expectRevert(Election.AlreadyVoted.selector);
        election.castBallot(id, hex"ffff");

        // Nothing changed.
        assertEq(election.getElection(id).ballotCount, 1);
        assertEq(election.ballotHash(id, 2), bytes32(0));
    }

    function test_cannot_vote_before_open() public {
        uint256 id = _create();
        // still before openAt
        vm.prank(voterA);
        vm.expectRevert(Election.NotOpen.selector);
        election.castBallot(id, CIPHERTEXT);
    }

    /// The brief: a vote after close.
    function test_cannot_vote_after_close() public {
        uint256 id = _create();
        _closeVoting();

        vm.prank(voterA);
        vm.expectRevert(Election.NotOpen.selector);
        election.castBallot(id, CIPHERTEXT);

        // And well past it.
        vm.warp(closeAt + 10_000);
        vm.prank(voterB);
        vm.expectRevert(Election.NotOpen.selector);
        election.castBallot(id, CIPHERTEXT);
    }

    function test_close_boundary_is_exclusive() public {
        uint256 id = _create();

        vm.warp(closeAt - 1);
        vm.prank(voterA);
        election.castBallot(id, CIPHERTEXT); // last moment works

        vm.warp(closeAt);
        vm.prank(voterB);
        vm.expectRevert(Election.NotOpen.selector);
        election.castBallot(id, CIPHERTEXT);
    }

    function test_open_boundary_is_inclusive() public {
        uint256 id = _create();
        vm.warp(openAt);
        vm.prank(voterA);
        election.castBallot(id, CIPHERTEXT);
        assertTrue(election.hasVoted(id, voterA));
    }

    function test_empty_ciphertext_is_refused() public {
        uint256 id = _create();
        _openVoting();

        vm.prank(voterA);
        vm.expectRevert(Election.EmptyCiphertext.selector);
        election.castBallot(id, "");
    }

    function test_isOpen_tracks_the_window() public {
        uint256 id = _create();
        assertFalse(election.isOpen(id));
        vm.warp(openAt);
        assertTrue(election.isOpen(id));
        vm.warp(closeAt - 1);
        assertTrue(election.isOpen(id));
        vm.warp(closeAt);
        assertFalse(election.isOpen(id));
    }

    // ----------------------------------------------------------- submitTally

    function _voteAll(uint256 id) internal {
        _openVoting();
        vm.prank(voterA);
        election.castBallot(id, hex"01");
        vm.prank(voterB);
        election.castBallot(id, hex"02");
        vm.prank(voterC);
        election.castBallot(id, hex"03");
    }

    /// The brief: a tally before close.
    function test_tally_before_close_is_refused() public {
        uint256 id = _create();
        _openVoting();

        vm.prank(trustee1);
        vm.expectRevert(Election.StillOpen.selector);
        election.submitTally(id, _totals(2, 1, 0), keccak256("ballots"));
    }

    function test_non_trustee_cannot_submit() public {
        uint256 id = _create();
        _voteAll(id);
        _closeVoting();

        vm.prank(stranger);
        vm.expectRevert(Election.NotATrustee.selector);
        election.submitTally(id, _totals(2, 1, 0), keccak256("ballots"));

        // A voter is not a trustee either.
        vm.prank(voterA);
        vm.expectRevert(Election.NotATrustee.selector);
        election.submitTally(id, _totals(2, 1, 0), keccak256("ballots"));
    }

    function test_totals_length_must_match_options() public {
        uint256 id = _create();
        _closeVoting();

        uint256[] memory wrong = new uint256[](2);
        vm.prank(trustee1);
        vm.expectRevert(Election.LengthMismatch.selector);
        election.submitTally(id, wrong, keccak256("ballots"));
    }

    function test_one_trustee_is_not_enough() public {
        uint256 id = _create();
        _voteAll(id);
        _closeVoting();

        vm.prank(trustee1);
        bool finalized = election.submitTally(id, _totals(2, 1, 0), keccak256("ballots"));
        assertFalse(finalized);

        (bool isFinal, uint8 agreements, uint8 threshold) = election.resultStatus(id);
        assertFalse(isFinal);
        assertEq(agreements, 0); // nothing agreed yet
        assertEq(threshold, 2);

        vm.expectRevert(Election.NotFinalized.selector);
        election.finalResult(id);
    }

    function test_k_matching_trustees_finalize_the_result() public {
        uint256 id = _create();
        _voteAll(id);
        _closeVoting();

        bytes32 counted = keccak256("ballots-1-2-3");

        vm.prank(trustee1);
        assertFalse(election.submitTally(id, _totals(2, 1, 0), counted));

        vm.prank(trustee2);
        assertTrue(election.submitTally(id, _totals(2, 1, 0), counted));

        (uint256[] memory totals, bytes32 countedHash, uint8 agreements) = election.finalResult(id);
        assertEq(totals.length, 3);
        assertEq(totals[0], 2);
        assertEq(totals[1], 1);
        assertEq(totals[2], 0);
        assertEq(countedHash, counted);
        assertEq(agreements, 2);
        assertTrue(election.getElection(id).finalized);
    }

    function test_finalize_emits_the_result() public {
        uint256 id = _create();
        _voteAll(id);
        _closeVoting();

        bytes32 counted = keccak256("ballots");

        vm.prank(trustee1);
        election.submitTally(id, _totals(3, 0, 0), counted);

        vm.expectEmit(true, true, true, true, address(election));
        emit Election.ResultFinalized(id, _totals(3, 0, 0), counted, 2);

        vm.prank(trustee2);
        election.submitTally(id, _totals(3, 0, 0), counted);
    }

    /// The brief: two trustees submitting different totals.
    function test_two_trustees_disagreeing_produces_no_result() public {
        uint256 id = _create();
        _voteAll(id);
        _closeVoting();

        bytes32 counted = keccak256("ballots");

        vm.prank(trustee1);
        assertFalse(election.submitTally(id, _totals(2, 1, 0), counted));

        vm.prank(trustee2);
        assertFalse(election.submitTally(id, _totals(1, 2, 0), counted)); // different totals

        (bool isFinal,,) = election.resultStatus(id);
        assertFalse(isFinal);
        assertFalse(election.getElection(id).finalized);

        vm.expectRevert(Election.NotFinalized.selector);
        election.finalResult(id);

        // The third trustee agreeing with the FIRST reaches the threshold.
        vm.prank(trustee3);
        assertTrue(election.submitTally(id, _totals(2, 1, 0), counted));

        (uint256[] memory totals,, uint8 agreements) = election.finalResult(id);
        assertEq(totals[0], 2);
        assertEq(totals[1], 1);
        assertEq(agreements, 2);
    }

    /// Same totals but a different counted-ballot set is still a disagreement.
    function test_same_totals_different_ballot_set_does_not_agree() public {
        uint256 id = _create();
        _voteAll(id);
        _closeVoting();

        vm.prank(trustee1);
        election.submitTally(id, _totals(2, 1, 0), keccak256("set-A"));
        vm.prank(trustee2);
        election.submitTally(id, _totals(2, 1, 0), keccak256("set-B"));

        (bool isFinal,,) = election.resultStatus(id);
        assertFalse(isFinal);
    }

    function test_trustee_cannot_submit_twice() public {
        uint256 id = _create();
        _closeVoting();

        vm.prank(trustee1);
        election.submitTally(id, _totals(1, 0, 0), keccak256("x"));

        vm.prank(trustee1);
        vm.expectRevert(Election.AlreadySubmitted.selector);
        election.submitTally(id, _totals(1, 0, 0), keccak256("x"));
    }

    function test_contradicting_a_final_result_reverts_with_TallyMismatch() public {
        uint256 id = _create();
        _voteAll(id);
        _closeVoting();

        bytes32 counted = keccak256("ballots");

        vm.prank(trustee1);
        election.submitTally(id, _totals(2, 1, 0), counted);
        vm.prank(trustee2);
        election.submitTally(id, _totals(2, 1, 0), counted);
        assertTrue(election.getElection(id).finalized);

        // Trustee 3 now tries to tell a different story.
        vm.prank(trustee3);
        vm.expectRevert(Election.TallyMismatch.selector);
        election.submitTally(id, _totals(0, 0, 3), counted);
    }

    function test_agreeing_with_a_final_result_is_allowed() public {
        uint256 id = _create();
        _voteAll(id);
        _closeVoting();

        bytes32 counted = keccak256("ballots");

        vm.prank(trustee1);
        election.submitTally(id, _totals(2, 1, 0), counted);
        vm.prank(trustee2);
        election.submitTally(id, _totals(2, 1, 0), counted);

        vm.prank(trustee3);
        assertTrue(election.submitTally(id, _totals(2, 1, 0), counted));

        (,, uint8 agreements) = election.finalResult(id);
        assertEq(agreements, 3);
    }

    function test_threshold_of_one_finalizes_immediately() public {
        uint256 id = _createWith(3, 1, openAt, closeAt);
        vm.warp(closeAt);

        vm.prank(trustee1);
        assertTrue(election.submitTally(id, _totals(1, 1, 1), keccak256("x")));

        (,, uint8 agreements) = election.finalResult(id);
        assertEq(agreements, 1);
    }

    // ------------------------------------------------------------ isolation

    function test_elections_do_not_leak_into_each_other() public {
        uint256 a = _create();
        uint256 b = _create();
        _openVoting();

        vm.prank(voterA);
        election.castBallot(a, hex"01");

        assertTrue(election.hasVoted(a, voterA));
        assertFalse(election.hasVoted(b, voterA));

        // The same voter may still vote in the other election.
        vm.prank(voterA);
        assertEq(election.castBallot(b, hex"02"), 1);

        _closeVoting();
        bytes32 counted = keccak256("x");
        vm.prank(trustee1);
        election.submitTally(a, _totals(1, 0, 0), counted);
        vm.prank(trustee2);
        election.submitTally(a, _totals(1, 0, 0), counted);

        assertTrue(election.getElection(a).finalized);
        assertFalse(election.getElection(b).finalized);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_only_allowlisted_addresses_can_vote(address who) public {
        uint256 id = _create();
        _openVoting();

        vm.assume(who != voterA && who != voterB && who != voterC);

        vm.prank(who);
        vm.expectRevert(Election.NotAVoter.selector);
        election.castBallot(id, CIPHERTEXT);
    }

    function testFuzz_voting_outside_the_window_always_fails(uint64 when) public {
        uint256 id = _create();
        vm.assume(when < openAt || when >= closeAt);
        vm.assume(when > 0);
        vm.warp(when);

        vm.prank(voterA);
        vm.expectRevert(Election.NotOpen.selector);
        election.castBallot(id, CIPHERTEXT);
    }

    function testFuzz_ballot_hash_matches_any_ciphertext(bytes calldata data) public {
        vm.assume(data.length > 0);
        uint256 id = _create();
        _openVoting();

        vm.prank(voterA);
        uint256 ballotId = election.castBallot(id, data);
        assertEq(election.ballotHash(id, ballotId), keccak256(data));
    }
}

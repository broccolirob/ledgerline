// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RevenueBatchAnchor} from "../src/RevenueBatchAnchor.sol";

contract RevenueBatchAnchorTest is Test {
    RevenueBatchAnchor anchor;
    address admin = address(this);
    address stranger = address(0xBEEF);

    bytes32 constant TC = keccak256("tenant-commitment");
    bytes32 constant SCHEMA = keccak256("schema");
    bytes32 constant POLICY = keccak256("policy");
    bytes32 constant ZERO = bytes32(0);
    bytes32 constant BATCH_ID_DOMAIN = keccak256("LEDGERLINE_BATCH_ID_V1");

    // Cached so pranked tests never make an external getter call inside an expectRevert(...) arg
    // (which would consume the vm.prank).
    bytes32 committerRole;
    bytes32 adminRole;

    function setUp() public {
        anchor = new RevenueBatchAnchor(admin);
        committerRole = anchor.COMMITTER_ROLE();
        adminRole = anchor.DEFAULT_ADMIN_ROLE();
        vm.warp(1_700_000_000); // realistic, non-zero timestamp
    }

    /// Canonical batchId derivation — must match canonical/src/index.ts batchId() byte-for-byte.
    function _batchId(uint64 num, bytes32 root) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(BATCH_ID_DOMAIN, TC, num, root));
    }

    /// Commit with a correctly-derived batchId (the common case).
    function _commit(uint64 num, bytes32 prev, bytes32 root, uint64 count) internal {
        anchor.commitBatch(TC, _batchId(num, root), num, prev, root, count, SCHEMA, POLICY, ZERO);
    }

    function testCommitBatchHappyPath() public {
        bytes32 root = keccak256("r1");
        _commit(1, ZERO, root, 9);

        bytes32 bid = _batchId(1, root);
        (bytes32 tc,, uint64 num,, bytes32 mr, uint64 count,,,, uint64 committedAt) = anchor.batches(bid);
        assertEq(tc, TC);
        assertEq(num, 1);
        assertEq(mr, root);
        assertEq(count, 9);
        assertTrue(committedAt != 0);
        assertTrue(anchor.batchExists(bid));
        assertEq(anchor.latestRootByTenant(TC), root);
        assertEq(anchor.latestBatchNumberByTenant(TC), 1);
    }

    function testRevertWhenBatchAlreadyCommitted() public {
        bytes32 root = keccak256("r1");
        _commit(1, ZERO, root, 9);
        // exact same (num, root) -> same derived batchId -> batchExists reverts
        vm.expectRevert(RevenueBatchAnchor.BatchAlreadyCommitted.selector);
        _commit(1, ZERO, root, 9);
    }

    function testRevertWhenInvalidEventCount() public {
        vm.expectRevert(RevenueBatchAnchor.InvalidEventCount.selector);
        _commit(1, ZERO, keccak256("r1"), 0);
    }

    function testRevertWhenPreviousRootMismatch() public {
        vm.expectRevert(RevenueBatchAnchor.PreviousRootMismatch.selector);
        _commit(1, keccak256("not-zero"), keccak256("r1"), 9);
    }

    function testRevertWhenBatchIdMismatch() public {
        // a batchId NOT derived from (TC, num, root) is rejected, binding on-chain identity to content
        vm.expectRevert(RevenueBatchAnchor.BatchIdMismatch.selector);
        anchor.commitBatch(TC, keccak256("arbitrary"), 1, ZERO, keccak256("r1"), 9, SCHEMA, POLICY, ZERO);
    }

    function testRevertWhenBatchNumberNotSequential() public {
        bytes32 root = keccak256("r1");
        // first batch must be number 1 (latest is 0); committing number 2 first reverts
        vm.expectRevert(RevenueBatchAnchor.BatchNumberNotSequential.selector);
        _commit(2, ZERO, root, 9);
    }

    function testPreviousRootChainContinuity() public {
        bytes32 r1 = keccak256("r1");
        bytes32 r2 = keccak256("r2");
        _commit(1, ZERO, r1, 9);
        _commit(2, r1, r2, 9); // chains from r1, number 2
        assertEq(anchor.latestRootByTenant(TC), r2);
        assertEq(anchor.latestBatchNumberByTenant(TC), 2);

        // a third batch chaining from the STALE r1 (not r2) must revert
        vm.expectRevert(RevenueBatchAnchor.PreviousRootMismatch.selector);
        _commit(3, r1, keccak256("r3"), 9);
    }

    function testCommitWorksAtZeroTimestamp() public {
        // batchExists (not committedAt!=0) is the single-commit guard, so a 0-timestamp commit still
        // records and still blocks re-commit.
        vm.warp(0);
        bytes32 root = keccak256("r1");
        _commit(1, ZERO, root, 9);
        assertTrue(anchor.batchExists(_batchId(1, root)));
        vm.expectRevert(RevenueBatchAnchor.BatchAlreadyCommitted.selector);
        _commit(1, ZERO, root, 9);
    }

    function testEmitsBatchCommitted() public {
        bytes32 root = keccak256("r1");
        bytes32 bid = _batchId(1, root);
        vm.expectEmit(true, true, true, true);
        emit RevenueBatchAnchor.BatchCommitted(TC, bid, 1, ZERO, root, 9, SCHEMA, POLICY, ZERO);
        _commit(1, ZERO, root, 9);
    }

    function testOnlyCommitterRole() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RevenueBatchAnchor.MissingRole.selector, committerRole, stranger));
        _commit(1, ZERO, keccak256("r1"), 9);

        anchor.grantRole(committerRole, stranger);
        vm.prank(stranger);
        _commit(1, ZERO, keccak256("r1"), 9);
        assertEq(anchor.latestRootByTenant(TC), keccak256("r1"));
    }

    function testOnlyAdminCanGrantRole() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RevenueBatchAnchor.MissingRole.selector, adminRole, stranger));
        anchor.grantRole(committerRole, stranger);
    }

    function testRevokeRole() public {
        anchor.grantRole(committerRole, stranger);
        assertTrue(anchor.hasRole(committerRole, stranger));

        vm.expectEmit(true, true, true, true);
        emit RevenueBatchAnchor.RoleRevoked(committerRole, stranger, admin);
        anchor.revokeRole(committerRole, stranger);
        assertFalse(anchor.hasRole(committerRole, stranger));

        // revoked key can no longer commit
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RevenueBatchAnchor.MissingRole.selector, committerRole, stranger));
        _commit(1, ZERO, keccak256("r1"), 9);
    }

    function testOnlyAdminCanRevokeRole() public {
        anchor.grantRole(committerRole, stranger);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RevenueBatchAnchor.MissingRole.selector, adminRole, stranger));
        anchor.revokeRole(committerRole, admin);
    }
}

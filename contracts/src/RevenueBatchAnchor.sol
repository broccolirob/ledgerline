// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RevenueBatchAnchor
/// @notice Tamper-evident audit anchor for Ledgerline revenue batches (M4, build-plan §12).
///         Stores ONLY Merkle roots + policy hashes — never raw metadata (§12 never-commit list).
///         Enforces the previous-root chain per tenant so a committed history cannot be forked or
///         silently reordered. Access control is a minimal inline role gate (COMMITTER_ROLE) — no
///         external dependency, so `forge test` is hermetic; functionally equivalent to the §12
///         OpenZeppelin AccessControl sketch for this contract's surface.
contract RevenueBatchAnchor {
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant COMMITTER_ROLE = keccak256("COMMITTER_ROLE");
    /// Must equal `keccak256("LEDGERLINE_BATCH_ID_V1")` off-chain (canonical DOMAIN.BATCH_ID),
    /// so on-chain `batchId` derivation matches the verifier's `batchId()` byte-for-byte.
    bytes32 public constant BATCH_ID_DOMAIN = keccak256("LEDGERLINE_BATCH_ID_V1");

    mapping(bytes32 => mapping(address => bool)) private _roles;

    struct Batch {
        bytes32 tenantCommitment;
        bytes32 batchId;
        uint64 batchNumber;
        bytes32 previousMerkleRoot;
        bytes32 merkleRoot;
        uint64 eventCount; // Merkle leaf count for ANY batch type, not limited to raw events
        bytes32 schemaHash;
        bytes32 metadataPolicyHash;
        bytes32 dataAvailabilityUriHash;
        uint64 committedAt;
    }

    mapping(bytes32 => Batch) public batches; // batchId => Batch
    mapping(bytes32 => bytes32) public latestRootByTenant; // tenantCommitment => latest merkleRoot
    mapping(bytes32 => bool) public batchExists; // batchId => committed? (committedAt can legitimately differ; this is the canonical guard)
    mapping(bytes32 => uint64) public latestBatchNumberByTenant; // tenantCommitment => last committed batchNumber

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event BatchCommitted(
        bytes32 indexed tenantCommitment,
        bytes32 indexed batchId,
        uint64 indexed batchNumber,
        bytes32 previousMerkleRoot,
        bytes32 merkleRoot,
        uint64 eventCount,
        bytes32 schemaHash,
        bytes32 metadataPolicyHash,
        bytes32 dataAvailabilityUriHash
    );

    error BatchAlreadyCommitted();
    error InvalidEventCount();
    error PreviousRootMismatch();
    error BatchIdMismatch();
    error BatchNumberNotSequential();
    error MissingRole(bytes32 role, address account);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(COMMITTER_ROLE, admin);
    }

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert MissingRole(role, msg.sender);
        _;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(role, account);
    }

    /// @notice Revoke a role (admin only) — lets a compromised committer key be cleanly removed.
    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roles[role][account]) {
            _roles[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function _grantRole(bytes32 role, address account) internal {
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    /// @notice Commit one batch root, enforcing single-commit + the per-tenant previous-root chain.
    /// @dev Single-commit is guarded by `batchExists` (NOT `committedAt != 0`) so a batch is never
    ///      re-committable even if `block.timestamp` were ever 0 (test/genesis edge).
    function commitBatch(
        bytes32 tenantCommitment,
        bytes32 batchId,
        uint64 batchNumber,
        bytes32 previousMerkleRoot,
        bytes32 merkleRoot,
        uint64 eventCount,
        bytes32 schemaHash,
        bytes32 metadataPolicyHash,
        bytes32 dataAvailabilityUriHash
    ) external onlyRole(COMMITTER_ROLE) {
        if (batchExists[batchId]) revert BatchAlreadyCommitted();
        if (eventCount == 0) revert InvalidEventCount();
        if (latestRootByTenant[tenantCommitment] != previousMerkleRoot) revert PreviousRootMismatch();
        // Bind on-chain identity to content: batchId MUST be the canonical derivation, so the chain
        // (not just the off-chain verifier) guarantees batchId == keccak(domain, tenant, number, root).
        // abi.encodePacked(bytes32, bytes32, uint64, bytes32) == domain(32)||tc(32)||uint64_be(num)(8)||root(32).
        if (batchId != keccak256(abi.encodePacked(BATCH_ID_DOMAIN, tenantCommitment, batchNumber, merkleRoot))) {
            revert BatchIdMismatch();
        }
        // Per-tenant monotonic sequence (1,2,3,…), so on-chain batchNumber is a trustworthy index
        // consistent with the DB's unique(tenant_id, batch_number).
        if (batchNumber != latestBatchNumberByTenant[tenantCommitment] + 1) revert BatchNumberNotSequential();

        batchExists[batchId] = true;
        latestBatchNumberByTenant[tenantCommitment] = batchNumber;
        batches[batchId] = Batch({
            tenantCommitment: tenantCommitment,
            batchId: batchId,
            batchNumber: batchNumber,
            previousMerkleRoot: previousMerkleRoot,
            merkleRoot: merkleRoot,
            eventCount: eventCount,
            schemaHash: schemaHash,
            metadataPolicyHash: metadataPolicyHash,
            dataAvailabilityUriHash: dataAvailabilityUriHash,
            committedAt: uint64(block.timestamp)
        });

        latestRootByTenant[tenantCommitment] = merkleRoot;

        emit BatchCommitted(
            tenantCommitment,
            batchId,
            batchNumber,
            previousMerkleRoot,
            merkleRoot,
            eventCount,
            schemaHash,
            metadataPolicyHash,
            dataAvailabilityUriHash
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {RevenueBatchAnchor} from "../src/RevenueBatchAnchor.sol";

/// @notice Track-A-gated deploy. Needs a funded deployer key on Arc Testnet (USDC is gas).
///   forge script script/Deploy.s.sol --broadcast --rpc-url $ARC_RPC_URL
/// The deployer becomes admin + COMMITTER_ROLE (it is the anchor:submit committer).
contract Deploy is Script {
    function run() external returns (RevenueBatchAnchor anchor) {
        uint256 pk = vm.envUint("ANCHOR_COMMITTER_KEY");
        address admin = vm.envOr("ANCHOR_ADMIN", vm.addr(pk));
        vm.startBroadcast(pk);
        anchor = new RevenueBatchAnchor(admin);
        vm.stopBroadcast();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// The one block every fork test forks, so a gate run is deterministic: the same chain state on every run and every
/// machine, and forge caches the RPC answers per block (later runs read them from disk).
///
/// BLOCK is Robinhood Chain mainnet (4663) block 115954000, 2026-11-16 18:00:12 UTC (a Monday, US market open).
/// A pinned block needs an archive RPC: the public https://rpc.mainnet.chain.robinhood.com keeps only recent state and
/// answers "historical state ... is not available" for it; the Alchemy mainnet host serves it (checked 2026-11-16).
///
/// RHC_FORK_BLOCK overrides the pin: a block number forks that block, 0 forks the latest block. Latest-block runs are
/// the live canary (.github/scripts/fork-live.sh), never a required gate: live state moves under the assertions.
/// Move the pin forward only after the whole fork suite passes at the new block.
library ForkPin {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant BLOCK = 115_954_000;

    function blockNumber() internal view returns (uint256) {
        return VM.envOr("RHC_FORK_BLOCK", BLOCK);
    }

    /// Forks `url` at the pinned block (or the RHC_FORK_BLOCK override) and selects it.
    function select(string memory url) internal returns (uint256 forkId) {
        uint256 b = blockNumber();
        forkId = b == 0 ? VM.createSelectFork(url) : VM.createSelectFork(url, b);
    }
}

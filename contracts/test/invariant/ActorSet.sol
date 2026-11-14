// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// The system suite's actors: 5 holders, 3 backers, 1 liquidator, 1 keeper, 1 hedger, 1 guardian, 1 timelock proposer
/// and 1 stranger. Holders only buy, sell and queue; backers only run vaults; nobody else touches holder tokens.
struct ActorSet {
    address[5] holders;
    address[3] backers;
    address liquidator;
    address keeper;
    address hedger;
    address guardian;
    address proposer; // the only proposer on the real TimelockController (48 h)
    address stranger;
}

library ActorLib {
    function holder(ActorSet storage a, uint256 seed) internal view returns (address) {
        return a.holders[seed % 5];
    }

    function backer(ActorSet storage a, uint256 seed) internal view returns (address) {
        return a.backers[seed % 3];
    }

    function isHolder(ActorSet storage a, address who) internal view returns (bool) {
        for (uint256 i; i < 5; ++i) {
            if (a.holders[i] == who) return true;
        }
        return false;
    }
}

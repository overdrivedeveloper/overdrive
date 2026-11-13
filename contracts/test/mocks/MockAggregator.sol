// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Chainlink proxy shape: latestRoundData, decimals, aggregator(). Settable round; can revert or return garbage.
contract MockAggregator {
    uint8 public immutable decimals;
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;
    address public aggregator;
    bool public shouldRevert;
    bool public garbage;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
        roundId = 1;
        aggregator = address(this);
    }

    function push(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
        ++roundId;
    }

    function setRound(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        ++roundId;
    }

    function setAggregator(address a) external {
        aggregator = a;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function setGarbage(bool v) external {
        garbage = v;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "feed down");
        if (garbage) {
            assembly {
                mstore(0, 1)
                return(0, 32) // short return data
            }
        }
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

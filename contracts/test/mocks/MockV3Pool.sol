// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Uniswap v3 pool read surface: observe (tick cumulatives) and slot0. Can revert.
contract MockV3Pool {
    int24 public tick;
    uint16 public observationCardinality = 100;
    bool public shouldRevert;
    address public token0;
    address public token1;

    constructor(address token0_, address token1_, int24 tick_) {
        token0 = token0_;
        token1 = token1_;
        tick = tick_;
    }

    function setTick(int24 t) external {
        tick = t;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function setCardinality(uint16 c) external {
        observationCardinality = c;
    }

    /// Constant tick over the whole window: cumulative(t) = tick * (now - t).
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!shouldRevert, "pool down");
        uint256 n = secondsAgos.length;
        tickCumulatives = new int56[](n);
        secondsPerLiquidityCumulativeX128s = new uint160[](n);
        for (uint256 i; i < n; ++i) {
            tickCumulatives[i] = int56(tick) * (int56(uint56(block.timestamp)) - int56(uint56(secondsAgos[i])));
        }
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        require(!shouldRevert, "pool down");
        return (0, tick, 0, observationCardinality, observationCardinality, 0, true);
    }
}

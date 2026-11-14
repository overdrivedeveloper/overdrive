// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Session} from "../../src/interfaces/ODTypes.sol";

/// Calendar with a step schedule: kindAt(ts) is the kind of the last step at or before ts, else the default kind.
contract MockKindCalendar {
    Session public defaultKind;
    uint256[] public stepAt;
    Session[] public stepKind;

    constructor(Session k) {
        defaultKind = k;
    }

    function setKind(Session k) external {
        defaultKind = k;
        delete stepAt;
        delete stepKind;
    }

    /// Steps must be added in ascending time order.
    function addStep(uint256 at, Session k) external {
        stepAt.push(at);
        stepKind.push(k);
    }

    function kindAt(uint256 ts) external view returns (Session k) {
        k = defaultKind;
        for (uint256 i; i < stepAt.length; ++i) {
            if (stepAt[i] > ts) break;
            k = stepKind[i];
        }
    }
}

/// Uniswap v3 pool with an observation ring whose oldest entry is settable. observe() reverts "OLD" when asked
/// further back than the oldest observation, like the real pool. The tick is piecewise constant between setTick calls
/// and the cumulative is exact, so a past spike shows up in later TWAPs by its duration only.
contract MockV3OraclePool {
    address public token0;
    address public token1;
    int24 public tick;
    uint16 public cardinality = 7200;
    uint16 public index = 7199;
    uint32 public oldestTs;
    bool public shouldRevert;
    bool public uninitialised;
    // checkpoints: from cpTs[i] on, the tick was cpTick[i] and the cumulative at cpTs[i] was cpCum[i]
    uint32[] private cpTs;
    int56[] private cpCum;
    int24[] private cpTick;

    constructor(address token0_, address token1_, int24 tick_) {
        token0 = token0_;
        token1 = token1_;
        tick = tick_;
        oldestTs = 0;
        cpTs.push(0);
        cpCum.push(0);
        cpTick.push(tick_);
    }

    function setTick(int24 t) external {
        uint32 nowTs = uint32(block.timestamp);
        int56 c = _cum(nowTs);
        if (cpTs[cpTs.length - 1] == nowTs) {
            cpTick[cpTick.length - 1] = t;
        } else {
            cpTs.push(nowTs);
            cpCum.push(c);
            cpTick.push(t);
        }
        tick = t;
    }

    function setOldest(uint32 ts) external {
        oldestTs = ts;
    }

    function setRing(uint16 card, uint16 idx) external {
        cardinality = card;
        index = idx;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function setUninitialised(bool v) external {
        uninitialised = v;
    }

    function _cum(uint32 t) private view returns (int56) {
        uint256 i = cpTs.length - 1;
        while (i > 0 && cpTs[i] > t) --i;
        return cpCum[i] + int56(cpTick[i]) * (int56(uint56(t)) - int56(uint56(cpTs[i])));
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory c, uint160[] memory l) {
        require(!shouldRevert, "pool down");
        uint256 n = secondsAgos.length;
        c = new int56[](n);
        l = new uint160[](n);
        for (uint256 i; i < n; ++i) {
            uint32 t = uint32(block.timestamp) - secondsAgos[i];
            require(t >= oldestTs, "OLD");
            c[i] = _cum(t);
        }
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        require(!shouldRevert, "pool down");
        return (0, tick, index, cardinality, cardinality, 0, true);
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        require(!shouldRevert, "pool down");
        return (oldestTs, 0, 0, !uninitialised);
    }
}

/// Answers every call (any selector) with a broken response chosen at construction. vm.etch its code onto a source
/// address to break that source. Modes: 0 revert, 1 empty return, 2 one-byte return, 3 burn all gas,
/// 4 maximal words (8 x 0xff..ff), 5 return 7 words of 2^255 (negative / out-of-range values everywhere).
contract BrokenSource {
    uint8 public immutable mode;

    constructor(uint8 mode_) {
        mode = mode_;
    }

    fallback() external {
        uint8 m = mode;
        if (m == 0) revert("broken");
        if (m == 1) return;
        if (m == 2) {
            assembly {
                mstore(0, 0)
                return(0, 1)
            }
        }
        if (m == 3) {
            while (true) {}
        }
        if (m == 4) {
            assembly {
                for { let i := 0 } lt(i, 8) { i := add(i, 1) } { mstore(mul(i, 32), not(0)) }
                return(0, 256)
            }
        }
        assembly {
            for { let i := 0 } lt(i, 8) { i := add(i, 1) } { mstore(mul(i, 32), shl(255, 1)) }
            return(0, 256)
        }
    }
}

/// An address with code that is not a Chainlink proxy (stands in for the aggregator behind a proxy).
contract MockAggregatorImpl {
    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        return (0, 0, 0, 0, 0);
    }
}

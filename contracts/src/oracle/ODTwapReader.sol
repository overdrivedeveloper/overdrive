// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ODTickPrice} from "./ODTickPrice.sol";

/// @title ODTwapReader
/// @notice Uniswap v3 time-weighted price of a token in its quote token, as a WAD number of quote units per whole
/// token. Every pool call is a gas-capped staticcall whose return data is checked word by word, so a reverting,
/// gas-burning or malformed pool reads 0 ("unavailable") and never reverts.
/// @dev The reference is used only to decide whether buys may proceed; it never replaces the feed price. A window is
/// served only when the pool's oldest initialised observation is at least `window` old (the observation ring covers
/// the whole window) and `observe([window, 0])` succeeds. Spot (slot0 tick) is never used as a price.
library ODTwapReader {
    uint256 internal constant READ_GAS = 300_000;
    uint256 internal constant SLOT0_BYTES = 224; // 7 words
    uint256 internal constant OBSERVATION_BYTES = 128; // 4 words

    struct Source {
        address pool;
        uint32 window;
        bool baseIsToken0;
        uint8 scaleExp; // 18 + baseDecimals - quoteDecimals
    }

    /// @return price WAD quote per whole base token; 0 when the pool cannot serve the window or the result exceeds maxP.
    function price(Source memory src, uint256 maxP) internal view returns (uint256) {
        if (src.pool == address(0) || src.window == 0 || src.pool.code.length == 0) return 0;
        if (oldestObservationAge(src.pool) < src.window) return 0;
        (bool ok, int256 meanTick) = meanTickOver(src.pool, src.window);
        if (!ok) return 0;
        return tickToPrice(meanTick, src.baseIsToken0, src.scaleExp, maxP);
    }

    /// @notice Mean tick over [now - window, now], rounded toward negative infinity as Uniswap's OracleLibrary.
    function meanTickOver(address pool, uint32 window) internal view returns (bool ok, int256 meanTick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        bytes memory data;
        (ok, data) = pool.staticcall{gas: READ_GAS}(abi.encodeWithSignature("observe(uint32[])", ago));
        // (int56[], uint160[]) with two entries each: two offsets plus two (length, a, b) blocks = 256 bytes.
        if (!ok || data.length < 256) return (false, 0);
        uint256 off = _word(data, 0);
        if (off > data.length - 96) return (false, 0);
        uint256 len;
        int256 c0;
        int256 c1;
        assembly ("memory-safe") {
            let p := add(add(data, 32), off)
            len := mload(p)
            c0 := mload(add(p, 32))
            c1 := mload(add(p, 64))
        }
        if (len < 2 || c0 != int256(int56(c0)) || c1 != int256(int56(c1))) return (false, 0);
        int256 delta = c1 - c0;
        int256 span = int256(uint256(window));
        meanTick = delta / span;
        if (delta < 0 && delta % span != 0) --meanTick;
        if (meanTick > ODTickPrice.MAX_TICK || meanTick < -ODTickPrice.MAX_TICK) return (false, 0);
        return (true, meanTick);
    }

    /// @notice WAD quote per whole base token at `tick`; 0 when out of range or above maxP (never reverts).
    function tickToPrice(int256 tick, bool baseIsToken0, uint8 scaleExp, uint256 maxP)
        internal
        pure
        returns (uint256 p)
    {
        if (tick > ODTickPrice.MAX_TICK || tick < -ODTickPrice.MAX_TICK || scaleExp > 60) return 0;
        uint256 px = ODTickPrice.priceX128(int24(tick));
        if (px == 0) return 0;
        uint256 scale = 10 ** uint256(scaleExp);
        // Bound before scaling, so an extreme tick reads unavailable instead of overflowing mulDiv.
        if (baseIsToken0) {
            if (px > Math.mulDiv(maxP, ODTickPrice.Q128, scale)) return 0;
            p = Math.mulDiv(px, scale, ODTickPrice.Q128);
        } else {
            if (px < Math.mulDiv(scale, ODTickPrice.Q128, maxP, Math.Rounding.Ceil)) return 0;
            p = Math.mulDiv(scale, ODTickPrice.Q128, px);
        }
        if (p > maxP) return 0;
    }

    /// @notice Seconds since the pool's oldest initialised observation (0 on any failure). Reads slot0 for the ring
    /// index and cardinality, then the slot after the index (or slot 0 while the ring has not wrapped).
    function oldestObservationAge(address pool) internal view returns (uint256 age) {
        (bool ok, bytes memory data) = pool.staticcall{gas: READ_GAS}(abi.encodeWithSignature("slot0()"));
        if (!ok || data.length < SLOT0_BYTES) return 0;
        uint256 index = _word(data, 2);
        uint256 card = _word(data, 3);
        if (card == 0 || card > type(uint16).max || index >= card) return 0;
        (bool okNext, uint256 ts, bool init) = _observation(pool, (index + 1) % card);
        if (!okNext) return 0;
        if (!init) {
            (ok, ts, init) = _observation(pool, 0);
            if (!ok || !init) return 0;
        }
        if (ts > block.timestamp) return 0;
        age = block.timestamp - ts;
    }

    function _observation(address pool, uint256 i) private view returns (bool ok, uint256 ts, bool init) {
        bytes memory data;
        (ok, data) = pool.staticcall{gas: READ_GAS}(abi.encodeWithSignature("observations(uint256)", i));
        if (!ok || data.length < OBSERVATION_BYTES) return (false, 0, false);
        ts = _word(data, 0);
        uint256 flag = _word(data, 3);
        if (ts > type(uint32).max || flag > 1) return (false, 0, false);
        init = flag == 1;
    }

    function _word(bytes memory data, uint256 i) private pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 32), mul(i, 32)))
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MarketConfig, PriceReading, Session} from "overdrive/interfaces/ODTypes.sol";

/// A minimal oracle guard for registry tests: per-market price, freshness, buys-paused and enabled flags.
contract MockGearGuard {
    mapping(bytes32 => PriceReading) internal _r;
    mapping(bytes32 => bool) internal _enabled;

    function setMarket(bytes32 m, uint256 p, bool fresh, bool paused, bool enabled) external {
        _r[m] = PriceReading({
            p: p,
            refP: p,
            session: Session.OPEN,
            fresh: fresh,
            buysPaused: paused,
            reason: paused ? bytes32("MANUAL") : bytes32(0),
            updatedAt: uint64(block.timestamp)
        });
        _enabled[m] = enabled;
    }

    function config(bytes32 m) external view returns (MarketConfig memory c) {
        c.enabled = _enabled[m];
    }

    function read(bytes32 m) public view returns (PriceReading memory) {
        return _r[m];
    }

    function readRatio(bytes32 a, bytes32 b) external view returns (PriceReading memory r) {
        PriceReading memory ra = read(a);
        PriceReading memory rb = read(b);
        r.p = rb.p == 0 ? 0 : ra.p * 1e18 / rb.p;
        r.fresh = ra.fresh && rb.fresh;
        r.buysPaused = ra.buysPaused || rb.buysPaused;
    }
}

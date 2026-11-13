// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

enum Session {
    OPEN, // OPEN = regular (stocks) or always (ETH, BTC)
    EXTENDED,
    CLOSED,
    UNKNOWN,
    HALTED
}
enum Gear {
    CRUISE, // p = 1.5, 2, 3, 0.5, -1
    SPORT,
    RACE,
    ECO,
    REVERSE
}
enum GearStatus {
    NONE,
    LISTED,
    BUYS_PAUSED,
    SELL_ONLY,
    SETTLED
}

struct PriceReading {
    uint256 p; // WAD, Chainlink-derived, multiplier applied once; last good price when not live
    uint256 refP; // WAD reference (Pyth if fresh, else v3 TWAP); 0 = unavailable (fail closed)
    Session session;
    bool fresh; // live in-session reading, or CLOSED/UNKNOWN with a last good price inside maxAgeClosed
    bool buysPaused;
    bytes32 reason; // "MANUAL","DISABLED","SPLIT_PENDING","CONTINUITY","HALTED","REF_BAND","REF_UNAVAILABLE", 0
    uint64 updatedAt;
}

struct MarketConfig {
    address feed; // Chainlink PROXY (never the aggregator)
    address stockToken; // ERC-8056 Stock Token; address(0) for ETH, BTC
    bool multiplierEmbedded; // per feed, from docs/research/feeds.json
    bool pythMultiplierEmbedded;
    bool alwaysOpen; // 24/7 market
    bytes32 pythId; // 0 = none (TWAP fallback)
    address twapPool; // Uniswap v3 underlying/USDG pool; 0 = none
    uint32 maxAgeOpen;
    uint32 maxAgeExtended;
    uint32 maxAgeClosed;
    uint32 refMaxAge; // Pyth publishTime max age
    uint32 twapWindow;
    uint16 refBandBps; // max |p/refP - 1| for buys
    uint16 continuityBps;
    bool enabled;
}

struct GearConfig {
    bytes32 marketA; // underlying, or pair numerator
    bytes32 marketB; // bytes32(0) single name; pair denominator
    Gear gear;
    address token;
    uint256 p0; // WAD price (or ratio) at listing
    uint128 unitWad; // WAD USD value per token at NF = 1, I = 1
    uint128 capUsdWad; // max open value of holder tokens net of backer debt
    uint16 spreadBps; // base spread (spec section 4)
    uint16 collateralBps; // backer initial: 20000 (RACE 25000)
    uint16 maintenanceBps; // backer maintenance: 15000 (RACE 20000)
    GearStatus status;
    uint64 listedAt;
}

struct NormState {
    uint128 nf; // WAD, starts 1e18
    int128 tollPerSecWad; // signed toll per second stored for the next interval
    uint64 lastAccrual;
    uint256 cumTollPerTokenWad; // cumulative positive toll value per token (USD WAD), for backer fee accounting
}

struct Quote {
    uint256 amountIn; // USDG (buy) or tokens (sell)
    uint256 amountOut; // tokens (buy) or USDG (sell)
    uint256 valuePerTokenWad; // after the trade's own accrual
    uint256 pricePerTokenWad; // value +/- spread actually charged
    uint16 spreadBps;
    uint256 protocolFeeUsdg;
    int256 tollPerDayWad;
    Session session;
    bool queued; // sell would be queued, not paid
}

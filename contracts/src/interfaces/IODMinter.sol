// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./ODTypes.sol";

interface IODMinter {
    /// Trade parameters (admin, timelock). Bounds are checked by `setTradeParams`.
    struct TradeParams {
        uint16 extendedSpreadMultBps; // 15000: x1.5 in EXTENDED
        uint16 closedSellExtraBps; // 50: added on CLOSED, UNKNOWN and HALTED sells
        uint16 inventorySlopeBps; // skew = slope x |net value after| / cap, only when the trade grows |net|
        uint16 maxSkewBps; // 150
        uint16 maxTotalSpreadBps; // 500
        uint64 minTradeUsdg; // 1e6
        uint128 usageMaxWad; // usage term at full cap per year, default 0.05e18, <= 0.2e18
        uint32 settleAfterHalt; // 30 days
    }

    event Bought(
        bytes32 indexed gearId,
        address indexed payer,
        address indexed recipient,
        uint256 usdgIn,
        uint256 tokensOut,
        uint256 valuePerTokenWad,
        uint16 spreadBps,
        bool viaHook
    );
    event Sold(
        bytes32 indexed gearId,
        address indexed seller,
        address indexed recipient,
        uint256 tokensIn,
        uint256 usdgOut,
        uint256 valuePerTokenWad,
        uint16 spreadBps,
        bool viaHook,
        Session session
    );
    event SellQueued(
        uint256 indexed ticket, bytes32 indexed gearId, address indexed owner, uint256 tokens, uint256 minUsdgOut
    );
    event QueueFilled(uint256 indexed ticket, uint256 usdgOut, uint256 valuePerTokenWad);
    event QueueCancelled(uint256 indexed ticket);
    event Accrued(bytes32 indexed gearId, uint256 nf, int256 tollPerSecWad, uint256 dt, uint256 tollValueUsdWad);
    event GearSettled(bytes32 indexed gearId, uint256 finalValuePerTokenWad);
    error Expired();
    error Slippage(uint256 got, uint256 limit);
    error BuysClosed(bytes32 gearId, bytes32 reason);
    error BelowMinimum();
    error UseQueue(); // sell cannot be paid now (closed with no reference, payout failed): call queueSell
    error NotHook();
    error NotTicketOwner(uint256 ticket);
    error NotFillable(uint256 ticket);
    // 05b additions
    event HookSet(address hook, address poolManager);
    event StakeSet(address stake);
    event TradeParamsSet(TradeParams p);
    error UnknownGear(bytes32 gearId);
    error NotSettleable(bytes32 gearId);
    error ZeroAddress();
    error InvalidParams();
    error AlreadySet();
    function buy(bytes32 gearId, uint256 usdgIn, uint256 minTokensOut, address recipient, uint64 deadline)
        external
        returns (uint256 tokensOut);
    function buyExactTokens(bytes32 gearId, uint256 tokensOut, uint256 maxUsdgIn, address recipient, uint64 deadline)
        external
        returns (uint256 usdgIn);
    function sell(bytes32 gearId, uint256 tokensIn, uint256 minUsdgOut, address recipient, uint64 deadline)
        external
        returns (uint256 usdgOut);
    function sellForExactUsdg(bytes32 gearId, uint256 usdgOut, uint256 maxTokensIn, address recipient, uint64 deadline)
        external
        returns (uint256 tokensIn);
    function queueSell(bytes32 gearId, uint256 tokens, uint256 minUsdgOut, address recipient)
        external
        returns (uint256 ticket);
    function fillQueued(uint256 ticket) external returns (uint256 usdgOut); // anyone, at the next fresh price
    function cancelQueued(uint256 ticket) external; // ticket owner, never blocked
    // hook path: the hook has already moved currencies with the PoolManager; see todo 06a for the sequence
    function hookSwap(bytes32 gearId, bool isBuy, bool exactIn, uint256 amount, address tokenSink)
        external
        returns (uint256 amountIn, uint256 amountOut);
    function quote(bytes32 gearId, bool isBuy, bool exactIn, uint256 amount) external view returns (Quote memory);
    function accrue(bytes32 gearId) external returns (uint256 nf);
    function accrueMany(bytes32[] calldata gearIds) external;
    function settleGear(bytes32 gearId) external; // admin (timelock): feed halted >= 30 days or index out of domain
    function valuePerToken(bytes32 gearId) external view returns (uint256 valueWad, bool inDomain);
    function normState(bytes32 gearId) external view returns (NormState memory);
    function tollPerDay(bytes32 gearId) external view returns (int256 tollWad);
    function queuedSell(uint256 ticket)
        external
        view
        returns (bytes32 gearId, address owner, address recipient, uint256 tokens, uint256 minUsdgOut);
    // 05b additions
    function setHook(address hook) external; // admin, once; the PoolManager is read from hook.poolManager()
    function setStake(address stake) external; // admin: spread discount source (gas-capped read, 0 on failure)
    function setTradeParams(TradeParams calldata p) external; // admin (timelock), bounds checked
    function tradeParams() external view returns (TradeParams memory);
    function settledValue(bytes32 gearId) external view returns (uint256); // 0 = not settled
    function ticketCount() external view returns (uint256);
    function hook() external view returns (address);
    function poolManager() external view returns (address);
    function stake() external view returns (address);
    // 07a additions: gear tokens for backer vaults. Only the Governor's backer may call; it mints only to a vault
    // owner (a mint not sold to the Governor) and burns only the repayer's own tokens (repay).
    error NotBacker();
    function backerMint(bytes32 gearId, address to, uint256 tokens) external;
    function backerBurn(bytes32 gearId, address from, uint256 tokens) external;
}

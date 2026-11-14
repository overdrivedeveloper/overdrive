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
        uint16 lagBandBps; // 50: price move both sources may not show yet (feed deviation); sets the spread floor
    }

    /// @notice Emitted when gear tokens are bought.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param payer The account that paid.
    /// @param recipient The address that receives the output.
    /// @param usdgIn Amount of USDG paid in, in 6-decimal units.
    /// @param tokensOut Amount of gear tokens paid out (18 decimals).
    /// @param valuePerTokenWad Value of one gear token in USD, WAD (18 decimals).
    /// @param spreadBps Spread in basis points.
    /// @param viaHook The via hook.
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
    /// @notice Emitted when gear tokens are sold.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param seller The account that sold.
    /// @param recipient The address that receives the output.
    /// @param tokensIn Amount of gear tokens paid in (18 decimals).
    /// @param usdgOut Amount of USDG paid out, in 6-decimal units.
    /// @param valuePerTokenWad Value of one gear token in USD, WAD (18 decimals).
    /// @param spreadBps Spread in basis points.
    /// @param viaHook The via hook.
    /// @param session The market session kind at execution.
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
    /// @notice Emitted when a sell is queued for a later price.
    /// @param ticket Id of the ticket.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param owner The owner account.
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param minUsdgOut Minimum USDG to receive, else the call reverts.
    event SellQueued(
        uint256 indexed ticket, bytes32 indexed gearId, address indexed owner, uint256 tokens, uint256 minUsdgOut
    );
    /// @notice Emitted when a queued sell is filled.
    /// @param ticket Id of the ticket.
    /// @param usdgOut Amount of USDG paid out, in 6-decimal units.
    /// @param valuePerTokenWad Value of one gear token in USD, WAD (18 decimals).
    event QueueFilled(uint256 indexed ticket, uint256 usdgOut, uint256 valuePerTokenWad);
    /// @notice Emitted when a queued sell is cancelled.
    /// @param ticket Id of the ticket.
    event QueueCancelled(uint256 indexed ticket);
    /// @notice Emitted when the toll and norm factor of a gear are accrued.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param nf The accrued norm factor, WAD.
    /// @param tollPerSecWad The toll per sec, WAD (18 decimals).
    /// @param dt The dt.
    /// @param tollValueUsdWad The toll value usd, WAD (18 decimals).
    event Accrued(bytes32 indexed gearId, uint256 nf, int256 tollPerSecWad, uint256 dt, uint256 tollValueUsdWad);
    /// @notice Emitted when a gear is settled at its final value.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param finalValuePerTokenWad The final value per token, WAD (18 decimals).
    event GearSettled(bytes32 indexed gearId, uint256 finalValuePerTokenWad);
    /// @notice Reverts when the deadline has passed.
    error Expired();
    /// @notice Reverts when the result is worse than the caller's limit.
    /// @param got The amount obtained.
    /// @param limit The limit the caller set.
    error Slippage(uint256 got, uint256 limit);
    /// @notice Reverts when buys are closed for the gear, with the reason code.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param reason Reason code (bytes32 tag).
    error BuysClosed(bytes32 gearId, bytes32 reason);
    /// @notice Reverts when the trade is below the minimum trade size.
    error BelowMinimum();
    /// @notice Reverts when a sell cannot be paid now (closed with no reference, or the payout failed); call queueSell
    /// instead.
    error UseQueue(); // sell cannot be paid now (closed with no reference, payout failed): call queueSell
    /// @notice Reverts when the caller is not the hook.
    error NotHook();
    /// @notice Reverts when the caller does not own the ticket.
    /// @param ticket Id of the ticket.
    error NotTicketOwner(uint256 ticket);
    /// @notice Reverts when a queued sell cannot be filled yet.
    /// @param ticket Id of the ticket.
    error NotFillable(uint256 ticket);
    // 05b additions
    /// @notice Emitted when the hook and pool manager are set.
    /// @param hook Address of the hook.
    /// @param poolManager The pool manager.
    event HookSet(address hook, address poolManager);
    /// @notice Emitted when the stake contract is set.
    /// @param stake Address of the stake contract (zero for none).
    event StakeSet(address stake);
    /// @notice Emitted when the trade parameters change.
    /// @param p The parameter struct.
    event TradeParamsSet(TradeParams p);
    /// @notice Reverts when the gear id is not registered.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    error UnknownGear(bytes32 gearId);
    /// @notice Reverts when the gear cannot be settled yet.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    error NotSettleable(bytes32 gearId);
    /// @notice Reverts when an address argument is zero.
    error ZeroAddress();
    /// @notice Reverts when parameters are outside their bounds.
    error InvalidParams();
    /// @notice Reverts when a once-only setting is set again.
    error AlreadySet();
    /// @notice Buys gear tokens with USDG.
    /// @dev Reverts with Expired, Slippage, BelowMinimum or BuysClosed.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param usdgIn Amount of USDG paid in, in 6-decimal units.
    /// @param minTokensOut Minimum gear tokens to receive, else the call reverts.
    /// @param recipient The address that receives the output.
    /// @param deadline Latest timestamp at which the call may execute.
    /// @return tokensOut  tokensOut=Gear tokens delivered to the recipient.
    function buy(bytes32 gearId, uint256 usdgIn, uint256 minTokensOut, address recipient, uint64 deadline)
        external
        returns (uint256 tokensOut);
    /// @notice Buys an exact amount of gear tokens, paying at most `maxUsdgIn`.
    /// @dev Reverts with Expired, Slippage, BelowMinimum or BuysClosed.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tokensOut Amount of gear tokens paid out (18 decimals).
    /// @param maxUsdgIn Maximum USDG the caller will pay, else the call reverts.
    /// @param recipient The address that receives the output.
    /// @param deadline Latest timestamp at which the call may execute.
    /// @return usdgIn  Amount of USDG paid in, in 6-decimal units.
    function buyExactTokens(bytes32 gearId, uint256 tokensOut, uint256 maxUsdgIn, address recipient, uint64 deadline)
        external
        returns (uint256 usdgIn);
    /// @notice Sells gear tokens for USDG.
    /// @dev Reverts with Expired, Slippage, BelowMinimum, or UseQueue when the sell cannot be paid now.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tokensIn Amount of gear tokens paid in (18 decimals).
    /// @param minUsdgOut Minimum USDG to receive, else the call reverts.
    /// @param recipient The address that receives the output.
    /// @param deadline Latest timestamp at which the call may execute.
    /// @return usdgOut  Amount of USDG paid out, in 6-decimal units.
    function sell(bytes32 gearId, uint256 tokensIn, uint256 minUsdgOut, address recipient, uint64 deadline)
        external
        returns (uint256 usdgOut);
    /// @notice Sells gear tokens for an exact amount of USDG, paying at most `maxTokensIn`.
    /// @dev Same reverts as sell.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param usdgOut Amount of USDG paid out, in 6-decimal units.
    /// @param maxTokensIn Maximum gear tokens the caller will pay, else the call reverts.
    /// @param recipient The address that receives the output.
    /// @param deadline Latest timestamp at which the call may execute.
    /// @return tokensIn  Amount of gear tokens paid in (18 decimals).
    function sellForExactUsdg(bytes32 gearId, uint256 usdgOut, uint256 maxTokensIn, address recipient, uint64 deadline)
        external
        returns (uint256 tokensIn);
    /// @notice Escrows gear tokens to be sold at the next fresh price.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param minUsdgOut Minimum USDG to receive, else the call reverts.
    /// @param recipient The address that receives the output.
    /// @return ticket  ticket=Id of the queued sell.
    function queueSell(bytes32 gearId, uint256 tokens, uint256 minUsdgOut, address recipient)
        external
        returns (uint256 ticket);
    /// @notice Fills a queued sell at the next fresh price.
    /// @dev Anyone may call. Reverts with NotFillable.
    /// @param ticket Id of the ticket.
    /// @return usdgOut  Amount of USDG paid out, in 6-decimal units.
    function fillQueued(uint256 ticket) external returns (uint256 usdgOut); // anyone, at the next fresh price
    /// @notice Cancels a queued sell and returns the tokens.
    /// @dev Ticket owner only (NotTicketOwner otherwise); never blocked.
    /// @param ticket Id of the ticket.
    function cancelQueued(uint256 ticket) external; // ticket owner, never blocked
    // hook path: the hook has already moved currencies with the PoolManager; see todo 06a for the sequence
    /// @notice Executes a swap routed through the hook, after the hook has moved currencies with the pool manager.
    /// @dev Hook only (NotHook otherwise).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param isBuy True for a buy of gear tokens.
    /// @param exactIn True when `amount` is the input amount.
    /// @param amount The amount, in the units of the asset concerned.
    /// @param tokenSink Address that receives the tokens the hook takes in.
    /// @return amountIn  Amount of the input token.
    /// @return amountOut  Amount of the output token received.
    function hookSwap(bytes32 gearId, bool isBuy, bool exactIn, uint256 amount, address tokenSink)
        external
        returns (uint256 amountIn, uint256 amountOut);
    /// @notice Quotes a trade without executing it.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param isBuy True for a buy of gear tokens.
    /// @param exactIn True when `amount` is the input amount.
    /// @param amount The amount, in the units of the asset concerned.
    /// @return  The returned Quote value.
    function quote(bytes32 gearId, bool isBuy, bool exactIn, uint256 amount) external view returns (Quote memory);
    /// @notice Accrues the toll and norm factor of a gear to now.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return nf  The accrued norm factor, WAD.
    function accrue(bytes32 gearId) external returns (uint256 nf);
    /// @notice Accrues several gears.
    /// @param gearIds Ids of the gears.
    function accrueMany(bytes32[] calldata gearIds) external;
    /// @notice Settles a gear at its final value.
    /// @dev Admin (timelock) only; allowed when the feed has been halted for the settle period or the index is out of
    /// domain (NotSettleable otherwise).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    function settleGear(bytes32 gearId) external; // admin (timelock): feed halted >= 30 days or index out of domain
    /// @notice Returns the value of one gear token.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return valueWad  Value in USD, WAD (18 decimals).
    /// @return inDomain  True when the index is inside its valid domain.
    function valuePerToken(bytes32 gearId) external view returns (uint256 valueWad, bool inDomain);
    /// @notice Returns the norm state of a gear.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return  The returned NormState value.
    function normState(bytes32 gearId) external view returns (NormState memory);
    /// @notice Returns the toll per day of a gear.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return tollWad  tollWad=Toll per day, WAD (negative pays holders).
    function tollPerDay(bytes32 gearId) external view returns (int256 tollWad);
    /// @notice Returns a queued sell.
    /// @param ticket Id of the ticket.
    /// @return gearId  Id of the gear (the registry key derived from its market pair and kind).
    /// @return owner  The owner account.
    /// @return recipient  The address that receives the output.
    /// @return tokens  Amount of gear tokens (18 decimals).
    /// @return minUsdgOut  Minimum USDG to receive, else the call reverts.
    function queuedSell(uint256 ticket)
        external
        view
        returns (bytes32 gearId, address owner, address recipient, uint256 tokens, uint256 minUsdgOut);
    // 05b additions
    /// @notice Sets the hook; the pool manager is read from hook.poolManager().
    /// @dev Admin only, once.
    /// @param hook Address of the hook.
    function setHook(address hook) external; // admin, once; the PoolManager is read from hook.poolManager()
    /// @notice Sets the stake contract used as the spread discount source.
    /// @dev Admin only. The read is gas-capped and counts as zero on failure.
    /// @param stake Address of the stake contract (zero for none).
    function setStake(address stake) external; // admin: spread discount source (gas-capped read, 0 on failure)
    /// @notice Sets the trade parameters.
    /// @dev Admin (timelock) only, bounds checked (InvalidParams).
    /// @param p The parameter struct.
    function setTradeParams(TradeParams calldata p) external; // admin (timelock), bounds checked
    /// @notice Returns the trade parameters.
    /// @return  The parameter struct.
    function tradeParams() external view returns (TradeParams memory);
    /// @notice Returns the final value per token of a settled gear.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return  Final value, WAD; zero if not settled.
    function settledValue(bytes32 gearId) external view returns (uint256); // 0 = not settled
    /// @notice Returns the number of queued-sell tickets.
    /// @return  The ticket count.
    function ticketCount() external view returns (uint256);
    /// @notice Returns the hook address.
    /// @return  The hook.
    function hook() external view returns (address);
    /// @notice Returns the pool manager address.
    /// @return  The pool manager.
    function poolManager() external view returns (address);
    /// @notice Returns the stake contract address.
    /// @return  The stake contract.
    function stake() external view returns (address);
    // 07a additions: gear tokens for backer vaults. Only the Governor's backer may call; it mints only to a vault
    // owner (a mint not sold to the Governor) and burns only the repayer's own tokens (repay).
    /// @notice Reverts when the caller is not the Governor's backer.
    error NotBacker();
    /// @notice Mints gear tokens to a vault owner for a backer vault.
    /// @dev Backer only (NotBacker otherwise).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param to The recipient address.
    /// @param tokens Amount of gear tokens (18 decimals).
    function backerMint(bytes32 gearId, address to, uint256 tokens) external;
    /// @notice Burns the repayer's own gear tokens for a backer repayment.
    /// @dev Backer only (NotBacker otherwise).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param from The source address.
    /// @param tokens Amount of gear tokens (18 decimals).
    function backerBurn(bytes32 gearId, address from, uint256 tokens) external;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

interface IODGovernor is IERC4626 {
    /// Risk and cash parameters (admin, timelock). Bounds are checked by `setParams`.
    struct Params {
        uint16 stressBudgetBps; // worst stress loss <= this x equity (1500)
        uint16 capScaleBps; // per-gear cap also <= this x equity (5000)
        uint16 exitReserveFloorBps; // floor = max(minExitReserveUsdg, this x holder open value) (1000)
        uint64 minExitReserveUsdg; // 1,000e6
        uint16 maxHedgeEquityBps; // hedge equity after sendToHedger <= this x equity (3000)
        uint16 maxHedgeJumpBps; // unexplained hedge change per post AND per hedgeMaxAge window <= this x equity (500)
        uint32 hedgeMaxAge; // a hedge post older than this pauses buys (2 h)
        uint32 equityMaxAge; // cached equity older than this pauses buys (1 h)
        uint16 drawdownBps; // share price this far under its 30-day peak pauses buys (1000)
        uint32 withdrawDelay; // requestWithdraw to claim (72 h)
        uint16 shockStockBps; // 2500
        uint16 shockEtfBps; // 1500
        uint16 shockCryptoBps; // 3000
        uint16 shockPairBps; // 2000, on the ratio
    }

    /// @notice Emitted when the book of a gear (net tokens and backer debt) changes.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param netTokens The net tokens.
    /// @param backerDebtTokens The backer debt tokens.
    event BookUpdated(bytes32 indexed gearId, int256 netTokens, uint256 backerDebtTokens);
    /// @notice Emitted when the Governor pays USDG out, from free cash or the exit reserve.
    /// @param to The recipient address.
    /// @param usdg Amount of USDG, in 6-decimal units.
    /// @param fromExitReserve The from exit reserve.
    event PaidOut(address indexed to, uint256 usdg, bool fromExitReserve);
    /// @notice Emitted when USDG moves into the exit reserve.
    /// @param amount The amount, in the units of the asset concerned.
    /// @param balanceAfter The balance after.
    event ExitReserveMoved(uint256 amount, uint256 balanceAfter);
    /// @notice Emitted when the hedger posts the hedge state of a market.
    /// @param market Market id (bytes32 symbol key).
    /// @param hedgeDeltaWad The hedge delta, WAD (18 decimals).
    /// @param hedgeEquityUsdg The hedge equity, in USDG (6 decimals).
    /// @param asOf The as of.
    event HedgePosted(bytes32 indexed market, int256 hedgeDeltaWad, uint256 hedgeEquityUsdg, uint64 asOf);
    /// @notice Emitted when USDG is sent to the hedger wallet.
    /// @param to The recipient address.
    /// @param usdg Amount of USDG, in 6-decimal units.
    event SentToHedger(address indexed to, uint256 usdg);
    /// @notice Emitted when a withdrawal ticket is queued.
    /// @param owner The owner account.
    /// @param ticket Id of the ticket.
    /// @param shares Amount of shares (vault share decimals).
    /// @param claimableAt The claimable at.
    event WithdrawalQueued(address indexed owner, uint256 indexed ticket, uint256 shares, uint64 claimableAt);
    /// @notice Emitted when a withdrawal ticket is claimed.
    /// @param owner The owner account.
    /// @param ticket Id of the ticket.
    /// @param usdg Amount of USDG, in 6-decimal units.
    event WithdrawalClaimed(address indexed owner, uint256 indexed ticket, uint256 usdg);
    /// @notice Emitted when the risk cache is refreshed.
    /// @param stressLossWad The stress loss, WAD (18 decimals).
    /// @param budgetWad Stress budget in USD, WAD (18 decimals).
    /// @param equityWad Equity in USD, WAD (18 decimals).
    event RiskPoked(uint256 stressLossWad, uint256 budgetWad, int256 equityWad);
    /// @notice Emitted when buys are paused or unpaused.
    /// @param paused True to pause, false to unpause.
    event BuysPausedSet(bool paused);
    /// @notice Emitted when the risk and cash parameters change.
    /// @param p The parameter struct.
    event ParamsSet(Params p);
    /// @notice Emitted when a module address is wired.
    /// @param what The what.
    /// @param module The module.
    event ModuleSet(bytes32 indexed what, address module);
    /// @notice Emitted when a market is assigned to a shock group.
    /// @param market Market id (bytes32 symbol key).
    /// @param group The group.
    event MarketGroupSet(bytes32 indexed market, uint8 group);
    /// @notice Emitted when a depositor is allowed or removed.
    /// @param account The account concerned.
    /// @param allowed True to allow, false to disallow.
    event DepositorSet(address indexed account, bool allowed);
    /// @notice Emitted when a fee is paid to ODFees.
    /// @param kind Kind tag (bytes32).
    /// @param usdg Amount of USDG, in 6-decimal units.
    event FeePaid(bytes32 indexed kind, uint256 usdg);
    /// @notice Emitted when a fee could not be paid and is owed.
    /// @param kind Kind tag (bytes32).
    /// @param usdg Amount of USDG, in 6-decimal units.
    /// @param owedAfter The owed after.
    event FeeOwed(bytes32 indexed kind, uint256 usdg, uint256 owedAfter);
    /// @notice Emitted when a toll accrual is booked.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tollValueUsdWad The toll value usd, WAD (18 decimals).
    /// @param feeUsdg Fee amount in USDG.
    event TollBooked(bytes32 indexed gearId, int256 tollValueUsdWad, uint256 feeUsdg);
    /// @notice Emitted when the hedger returns USDG.
    /// @param from The source address.
    /// @param usdg Amount of USDG, in 6-decimal units.
    event ReturnedFromHedger(address indexed from, uint256 usdg);
    /// @notice Emitted when USDG is added to tracked cash.
    /// @param from The source address.
    /// @param usdg Amount of USDG, in 6-decimal units.
    event CashFunded(address indexed from, uint256 usdg);
    /// @notice Emitted when the Governor draws on the insurance fund.
    /// @param requested Amount requested.
    /// @param received Amount received.
    event InsuranceDrawn(uint256 requested, uint256 received);
    /// @notice Emitted when surplus USDG is skimmed to the insurance fund.
    /// @param usdg Amount of USDG, in 6-decimal units.
    event Skimmed(uint256 usdg);
    /// @notice Emitted when the Governor absorbs a liquidation.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param debtTokens Debt in gear tokens (18 decimals).
    /// @param collateralUsdg Collateral amount in USDG, in 6-decimal units.
    event Liquidation(bytes32 indexed gearId, uint256 debtTokens, uint256 collateralUsdg);
    /// @notice Reverts when the caller is not the minter.
    error NotMinter();
    /// @notice Reverts when the caller is not the backer.
    error NotBacker();
    /// @notice Reverts when a buy would push a gear over its open-value cap.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param openWad Open value in USD, WAD (18 decimals).
    /// @param capWad Cap in USD, WAD (18 decimals).
    error CapExceeded(bytes32 gearId, uint256 openWad, uint256 capWad);
    /// @notice Reverts when a buy would push the stress loss over the stress budget.
    /// @param lossWad Stress loss in USD, WAD (18 decimals).
    /// @param budgetWad Stress budget in USD, WAD (18 decimals).
    error StressBudget(uint256 lossWad, uint256 budgetWad);
    /// @notice Reverts when buys are paused, with the reason code.
    /// @param reason Reason code (bytes32 tag).
    error BuysPaused(bytes32 reason);
    /// @notice Reverts when there is not enough free cash.
    /// @param needed Amount needed.
    /// @param available The available.
    error InsufficientCash(uint256 needed, uint256 available);
    /// @notice Reverts when the account is not an allowed depositor.
    /// @param account The account concerned.
    error DepositorNotAllowed(address account);
    /// @notice Reverts when a withdrawal ticket is claimed before it is claimable.
    /// @param claimableAt The claimable at.
    error TooEarly(uint64 claimableAt);
    /// @notice Reverts when parameters are outside their bounds.
    error InvalidParams();
    /// @notice Reverts when a once-only setting is set again.
    error AlreadySet();
    /// @notice Reverts when the caller does not own the ticket.
    /// @param ticket Id of the ticket.
    error NotTicketOwner(uint256 ticket);
    /// @notice Reverts when a hedge post carries an invalid timestamp.
    /// @param asOf The as of.
    error BadAsOf(uint64 asOf);
    /// @notice Reverts when a hedge post changes equity by more than the allowed jump.
    /// @param prevUsdg The prev, in USDG (6 decimals).
    /// @param nextUsdg The next, in USDG (6 decimals).
    /// @param allowedUsdg The allowed, in USDG (6 decimals).
    error HedgeJump(uint256 prevUsdg, uint256 nextUsdg, uint256 allowedUsdg);
    /// @notice Reverts when the hedge equity would exceed its cap.
    /// @param afterUsdg The after, in USDG (6 decimals).
    /// @param capUsdg Cap in USDG, 6 decimals.
    error HedgeCap(uint256 afterUsdg, uint256 capUsdg);
    /// @notice Reverts when no hedger wallet is set.
    error NoHedger();
    /// @notice Reverts when the USDG expected from a pull did not arrive.
    /// @param needed Amount needed.
    /// @param balance Balance observed.
    error UsdgNotReceived(uint256 needed, uint256 balance);
    /// @notice Reverts when the net asset value is not positive.
    error NavNotPositive();
    /// @notice Reverts when the first deposit is below the minimum.
    error FirstDepositTooSmall();
    /// @notice Reverts when a direct withdraw or redeem is used instead of the withdrawal queue.
    error UseWithdrawalQueue();
    /// @notice Reverts when a payout runs short of gas.
    error PayOutOfGas();
    /// @notice Reverts when a claim would pay less than the caller's minimum.
    /// @param paidUsdg The paid, in USDG (6 decimals).
    /// @param minAssetsOut The min assets out.
    error ClaimBelowMin(uint256 paidUsdg, uint256 minAssetsOut);
    /// @notice Reverts when a hedge post is stale and a claim has no explicit minimum.
    error HedgeStale();
    // minter and backer only
    /// @notice Books a buy against the caps and stress budget.
    /// @dev Minter only (NotMinter otherwise). Reverts with CapExceeded, StressBudget or BuysPaused.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param usdgIn Amount of USDG paid in, in 6-decimal units.
    /// @param spreadUsdg Spread charged, in USDG.
    function onBuy(bytes32 gearId, uint256 tokens, uint256 usdgIn, uint256 spreadUsdg) external; // reverts on caps/stress/pause
    /// @notice Books a sell.
    /// @dev Minter only (NotMinter otherwise). Never reverts on caps.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param spreadUsdg Spread charged, in USDG.
    function onSell(bytes32 gearId, uint256 tokens, uint256 spreadUsdg) external; // never reverts on caps
    /// @notice Pays USDG from free cash, then from the exit reserve.
    /// @dev Minter or backer only.
    /// @param to The recipient address.
    /// @param usdg Amount of USDG, in 6-decimal units.
    /// @return paid  True if paid; false means it cannot pay now and the caller queues.
    function pay(address to, uint256 usdg) external returns (bool paid); // free cash then exit reserve; false = cannot pay (caller queues)
    /// @notice Books a toll accrual.
    /// @dev Minter only. A positive toll pays the toll fee, or records it as owed.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tollValueUsdWad The toll value usd, WAD (18 decimals).
    function onToll(bytes32 gearId, int256 tollValueUsdWad) external; // books toll; positive toll pays the toll fee (or owes it)
    /// @notice Books a backer mint, paying the proceeds when the tokens are sold to the Governor.
    /// @dev Backer only (NotBacker otherwise).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param soldToGovernor True if the minted tokens were sold to the Governor.
    /// @param proceedsUsdg USDG proceeds, in 6-decimal units.
    /// @return paid  paid=True if the proceeds were paid.
    function onBackerMint(bytes32 gearId, uint256 tokens, bool soldToGovernor, uint256 proceedsUsdg)
        external
        returns (bool paid);
    /// @notice Books a backer repayment of gear tokens.
    /// @dev Backer only (NotBacker otherwise).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tokens Amount of gear tokens (18 decimals).
    function onBackerRepay(bytes32 gearId, uint256 tokens) external;
    /// @notice Absorbs a liquidated vault debt and its collateral into the book.
    /// @dev Backer only. The collateral arrives first.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param debtTokens Debt in gear tokens (18 decimals).
    /// @param collateralUsdg Collateral amount in USDG, in 6-decimal units.
    function absorbLiquidation(bytes32 gearId, uint256 debtTokens, uint256 collateralUsdg) external; // collateral arrives first
    // risk and reserve
    /// @notice Refreshes the cached stress and equity for the given markets.
    /// @dev Permissionless.
    /// @param markets List of market ids.
    function pokeRisk(bytes32[] calldata markets) external; // permissionless
    /// @notice Moves free cash into the exit reserve.
    /// @dev Admin or keeper only.
    /// @param usdg Amount of USDG, in 6-decimal units.
    function moveToExitReserve(uint256 usdg) external; // admin or keeper, from free cash
    /// @notice Pulls USDG into the exit reserve.
    /// @dev Anyone may call; the fees router uses it.
    /// @param usdg Amount of USDG, in 6-decimal units.
    function fundExitReserve(uint256 usdg) external; // anyone, pulls USDG (fees router)
    /// @notice Pulls USDG into tracked cash.
    /// @dev Anyone may call; the fees router uses it for the Governor share.
    /// @param usdg Amount of USDG, in 6-decimal units.
    function fundCash(uint256 usdg) external; // anyone, pulls USDG into tracked cash (fees router's Governor share)
    /// HEDGER. `hedgeDeltaWad`: signed USD notional (WAD) of the hedge in `market` (long > 0); the stress test credits
    /// it P&L `hedgeDelta x shock` while the post is fresh. `hedgeEquityUsdg`: this market's share of the mark-to-market
    /// equity of the hedge accounts (USDG, 6 dp: margin + unrealised P&L, venue equity split by |notional|); it replaces
    /// the market's previous post and NAV counts the sum over markets plus USDG sent and not yet seen in a post.
    /// Rules: asOf <= now and >= the market's previous asOf; the change, net of USDG in transit, is within
    /// maxHedgeJumpBps x equity, and so is the sum of such changes over all markets in the current hedgeMaxAge window,
    /// measured against the equity cached at the window's start (hedgeJumpRange gives the exact range; admin may post
    /// any jump). Posting delta 0 and equity 0 retires a market.
    function postHedge(bytes32 market, int256 hedgeDeltaWad, uint256 hedgeEquityUsdg, uint64 asOf) external;
    /// @notice Sends USDG to the hedger wallet.
    /// @dev Hedger only, bounded by maxHedgeEquityBps of equity (HedgeCap).
    /// @param usdg Amount of USDG, in 6-decimal units.
    function sendToHedger(uint256 usdg) external; // HEDGER, bounded by maxHedgeEquityBps of equity
    /// @notice Pauses or unpauses buys.
    /// @dev The guardian pauses; the admin unpauses.
    /// @param paused True to pause, false to unpause.
    function setBuysPaused(bool paused) external; // guardian pauses, admin unpauses
    /// @notice Allows or removes a depositor.
    /// @dev Admin only.
    /// @param account The account concerned.
    /// @param allowed True to allow, false to disallow.
    function setDepositor(address account, bool allowed) external; // admin
    /// @notice Burns shares and queues a withdrawal ticket claimable after the withdraw delay.
    /// @param shares Amount of shares (vault share decimals).
    /// @return ticket  ticket=The id of the new ticket.
    function requestWithdraw(uint256 shares) external returns (uint256 ticket);
    /// Pays the matured ticket at the low NAV edge, limited by free cash and the stress budget (the rest stays on the
    /// ticket). With `minAssetsOut == 0` reverts HedgeStale while any hedge post (or unabsorbed transit) is stale; with an
    /// explicit minimum it pays at the hedge-free low edge (L-6). Reverts ClaimBelowMin under `minAssetsOut`.
    function claim(uint256 ticket, uint256 minAssetsOut) external returns (uint256 usdg);
    // views
    /// @notice Returns the net exposure of a market.
    /// @param market Market id (bytes32 symbol key).
    /// @return deltaUsdWad  The delta usd, WAD (18 decimals).
    /// @return gammaUsdWad  The gamma usd, WAD (18 decimals).
    /// @return openValueWad  The open value, WAD (18 decimals).
    function exposure(bytes32 market)
        external
        view
        returns (int256 deltaUsdWad, int256 gammaUsdWad, uint256 openValueWad);
    /// @notice Returns the net tokens of a gear (holder supply minus backer debt).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return  The resulting signed value.
    function netTokens(bytes32 gearId) external view returns (int256); // holder supply - backer debt
    /// @notice Returns the backer debt of a gear in tokens.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return  The resulting value.
    function backerDebt(bytes32 gearId) external view returns (uint256);
    /// @notice Returns the net asset value of the Governor.
    /// @return equityWad  Equity in USD, WAD (18 decimals).
    function equity() external view returns (int256 equityWad); // NAV in WAD
    /// @notice Returns the worst stress loss and the budget it is held under.
    /// @return lossWad  Stress loss in USD, WAD (18 decimals).
    /// @return budgetWad  Stress budget in USD, WAD (18 decimals).
    function stressLoss() external view returns (uint256 lossWad, uint256 budgetWad);
    /// @notice Returns the cap and the open value of a gear.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return capWad  Cap in USD, WAD (18 decimals).
    /// @return openWad  Open value in USD, WAD (18 decimals).
    function capOf(bytes32 gearId) external view returns (uint256 capWad, uint256 openWad);
    /// @notice Returns the exit reserve balance.
    /// @return usdg  Amount of USDG, in 6-decimal units.
    function exitReserve() external view returns (uint256 usdg);
    /// @notice Returns the minimum exit reserve.
    /// @return usdg  Amount of USDG, in 6-decimal units.
    function exitReserveFloor() external view returns (uint256 usdg);
    /// @notice Returns tracked cash outside the exit reserve.
    /// @return usdg  Amount of USDG, in 6-decimal units.
    function freeCash() external view returns (uint256 usdg);
    /// @notice Returns whether any hedge post is stale.
    /// @return  True when stale.
    function hedgeStale() external view returns (bool);
    /// @notice Returns whether buys are paused and why.
    /// @return paused  True to pause, false to unpause.
    /// @return reason  Reason code (bytes32 tag).
    function buysPaused() external view returns (bool paused, bytes32 reason);
    /// @notice Returns the fees owed and not yet paid.
    /// @return usdg  Amount of USDG, in 6-decimal units.
    function feeOwed() external view returns (uint256 usdg);
    // admin and wiring (05a additions)
    /// @notice Sets the minter.
    /// @dev Admin only, once (AlreadySet afterwards).
    /// @param minter Address of the minter.
    function setMinter(address minter) external; // admin, once
    /// @notice Sets the backer.
    /// @dev Admin only, once (AlreadySet afterwards).
    /// @param backer Address of the backer.
    function setBacker(address backer) external; // admin, once
    /// @notice Sets the hedger wallet, the only address sendToHedger pays.
    /// @dev Admin only.
    /// @param hedgerWallet The hedger wallet.
    function setHedger(address hedgerWallet) external; // admin: the only address sendToHedger pays
    /// @notice Sets the risk and cash parameters.
    /// @dev Admin (timelock) only; reverts with InvalidParams when a bound is broken.
    /// @param p The parameter struct.
    function setParams(Params calldata p) external; // admin (timelock), bounds checked
    /// @notice Assigns a market to a shock group.
    /// @dev Admin only.
    /// @param market Market id (bytes32 symbol key).
    /// @param group Shock group: 0 stock, 1 ETF, 2 crypto.
    function setMarketGroup(bytes32 market, uint8 group) external; // admin: 0 stock, 1 etf, 2 crypto
    /// @notice Sends USDG above tracked cash and the exit reserve to the insurance fund.
    /// @dev Admin only.
    function skim() external; // admin: USDG above tracked cash + exit reserve goes to ODInsurance
    /// @notice Pulls USDG back from the hedger into tracked cash.
    /// @dev Hedger only.
    /// @param usdg Amount of USDG, in 6-decimal units.
    function returnFromHedger(uint256 usdg) external; // HEDGER: pulls USDG back into tracked cash
    // views (05a additions)
    /// @notice Returns the current parameters.
    /// @return  The parameter struct.
    function getParams() external view returns (Params memory);
    /// @notice Returns the age after which a hedge post is stale.
    /// @return  Seconds; the hedger posts at least every half of it.
    function hedgeMaxAge() external view returns (uint32); // seconds; hedger posts at least every half of it
    /// @notice Returns the largest allowed hedge equity jump.
    /// @return  Basis points of equity, per post and per window.
    function maxHedgeJumpBps() external view returns (uint16); // bps of Governor equity per post and per window
    /// The hedge equity (USDG) a HEDGER post on `market` may set now: postHedge's exact rule (M-2), transit included.
    function hedgeJumpRange(bytes32 market) external view returns (uint256 loUsdg, uint256 hiUsdg);
    /// @notice Returns the stress shock applied to a market.
    /// @param market Market id (bytes32 symbol key).
    /// @return  Shock in basis points.
    function marketShockBps(bytes32 market) external view returns (uint16);
    /// @notice Returns the cached stress loss of a market and when it was cached.
    /// @param market Market id (bytes32 symbol key).
    /// @return lossWad  Stress loss in USD, WAD (18 decimals).
    /// @return at  Timestamp.
    function cachedStress(bytes32 market) external view returns (uint256 lossWad, uint64 at);
    /// @notice Returns the net asset value band, with the liability taken at the worse and better of the price and the
    /// reference price.
    /// @return lowWad  The low, WAD (18 decimals).
    /// @return highWad  The high, WAD (18 decimals).
    function navBand() external view returns (int256 lowWad, int256 highWad); // liability at the worse / better of p and refP
    /// @notice Returns the share price.
    /// @return  convertToAssets(10**decimals()) scaled to WAD.
    function sharePriceWad() external view returns (uint256); // convertToAssets(10**decimals()) scaled to WAD
    /// @notice Returns the share price peak, the current share price and whether the drawdown limit is tripped.
    /// @return peakWad  The peak, WAD (18 decimals).
    /// @return nowWad  The now, WAD (18 decimals).
    /// @return tripped  The tripped.
    function drawdown() external view returns (uint256 peakWad, uint256 nowWad, bool tripped);
    /// @notice Returns tracked cash by internal accounting, never balanceOf.
    /// @return usdg  Amount of USDG, in 6-decimal units.
    function trackedCash() external view returns (uint256 usdg); // internal accounting, never balanceOf
    /// @notice Returns the last hedge post of a market.
    /// @param market Market id (bytes32 symbol key).
    /// @return hedgeDeltaWad  The hedge delta, WAD (18 decimals).
    /// @return hedgeEquityUsdg  The hedge equity, in USDG (6 decimals).
    /// @return asOf  The as of.
    function hedgeOf(bytes32 market) external view returns (int256 hedgeDeltaWad, uint256 hedgeEquityUsdg, uint64 asOf);
    /// @notice Returns the posted hedge equity and the USDG in transit; NAV counts the sum.
    /// @return postedUsdg  The posted, in USDG (6 decimals).
    /// @return inTransitUsdg  The in transit, in USDG (6 decimals).
    function hedgeEquity() external view returns (uint256 postedUsdg, int256 inTransitUsdg); // NAV counts the sum
    /// @notice Returns the cached equity, when it was cached and the share price then.
    /// @return equityWad  Equity in USD, WAD (18 decimals).
    /// @return at  Timestamp.
    /// @return sharePriceWad  The share price, WAD (18 decimals).
    function cachedEquity() external view returns (int256 equityWad, uint64 at, uint256 sharePriceWad);
    /// @notice Returns the reason a buy of `addTokens` would be blocked, or zero if onBuy would pass.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param addTokens Tokens the buy would add.
    /// @return reason  Reason code (bytes32 tag).
    function buyBlock(bytes32 gearId, uint256 addTokens) external view returns (bytes32 reason); // 0 = onBuy passes (QUOTE-1)
    /// @notice Returns whether pay(usdg) would find the money.
    /// @param usdg Amount of USDG, in 6-decimal units.
    /// @return  True if payable.
    function canPay(uint256 usdg) external view returns (bool); // pay(usdg) would find the money (QUOTE-1)
    /// @notice Returns a withdrawal ticket.
    /// @param ticket Id of the ticket.
    /// @return owner  The owner account.
    /// @return shares  Amount of shares (vault share decimals).
    /// @return claimableAt  The claimable at.
    function ticketOf(uint256 ticket) external view returns (address owner, uint256 shares, uint64 claimableAt);
    /// @notice Returns whether an account is an allowed depositor.
    /// @param account The account concerned.
    /// @return  True if allowed.
    function isDepositor(address account) external view returns (bool);
    /// @notice Returns the minter address.
    /// @return  The minter.
    function minter() external view returns (address);
    /// @notice Returns the backer address.
    /// @return  The backer.
    function backer() external view returns (address);
    /// @notice Returns the hedger wallet address.
    /// @return  The hedger wallet.
    function hedgerWallet() external view returns (address);
}

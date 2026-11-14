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

    event BookUpdated(bytes32 indexed gearId, int256 netTokens, uint256 backerDebtTokens);
    event PaidOut(address indexed to, uint256 usdg, bool fromExitReserve);
    event ExitReserveMoved(uint256 amount, uint256 balanceAfter);
    event HedgePosted(bytes32 indexed market, int256 hedgeDeltaWad, uint256 hedgeEquityUsdg, uint64 asOf);
    event SentToHedger(address indexed to, uint256 usdg);
    event WithdrawalQueued(address indexed owner, uint256 indexed ticket, uint256 shares, uint64 claimableAt);
    event WithdrawalClaimed(address indexed owner, uint256 indexed ticket, uint256 usdg);
    event RiskPoked(uint256 stressLossWad, uint256 budgetWad, int256 equityWad);
    event BuysPausedSet(bool paused);
    event ParamsSet(Params p);
    event ModuleSet(bytes32 indexed what, address module);
    event MarketGroupSet(bytes32 indexed market, uint8 group);
    event DepositorSet(address indexed account, bool allowed);
    event FeePaid(bytes32 indexed kind, uint256 usdg);
    event FeeOwed(bytes32 indexed kind, uint256 usdg, uint256 owedAfter);
    event TollBooked(bytes32 indexed gearId, int256 tollValueUsdWad, uint256 feeUsdg);
    event ReturnedFromHedger(address indexed from, uint256 usdg);
    event CashFunded(address indexed from, uint256 usdg);
    event InsuranceDrawn(uint256 requested, uint256 received);
    event Skimmed(uint256 usdg);
    event Liquidation(bytes32 indexed gearId, uint256 debtTokens, uint256 collateralUsdg);
    error NotMinter();
    error NotBacker();
    error CapExceeded(bytes32 gearId, uint256 openWad, uint256 capWad);
    error StressBudget(uint256 lossWad, uint256 budgetWad);
    error BuysPaused(bytes32 reason);
    error InsufficientCash(uint256 needed, uint256 available);
    error DepositorNotAllowed(address account);
    error TooEarly(uint64 claimableAt);
    error InvalidParams();
    error AlreadySet();
    error NotTicketOwner(uint256 ticket);
    error BadAsOf(uint64 asOf);
    error HedgeJump(uint256 prevUsdg, uint256 nextUsdg, uint256 allowedUsdg);
    error HedgeCap(uint256 afterUsdg, uint256 capUsdg);
    error NoHedger();
    error UsdgNotReceived(uint256 needed, uint256 balance);
    error NavNotPositive();
    error FirstDepositTooSmall();
    error UseWithdrawalQueue();
    error PayOutOfGas();
    error ClaimBelowMin(uint256 paidUsdg, uint256 minAssetsOut);
    error HedgeStale();
    // minter and backer only
    function onBuy(bytes32 gearId, uint256 tokens, uint256 usdgIn, uint256 spreadUsdg) external; // reverts on caps/stress/pause
    function onSell(bytes32 gearId, uint256 tokens, uint256 spreadUsdg) external; // never reverts on caps
    function pay(address to, uint256 usdg) external returns (bool paid); // free cash then exit reserve; false = cannot pay (caller queues)
    function onToll(bytes32 gearId, int256 tollValueUsdWad) external; // books toll; positive toll pays the toll fee (or owes it)
    function onBackerMint(bytes32 gearId, uint256 tokens, bool soldToGovernor, uint256 proceedsUsdg)
        external
        returns (bool paid);
    function onBackerRepay(bytes32 gearId, uint256 tokens) external;
    function absorbLiquidation(bytes32 gearId, uint256 debtTokens, uint256 collateralUsdg) external; // collateral arrives first
    // risk and reserve
    function pokeRisk(bytes32[] calldata markets) external; // permissionless
    function moveToExitReserve(uint256 usdg) external; // admin or keeper, from free cash
    function fundExitReserve(uint256 usdg) external; // anyone, pulls USDG (fees router)
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
    function sendToHedger(uint256 usdg) external; // HEDGER, bounded by maxHedgeEquityBps of equity
    function setBuysPaused(bool paused) external; // guardian pauses, admin unpauses
    function setDepositor(address account, bool allowed) external; // admin
    function requestWithdraw(uint256 shares) external returns (uint256 ticket);
    /// Pays the matured ticket at the low NAV edge, limited by free cash and the stress budget (the rest stays on the
    /// ticket). With `minAssetsOut == 0` reverts HedgeStale while any hedge post (or unabsorbed transit) is stale; with an
    /// explicit minimum it pays at the hedge-free low edge (L-6). Reverts ClaimBelowMin under `minAssetsOut`.
    function claim(uint256 ticket, uint256 minAssetsOut) external returns (uint256 usdg);
    // views
    function exposure(bytes32 market)
        external
        view
        returns (int256 deltaUsdWad, int256 gammaUsdWad, uint256 openValueWad);
    function netTokens(bytes32 gearId) external view returns (int256); // holder supply - backer debt
    function backerDebt(bytes32 gearId) external view returns (uint256);
    function equity() external view returns (int256 equityWad); // NAV in WAD
    function stressLoss() external view returns (uint256 lossWad, uint256 budgetWad);
    function capOf(bytes32 gearId) external view returns (uint256 capWad, uint256 openWad);
    function exitReserve() external view returns (uint256 usdg);
    function exitReserveFloor() external view returns (uint256 usdg);
    function freeCash() external view returns (uint256 usdg);
    function hedgeStale() external view returns (bool);
    function buysPaused() external view returns (bool paused, bytes32 reason);
    function feeOwed() external view returns (uint256 usdg);
    // admin and wiring (05a additions)
    function setMinter(address minter) external; // admin, once
    function setBacker(address backer) external; // admin, once
    function setHedger(address hedgerWallet) external; // admin: the only address sendToHedger pays
    function setParams(Params calldata p) external; // admin (timelock), bounds checked
    function setMarketGroup(bytes32 market, uint8 group) external; // admin: 0 stock, 1 etf, 2 crypto
    function skim() external; // admin: USDG above tracked cash + exit reserve goes to ODInsurance
    function returnFromHedger(uint256 usdg) external; // HEDGER: pulls USDG back into tracked cash
    // views (05a additions)
    function getParams() external view returns (Params memory);
    function hedgeMaxAge() external view returns (uint32); // seconds; hedger posts at least every half of it
    function maxHedgeJumpBps() external view returns (uint16); // bps of Governor equity per post and per window
    /// The hedge equity (USDG) a HEDGER post on `market` may set now: postHedge's exact rule (M-2), transit included.
    function hedgeJumpRange(bytes32 market) external view returns (uint256 loUsdg, uint256 hiUsdg);
    function marketShockBps(bytes32 market) external view returns (uint16);
    function cachedStress(bytes32 market) external view returns (uint256 lossWad, uint64 at);
    function navBand() external view returns (int256 lowWad, int256 highWad); // liability at the worse / better of p and refP
    function sharePriceWad() external view returns (uint256); // convertToAssets(10**decimals()) scaled to WAD
    function drawdown() external view returns (uint256 peakWad, uint256 nowWad, bool tripped);
    function trackedCash() external view returns (uint256 usdg); // internal accounting, never balanceOf
    function hedgeOf(bytes32 market) external view returns (int256 hedgeDeltaWad, uint256 hedgeEquityUsdg, uint64 asOf);
    function hedgeEquity() external view returns (uint256 postedUsdg, int256 inTransitUsdg); // NAV counts the sum
    function cachedEquity() external view returns (int256 equityWad, uint64 at, uint256 sharePriceWad);
    function buyBlock(bytes32 gearId, uint256 addTokens) external view returns (bytes32 reason); // 0 = onBuy passes (QUOTE-1)
    function canPay(uint256 usdg) external view returns (bool); // pay(usdg) would find the money (QUOTE-1)
    function ticketOf(uint256 ticket) external view returns (address owner, uint256 shares, uint64 claimableAt);
    function isDepositor(address account) external view returns (bool);
    function minter() external view returns (address);
    function backer() external view returns (address);
    function hedgerWallet() external view returns (address);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

interface IODGovernor is IERC4626 {
    event BookUpdated(bytes32 indexed gearId, int256 netTokens, uint256 backerDebtTokens);
    event PaidOut(address indexed to, uint256 usdg, bool fromExitReserve);
    event ExitReserveMoved(uint256 amount, uint256 balanceAfter);
    event HedgePosted(bytes32 indexed market, int256 hedgeDeltaWad, uint256 hedgeEquityUsdg, uint64 asOf);
    event SentToHedger(address indexed to, uint256 usdg);
    event WithdrawalQueued(address indexed owner, uint256 indexed ticket, uint256 shares, uint64 claimableAt);
    event WithdrawalClaimed(address indexed owner, uint256 indexed ticket, uint256 usdg);
    event RiskPoked(uint256 stressLossWad, uint256 budgetWad, int256 equityWad);
    event BuysPausedSet(bool paused);
    error NotMinter();
    error NotBacker();
    error CapExceeded(bytes32 gearId, uint256 openWad, uint256 capWad);
    error StressBudget(uint256 lossWad, uint256 budgetWad);
    error BuysPaused(bytes32 reason);
    error InsufficientCash(uint256 needed, uint256 available);
    error DepositorNotAllowed(address account);
    error TooEarly(uint64 claimableAt);
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
    function postHedge(bytes32 market, int256 hedgeDeltaWad, uint256 hedgeEquityUsdg, uint64 asOf) external; // HEDGER
    function sendToHedger(uint256 usdg) external; // HEDGER, bounded by maxHedgeEquityBps of equity
    function setBuysPaused(bool paused) external; // guardian pauses, admin unpauses
    function setDepositor(address account, bool allowed) external; // admin
    function requestWithdraw(uint256 shares) external returns (uint256 ticket);
    function claim(uint256 ticket) external returns (uint256 usdg);
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
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {Gear, GearConfig, GearStatus, NormState, Quote, Session} from "overdrive/interfaces/ODTypes.sol";

/// Stand-ins for the minter (05b), backer vaults (07a) and gear registry (05a) behind their real interfaces, so the
/// agent router is tested against the exact ABI it will call. The integrator adds the real-contract wiring test.

/// 18-decimals gear token; only the minter or backer mints and burns.
contract MockGearToken is ERC20 {
    mapping(address => bool) public isMinter;

    constructor(string memory sym, address minter, address backer) ERC20(sym, sym) {
        isMinter[minter] = true;
        isMinter[backer] = true;
    }

    function mint(address to, uint256 amount) external {
        require(isMinter[msg.sender], "not minter");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(isMinter[msg.sender], "not minter");
        _burn(from, amount);
    }
}

abstract contract Unused {
    error UnusedInMock();
}

contract MockAgentRegistry is IODGearRegistry, Unused {
    mapping(bytes32 => GearConfig) internal _gears;

    function set(bytes32 id, bytes32 marketA, bytes32 marketB, address token) external {
        GearConfig storage g = _gears[id];
        g.marketA = marketA;
        g.marketB = marketB;
        g.gear = Gear.SPORT;
        g.token = token;
        g.status = GearStatus.LISTED;
    }

    function gear(bytes32 id) external view returns (GearConfig memory g) {
        g = _gears[id];
        if (g.token == address(0)) revert GearUnknown(id);
    }

    function listGear(bytes32, bytes32, Gear, uint128, uint128, uint16, string calldata)
        external
        pure
        returns (bytes32)
    {
        revert UnusedInMock();
    }

    function setStatus(bytes32, GearStatus) external pure {
        revert UnusedInMock();
    }

    function setParams(bytes32, uint128, uint16) external pure {
        revert UnusedInMock();
    }

    function idOf(bytes32, bytes32, Gear) external pure returns (bytes32) {
        revert UnusedInMock();
    }

    function gearsOfMarket(bytes32) external pure returns (bytes32[] memory) {
        revert UnusedInMock();
    }

    function gearCount() external pure returns (uint256) {
        revert UnusedInMock();
    }

    function gearIdAt(uint256) external pure returns (bytes32) {
        revert UnusedInMock();
    }

    function predictToken(bytes32) external pure returns (address) {
        revert UnusedInMock();
    }

    function powerWad(Gear) external pure returns (int256) {
        revert UnusedInMock();
    }
}

/// Exact-in buy and sell at value +/- spread minus a protocol fee, with a linear toll accrued per second since the
/// last trade. `quote` simulates the trade's own accrual, so quote equals execution to the wei (QUOTE-1).
contract MockAgentMinter is IODMinter, Unused {
    IERC20 public immutable usdg;
    MockAgentRegistry public immutable registry;

    uint256 public valueWad = 10e18; // USD per token
    uint256 public tollPerSecWad; // USD per token per second
    uint64 public lastAccrual;
    uint16 public spreadBps = 30;
    uint16 public feeBps = 10;
    bool public useQueue;
    mapping(address => address) public lastPayer;

    constructor(IERC20 usdg_, MockAgentRegistry registry_) {
        usdg = usdg_;
        registry = registry_;
        lastAccrual = uint64(block.timestamp);
    }

    function setToll(uint256 perSecWad) external {
        _accrue();
        tollPerSecWad = perSecWad;
    }

    function setUseQueue(bool v) external {
        useQueue = v;
    }

    function _valueNow() internal view returns (uint256) {
        uint256 drop = tollPerSecWad * (block.timestamp - lastAccrual);
        return drop >= valueWad ? 1 : valueWad - drop;
    }

    function _accrue() internal {
        valueWad = _valueNow();
        lastAccrual = uint64(block.timestamp);
    }

    function _buyOut(uint256 usdgIn) internal view returns (uint256 tokensOut, uint256 fee, uint256 price) {
        fee = usdgIn * feeBps / 10_000;
        price = _valueNow() * (10_000 + spreadBps) / 10_000;
        tokensOut = (usdgIn - fee) * 1e12 * 1e18 / price;
    }

    function _sellOut(uint256 tokensIn) internal view returns (uint256 usdgOut, uint256 fee, uint256 price) {
        price = _valueNow() * (10_000 - spreadBps) / 10_000;
        uint256 gross = tokensIn * price / 1e18 / 1e12;
        fee = gross * feeBps / 10_000;
        usdgOut = gross - fee;
    }

    function buy(bytes32 gearId, uint256 usdgIn, uint256 minTokensOut, address recipient, uint64 deadline)
        external
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (usdgIn == 0) revert BelowMinimum();
        _accrue();
        (tokensOut,,) = _buyOut(usdgIn);
        if (tokensOut < minTokensOut) revert Slippage(tokensOut, minTokensOut);
        usdg.transferFrom(msg.sender, address(this), usdgIn);
        MockGearToken(registry.gear(gearId).token).mint(recipient, tokensOut);
        lastPayer[recipient] = msg.sender;
        emit Bought(gearId, msg.sender, recipient, usdgIn, tokensOut, valueWad, spreadBps, false);
    }

    function sell(bytes32 gearId, uint256 tokensIn, uint256 minUsdgOut, address recipient, uint64 deadline)
        external
        returns (uint256 usdgOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (useQueue) revert UseQueue();
        _accrue();
        (usdgOut,,) = _sellOut(tokensIn);
        if (usdgOut < minUsdgOut) revert Slippage(usdgOut, minUsdgOut);
        MockGearToken(registry.gear(gearId).token).burn(msg.sender, tokensIn);
        usdg.transfer(recipient, usdgOut);
        emit Sold(gearId, msg.sender, recipient, tokensIn, usdgOut, valueWad, spreadBps, false, Session.OPEN);
    }

    function quote(bytes32, bool isBuy, bool exactIn, uint256 amount) external view returns (Quote memory q) {
        require(exactIn, "exact-in only");
        q.amountIn = amount;
        q.valuePerTokenWad = _valueNow();
        q.spreadBps = spreadBps;
        q.tollPerDayWad = int256(tollPerSecWad * 1 days);
        q.session = Session.OPEN;
        if (isBuy) (q.amountOut, q.protocolFeeUsdg, q.pricePerTokenWad) = _buyOut(amount);
        else (q.amountOut, q.protocolFeeUsdg, q.pricePerTokenWad) = _sellOut(amount);
    }

    function buyExactTokens(bytes32, uint256, uint256, address, uint64) external pure returns (uint256) {
        revert UnusedInMock();
    }

    function sellForExactUsdg(bytes32, uint256, uint256, address, uint64) external pure returns (uint256) {
        revert UnusedInMock();
    }

    function queueSell(bytes32, uint256, uint256, address) external pure returns (uint256) {
        revert UnusedInMock();
    }

    function fillQueued(uint256) external pure returns (uint256) {
        revert UnusedInMock();
    }

    function cancelQueued(uint256) external pure {
        revert UnusedInMock();
    }

    function hookSwap(bytes32, bool, bool, uint256, address) external pure returns (uint256, uint256) {
        revert UnusedInMock();
    }

    function setHook(address) external pure {
        revert UnusedInMock();
    }

    function setStake(address) external pure {
        revert UnusedInMock();
    }

    function setTradeParams(TradeParams calldata) external pure {
        revert UnusedInMock();
    }

    function tradeParams() external pure returns (TradeParams memory) {
        revert UnusedInMock();
    }

    function settledValue(bytes32) external pure returns (uint256) {
        revert UnusedInMock();
    }

    function ticketCount() external pure returns (uint256) {
        revert UnusedInMock();
    }

    function hook() external pure returns (address) {
        revert UnusedInMock();
    }

    function poolManager() external pure returns (address) {
        revert UnusedInMock();
    }

    function stake() external pure returns (address) {
        revert UnusedInMock();
    }

    function accrue(bytes32) external returns (uint256) {
        _accrue();
        return 1e18;
    }

    function accrueMany(bytes32[] calldata) external pure {
        revert UnusedInMock();
    }

    function settleGear(bytes32) external pure {
        revert UnusedInMock();
    }

    function valuePerToken(bytes32) external view returns (uint256, bool) {
        return (_valueNow(), true);
    }

    function normState(bytes32) external pure returns (NormState memory) {
        revert UnusedInMock();
    }

    function tollPerDay(bytes32) external view returns (int256) {
        return int256(tollPerSecWad * 1 days);
    }

    function queuedSell(uint256) external pure returns (bytes32, address, address, uint256, uint256) {
        revert UnusedInMock();
    }

    function backerMint(bytes32, address, uint256) external pure {
        revert UnusedInMock();
    }

    function backerBurn(bytes32, address, uint256) external pure {
        revert UnusedInMock();
    }
}

/// Vaults with an owner field, operator approvals and a sell-to-Governor mint whose proceeds stay as collateral.
contract MockAgentBacker is IODBacker, Unused {
    struct V {
        address owner;
        bytes32 gearId;
        uint256 collateral;
        uint256 debt;
    }

    uint256 public constant MIN_COLLATERAL = 50e6;
    uint256 public constant PRICE_USDG = 10e6; // proceeds per token sold to the Governor
    IERC20 public immutable usdg;
    uint256 public nextId = 1;
    mapping(uint256 => V) internal _vaults;
    mapping(address => mapping(address => bool)) public isOperator;

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function _open(address owner, bytes32 gearId, uint256 collateralUsdg) internal returns (uint256 id) {
        if (collateralUsdg < MIN_COLLATERAL) revert BelowMinimumCollateral();
        usdg.transferFrom(msg.sender, address(this), collateralUsdg);
        id = nextId++;
        _vaults[id] = V(owner, gearId, collateralUsdg, 0);
        emit VaultOpened(id, owner, gearId);
        emit CollateralMoved(id, int256(collateralUsdg), collateralUsdg);
    }

    function openVault(bytes32 gearId, uint256 collateralUsdg) external returns (uint256) {
        return _open(msg.sender, gearId, collateralUsdg);
    }

    function openVaultFor(address owner, bytes32 gearId, uint256 collateralUsdg) external returns (uint256) {
        return _open(owner, gearId, collateralUsdg);
    }

    function deposit(uint256 vaultId, uint256 amount) external {
        usdg.transferFrom(msg.sender, address(this), amount);
        _vaults[vaultId].collateral += amount;
        emit CollateralMoved(vaultId, int256(amount), _vaults[vaultId].collateral);
    }

    function _mintToGovernor(uint256 vaultId, uint256 tokens, uint256 minProceeds) internal returns (uint256 proceeds) {
        proceeds = tokens * PRICE_USDG / 1e18;
        if (proceeds < minProceeds) revert IODMinter.Slippage(proceeds, minProceeds);
        V storage v = _vaults[vaultId];
        v.debt += tokens;
        v.collateral += proceeds; // proceeds stay as vault collateral
        emit Minted(vaultId, tokens, true, proceeds);
    }

    function mint(uint256 vaultId, uint256 tokens, bool sellToGovernor, uint256 minProceedsUsdg)
        external
        returns (uint256)
    {
        if (_vaults[vaultId].owner != msg.sender) revert NotVaultOwner(vaultId);
        require(sellToGovernor, "mock: governor sells only");
        return _mintToGovernor(vaultId, tokens, minProceedsUsdg);
    }

    function mintFor(uint256 vaultId, uint256 tokens, uint256 minProceedsUsdg) external returns (uint256) {
        address owner = _vaults[vaultId].owner;
        if (!isOperator[owner][msg.sender]) revert NotOperator(owner, msg.sender);
        return _mintToGovernor(vaultId, tokens, minProceedsUsdg);
    }

    function setOperator(address operator, bool allowed) external {
        isOperator[msg.sender][operator] = allowed;
        emit OperatorSet(msg.sender, operator, allowed);
    }

    function vault(uint256 vaultId) external view returns (address, bytes32, uint256, uint256, uint256) {
        V storage v = _vaults[vaultId];
        return (v.owner, v.gearId, v.collateral, v.debt, 0);
    }

    function withdraw(uint256, uint256, address) external pure {
        revert UnusedInMock();
    }

    function repay(uint256, uint256) external pure {
        revert UnusedInMock();
    }

    function repayWithUsdg(uint256, uint256, uint256) external pure returns (uint256) {
        revert UnusedInMock();
    }

    function sealBatch(bytes32, uint256[] calldata) external pure returns (uint256) {
        revert UnusedInMock();
    }

    function executeBatch(uint256) external pure returns (uint256) {
        revert UnusedInMock();
    }

    function health(uint256) external pure returns (uint256, uint256, uint256, uint256, uint256) {
        revert UnusedInMock();
    }

    function setUplift(uint16, uint32) external pure {
        revert UnusedInMock();
    }

    function setMintPaused(bool) external pure {
        revert UnusedInMock();
    }

    function tollFeeOwed(uint256) external pure returns (uint256) {
        revert UnusedInMock();
    }

    function mintPaused() external pure returns (bool) {
        return false;
    }

    function uplift() external pure returns (uint16, uint32) {
        revert UnusedInMock();
    }

    function vaultCount() external view returns (uint256) {
        return nextId - 1;
    }

    function totalCollateral() external pure returns (uint256) {
        revert UnusedInMock();
    }

    function pendingFees() external pure returns (uint256) {
        revert UnusedInMock();
    }

    function sendFees(bytes32) external pure {
        revert UnusedInMock();
    }

    function SEAL_DELAY() external pure returns (uint32) {
        return 30;
    }

    function BATCH_TTL() external pure returns (uint32) {
        return 900;
    }

    function BONUS_BPS() external pure returns (uint16) {
        return 500;
    }

    function batchWindow(uint256) external pure returns (uint64, uint64) {
        revert UnusedInMock();
    }

    function MAX_SEAL_DRIFT_BPS() external pure returns (uint16) {
        return 100;
    }

    function MIN_REWARD_USDG() external pure returns (uint64) {
        return 1e6;
    }

    function MAX_BATCH() external pure returns (uint8) {
        return 50;
    }

    function MAX_ROUND_AGE() external pure returns (uint32) {
        return 900;
    }

    function batchCount() external pure returns (uint256) {
        return 0;
    }

    function batch(uint256) external pure returns (Batch memory) {
        revert UnusedInMock();
    }

    function setStake(address) external pure {
        revert UnusedInMock();
    }

    function stake() external pure returns (address) {
        return address(0);
    }

    function upliftActive(bytes32) external pure returns (bool, uint16) {
        revert UnusedInMock();
    }
}

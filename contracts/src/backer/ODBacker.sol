// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Gear, GearConfig, GearStatus, NormState, PriceReading, Session} from "../interfaces/ODTypes.sol";
import {IODBacker} from "../interfaces/IODBacker.sol";
import {IODGearRegistry} from "../interfaces/IODGearRegistry.sol";
import {IODMinter} from "../interfaces/IODMinter.sol";
import {IODGovernor} from "../interfaces/IODGovernor.sol";
import {IODOracleGuard} from "../interfaces/IODOracleGuard.sol";
import {IODMarketHours} from "../interfaces/IODMarketHours.sol";
import {IODInsurance} from "../interfaces/IODInsurance.sol";
import {IODFees} from "../interfaces/IODFees.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";
import {ODIndex} from "../math/ODIndex.sol";
import {ODBackerMath as M} from "./ODBackerMath.sol";

/// @title ODBacker
/// @notice Backer vaults. A backer posts USDG (from 50), mints gear tokens against it at a collateral ratio of 200%
/// (RACE 250%), maintenance 150% (RACE 200%), both raised by the weekend uplift before a long close, and either keeps
/// the tokens or sells the exposure to the Governor (proceeds stay as collateral while debt is open). The toll that
/// holders pay shrinks the debt's value through the normalisation factor; 10% of that toll is charged to the vault
/// as a fee for ODFees. Backers can be liquidated (sealed batches, 07b); holders never: nothing here burns, moves or
/// reprices a token this contract did not receive from the vault owner or the repayer.
/// @dev Collateral is internal accounting (`collateralUsdg`, `totalCollateral`), never `balanceOf`: a plain transfer
/// to this contract changes no vault (GEN-3, VAULT-1). Every mint and repay is booked with the Governor
/// (`onBackerMint` / `onBackerRepay`), so `governor.backerDebt(g)` equals the sum of vault debt for `g`.
contract ODBacker is AccessControl, ReentrancyGuardTransient, IODBacker {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_COLLATERAL_USDG = 50e6;
    uint16 public constant DEFAULT_UPLIFT_BPS = 5000; // +50 percentage points on both ratios
    uint32 public constant DEFAULT_UPLIFT_LEAD = 2 hours; // before a close of >= 24 h
    uint32 public constant MIN_CLOSED_FOR_UPLIFT = 24 hours;
    uint16 public constant MAX_UPLIFT_BPS = 20_000;
    uint32 public constant MAX_UPLIFT_LEAD = 3 days;
    uint32 public constant SEAL_DELAY = 30 seconds;
    uint32 public constant BATCH_TTL = 15 minutes;
    uint16 public constant BONUS_BPS = 500;
    bytes32 public constant FEE_KIND = "BACKER_TOLL";
    uint256 internal constant BPS = 10_000;

    struct VaultData {
        address owner;
        bytes32 gearId;
        uint256 collateralUsdg;
        uint256 debtTokens;
        uint256 tollIndexSnapshot; // minter cumTollPerTokenWad at the last vault action
        uint256 batchId;
    }

    /// Sealed liquidation batch; written by 07b. Here only its timing frees vaults.
    struct Batch {
        bytes32 gearId;
        uint256 sealedValueWad;
        uint64 sealedAt;
        uint64 feedUpdatedAt;
        uint256[] vaultIds;
        bool done;
    }

    error ZeroAddress();
    error InvalidParams();
    error NotAllowed();
    error UnknownVault(uint256 vaultId);
    error UsdgNotReceived(uint256 needed, uint256 received);
    error LiquidationNotLive(); // sealed batches arrive with 07b

    IERC20 public immutable usdg;
    IODGearRegistry public immutable registry;
    IODMinter public immutable minter;
    IODGovernor public immutable governor;
    IODOracleGuard public immutable guard;
    IODMarketHours public immutable marketHours;
    IODInsurance public immutable insurance;
    address public immutable fees;

    uint256 public vaultCount;
    uint256 public batchCount;
    uint256 public totalCollateral;
    uint256 public pendingFees;
    bool public mintPaused;
    uint16 internal _upliftBps = DEFAULT_UPLIFT_BPS;
    uint32 internal _upliftLead = DEFAULT_UPLIFT_LEAD;

    mapping(uint256 => VaultData) internal _vaults;
    mapping(uint256 => Batch) internal _batches;
    mapping(address => mapping(address => bool)) internal _operators;

    constructor(
        IERC20 usdg_,
        address admin,
        address guardian,
        IODGearRegistry registry_,
        IODMinter minter_,
        IODGovernor governor_,
        IODOracleGuard guard_,
        IODMarketHours marketHours_,
        IODInsurance insurance_,
        address fees_
    ) {
        if (
            address(usdg_) == address(0) || admin == address(0) || address(registry_) == address(0)
                || address(minter_) == address(0) || address(governor_) == address(0) || address(guard_) == address(0)
                || address(marketHours_) == address(0) || fees_ == address(0)
        ) revert ZeroAddress();
        usdg = usdg_;
        registry = registry_;
        minter = minter_;
        governor = governor_;
        guard = guard_;
        marketHours = marketHours_;
        insurance = insurance_;
        fees = fees_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (guardian != address(0)) _grantRole(ODRoles.GUARDIAN_ROLE, guardian);
    }

    // ================================================================================================ admin

    /// @inheritdoc IODBacker
    function setUplift(uint16 upliftBps, uint32 lead) external {
        if (upliftBps > MAX_UPLIFT_BPS || lead > MAX_UPLIFT_LEAD) revert InvalidParams();
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (!hasRole(ODRoles.GUARDIAN_ROLE, msg.sender)) revert NotAllowed();
            if (upliftBps < _upliftBps || lead < _upliftLead) revert NotAllowed();
        }
        _upliftBps = upliftBps;
        _upliftLead = lead;
        emit UpliftSet(upliftBps, lead);
    }

    /// @inheritdoc IODBacker
    function setMintPaused(bool paused) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !(paused && hasRole(ODRoles.GUARDIAN_ROLE, msg.sender))) {
            revert NotAllowed();
        }
        mintPaused = paused;
        emit MintPausedSet(paused);
    }

    // ================================================================================================ vaults

    /// @inheritdoc IODBacker
    function openVault(bytes32 gearId, uint256 collateralUsdg) external nonReentrant returns (uint256) {
        return _open(msg.sender, gearId, collateralUsdg);
    }

    /// @inheritdoc IODBacker
    function openVaultFor(address owner, bytes32 gearId, uint256 collateralUsdg)
        external
        nonReentrant
        returns (uint256)
    {
        if (owner == address(0)) revert ZeroAddress();
        return _open(owner, gearId, collateralUsdg);
    }

    /// @inheritdoc IODBacker
    /// @dev Anyone, any session, any pause, also in a batch: adding collateral only helps the vault.
    function deposit(uint256 vaultId, uint256 amount) external nonReentrant {
        VaultData storage v = _known(vaultId);
        _charge(vaultId, v);
        _pull(amount);
        v.collateralUsdg += amount;
        totalCollateral += amount;
        emit CollateralMoved(vaultId, int256(amount), v.collateralUsdg);
    }

    /// @inheritdoc IODBacker
    /// @dev Owner only, never in a live batch. With debt, the ratio after must stay at or above the initial ratio
    /// (with uplift) at the high-side debt value (live, or the last good price when closed) on a fresh reading.
    function withdraw(uint256 vaultId, uint256 amount, address to) external nonReentrant {
        VaultData storage v = _owned(vaultId);
        if (to == address(0)) revert ZeroAddress();
        if (_liveBatch(v.batchId) != 0) revert InBatch(vaultId);
        _charge(vaultId, v);
        if (amount > v.collateralUsdg) revert Undercollateralized(0, 0);
        v.collateralUsdg -= amount;
        totalCollateral -= amount;
        if (v.debtTokens != 0) {
            GearConfig memory cfg = registry.gear(v.gearId);
            PriceReading memory r = _read(cfg);
            if (!r.fresh && minter.settledValue(v.gearId) == 0) revert MintingClosed("STALE");
            _requireRatio(v, cfg, r, cfg.collateralBps);
        }
        usdg.safeTransfer(to, amount);
        emit CollateralMoved(vaultId, -int256(amount), v.collateralUsdg);
    }

    /// @inheritdoc IODBacker
    function mint(uint256 vaultId, uint256 tokens, bool sellToGovernor, uint256 minProceedsUsdg)
        external
        nonReentrant
        returns (uint256)
    {
        _owned(vaultId);
        return _mint(vaultId, tokens, sellToGovernor, minProceedsUsdg);
    }

    /// @inheritdoc IODBacker
    function mintFor(uint256 vaultId, uint256 tokens, uint256 minProceedsUsdg) external nonReentrant returns (uint256) {
        address owner = _known(vaultId).owner;
        if (!_operators[owner][msg.sender]) revert NotOperator(owner, msg.sender);
        return _mint(vaultId, tokens, true, minProceedsUsdg);
    }

    /// @inheritdoc IODBacker
    function setOperator(address operator, bool allowed) external {
        if (operator == address(0)) revert ZeroAddress();
        _operators[msg.sender][operator] = allowed;
        emit OperatorSet(msg.sender, operator, allowed);
    }

    /// @inheritdoc IODBacker
    /// @dev Never blocked: any session, pause, gear status or open batch. Burns only the caller's own tokens.
    function repay(uint256 vaultId, uint256 tokens) external nonReentrant {
        VaultData storage v = _known(vaultId);
        try minter.accrue(v.gearId) {} catch {}
        _charge(vaultId, v);
        if (tokens > v.debtTokens) tokens = v.debtTokens;
        if (tokens == 0) return;
        minter.backerBurn(v.gearId, msg.sender, tokens);
        v.debtTokens -= tokens;
        governor.onBackerRepay(v.gearId, tokens);
        emit Repaid(vaultId, tokens, 0);
    }

    /// @inheritdoc IODBacker
    /// @dev Owner only. Buys the tokens back from the Governor at the live buy price (high-side value plus the base
    /// spread, x the extended multiplier in EXTENDED, Ceil), paid from collateral into the Governor's tracked cash.
    /// Needs a live reading (else repay with tokens); a settled gear repays at its settled value with no spread.
    function repayWithUsdg(uint256 vaultId, uint256 tokens, uint256 maxCostUsdg)
        external
        nonReentrant
        returns (uint256 cost)
    {
        VaultData storage v = _owned(vaultId);
        bytes32 g = v.gearId;
        try minter.accrue(g) {} catch {}
        _charge(vaultId, v);
        if (tokens > v.debtTokens) tokens = v.debtTokens;
        if (tokens == 0) return 0;
        GearConfig memory cfg = registry.gear(g);
        uint256 settled = minter.settledValue(g);
        if (settled != 0) {
            cost = M.buyBackUsdg(tokens, settled, 0);
        } else {
            PriceReading memory r = _read(cfg);
            if (!_live(r)) revert MintingClosed("CLOSED");
            cost = M.buyBackUsdg(tokens, _perToken(cfg, g, r, true), _spreadBps(cfg, r));
        }
        if (cost > maxCostUsdg) revert Slippage(cost, maxCostUsdg);
        if (cost > v.collateralUsdg) revert Undercollateralized(0, 0);
        v.collateralUsdg -= cost;
        totalCollateral -= cost;
        v.debtTokens -= tokens;
        if (cost != 0) {
            usdg.forceApprove(address(governor), cost);
            governor.fundCash(cost);
        }
        governor.onBackerRepay(g, tokens);
        emit CollateralMoved(vaultId, -int256(cost), v.collateralUsdg);
        emit Repaid(vaultId, tokens, cost);
    }

    /// @inheritdoc IODBacker
    function sendFees(bytes32 gearId) external {
        uint256 amount = pendingFees;
        if (amount == 0) return;
        pendingFees = 0;
        usdg.safeTransfer(fees, amount);
        IODFees(fees).notify(FEE_KIND, gearId, amount);
    }

    // ================================================================================================ liquidation

    /// @inheritdoc IODBacker
    function sealBatch(bytes32, uint256[] calldata) external pure returns (uint256) {
        revert LiquidationNotLive();
    }

    /// @inheritdoc IODBacker
    function executeBatch(uint256) external pure returns (uint256) {
        revert LiquidationNotLive();
    }

    // ================================================================================================ views

    /// @inheritdoc IODBacker
    /// @dev `collateralUsdg` is net of the toll fee owed; `debtValueWad` at the high side of p and refP (the last good
    /// price and refP when not live), Ceil; `ratioBps` Floor (max when no debt); both thresholds include the uplift.
    function health(uint256 vaultId)
        external
        view
        returns (uint256 collateralUsdg, uint256 debtValueWad, uint256 ratioBps, uint256 requiredBps, uint256 maintBps)
    {
        VaultData storage v = _known(vaultId);
        GearConfig memory cfg = registry.gear(v.gearId);
        uint256 owed = _feeOwed(v);
        collateralUsdg = v.collateralUsdg - Math.min(owed, v.collateralUsdg);
        if (v.debtTokens != 0) debtValueWad = M.debtValueWad(v.debtTokens, _perToken(cfg, v.gearId, _read(cfg), true));
        ratioBps = M.ratioBps(collateralUsdg, debtValueWad);
        uint256 up = _upliftOf(cfg);
        requiredBps = cfg.collateralBps + up;
        maintBps = cfg.maintenanceBps + up;
    }

    /// @inheritdoc IODBacker
    /// @dev `batchId` is 0 once the vault's batch was executed, voided or expired (the vault is free again).
    function vault(uint256 vaultId)
        external
        view
        returns (address owner, bytes32 gearId, uint256 collateralUsdg, uint256 debtTokens, uint256 batchId)
    {
        VaultData storage v = _vaults[vaultId];
        return (v.owner, v.gearId, v.collateralUsdg, v.debtTokens, _liveBatch(v.batchId));
    }

    /// @inheritdoc IODBacker
    function tollFeeOwed(uint256 vaultId) external view returns (uint256) {
        return _feeOwed(_known(vaultId));
    }

    /// @inheritdoc IODBacker
    function upliftActive(bytes32 market) external view returns (bool active, uint16 upliftBps) {
        active = _marketUplift(market);
        upliftBps = active ? _upliftBps : 0;
    }

    /// @inheritdoc IODBacker
    function uplift() external view returns (uint16, uint32) {
        return (_upliftBps, _upliftLead);
    }

    /// @inheritdoc IODBacker
    function isOperator(address owner, address operator) external view returns (bool) {
        return _operators[owner][operator];
    }

    /// @inheritdoc IODBacker
    function batchWindow(uint256 batchId) external view returns (uint64 readyAt, uint64 expiresAt) {
        uint64 s = _batches[batchId].sealedAt;
        if (s == 0) return (0, 0);
        return (s + SEAL_DELAY, s + BATCH_TTL);
    }

    // ================================================================================================ internal

    function _open(address owner, bytes32 gearId, uint256 amount) private returns (uint256 id) {
        if (amount < MIN_COLLATERAL_USDG) revert BelowMinimumCollateral();
        _backable(gearId, registry.gear(gearId));
        _pull(amount);
        id = ++vaultCount;
        VaultData storage v = _vaults[id];
        v.owner = owner;
        v.gearId = gearId;
        v.collateralUsdg = amount;
        v.tollIndexSnapshot = _cum(gearId);
        totalCollateral += amount;
        emit VaultOpened(id, owner, gearId);
        emit CollateralMoved(id, int256(amount), amount);
    }

    function _mint(uint256 vaultId, uint256 tokens, bool sell, uint256 minProceeds) private returns (uint256 proceeds) {
        VaultData storage v = _vaults[vaultId];
        bytes32 g = v.gearId;
        GearConfig memory cfg = registry.gear(g);
        _backable(g, cfg);
        if (mintPaused) revert MintingClosed("PAUSED");
        if (tokens == 0) revert InvalidParams();
        minter.accrue(g);
        _charge(vaultId, v);
        PriceReading memory r = _read(cfg);
        if (!_live(r)) revert MintingClosed("CLOSED");
        if (r.buysPaused) revert MintingClosed(r.reason == 0 ? bytes32("BUYS_PAUSED") : r.reason);
        if (r.refP == 0) revert MintingClosed("REF_UNAVAILABLE");
        v.debtTokens += tokens;
        if (sell) {
            (bool paused, bytes32 why) = governor.buysPaused();
            if (paused) revert MintingClosed(why);
            proceeds = M.proceedsUsdg(tokens, _perToken(cfg, g, r, false), _spreadBps(cfg, r));
            if (proceeds < minProceeds) revert Slippage(proceeds, minProceeds);
            uint256 before = usdg.balanceOf(address(this));
            if (!governor.onBackerMint(g, tokens, true, proceeds)) revert MintingClosed("GOVERNOR_CASH");
            uint256 got = usdg.balanceOf(address(this)) - before;
            if (got < proceeds) revert UsdgNotReceived(proceeds, got);
            v.collateralUsdg += proceeds;
            totalCollateral += proceeds;
            emit CollateralMoved(vaultId, int256(proceeds), v.collateralUsdg);
        } else {
            // supply first, then the book, so the Governor's net never dips by the new debt alone
            minter.backerMint(g, v.owner, tokens);
            governor.onBackerMint(g, tokens, false, 0);
        }
        _requireRatio(v, cfg, r, cfg.collateralBps);
        emit Minted(vaultId, tokens, sell, proceeds);
    }

    /// Charges the toll fee owed since the snapshot from collateral and moves the snapshot. Never reverts: a minter
    /// read that fails skips the charge (the snapshot stays, the fee is charged later), a failed send stays pending.
    function _charge(uint256 vaultId, VaultData storage v) private {
        uint256 cum;
        try minter.normState(v.gearId) returns (NormState memory s) {
            cum = s.cumTollPerTokenWad;
        } catch {
            return;
        }
        uint256 fee = M.tollFee(v.debtTokens, cum, v.tollIndexSnapshot, _feeBps());
        if (cum > v.tollIndexSnapshot) v.tollIndexSnapshot = cum;
        if (fee > v.collateralUsdg) fee = v.collateralUsdg;
        if (fee == 0) return;
        v.collateralUsdg -= fee;
        totalCollateral -= fee;
        pendingFees += fee;
        emit TollFeeCharged(vaultId, fee);
        try this.sendFees(v.gearId) {} catch {}
    }

    function _requireRatio(VaultData storage v, GearConfig memory cfg, PriceReading memory r, uint256 baseBps)
        private
        view
    {
        uint256 debtWad = M.debtValueWad(v.debtTokens, _perToken(cfg, v.gearId, r, true));
        uint256 ratio = M.ratioBps(v.collateralUsdg, debtWad);
        uint256 required = baseBps + _upliftOf(cfg);
        if (ratio < required) revert Undercollateralized(ratio, required);
    }

    /// Value per token, WAD. `high`: the higher of value(p) and value(refP), Ceil (debt is never under-valued);
    /// otherwise the lower, Floor. When not live the guard's p is the last good price. Settled gears use the final
    /// value.
    function _perToken(GearConfig memory cfg, bytes32 g, PriceReading memory r, bool high)
        private
        view
        returns (uint256 v)
    {
        uint256 settled = minter.settledValue(g);
        if (settled != 0) return settled;
        uint256 nf = minter.normState(g).nf;
        Math.Rounding rnd = high ? Math.Rounding.Ceil : Math.Rounding.Floor;
        (v,) = ODIndex.value(cfg.gear, r.p == 0 ? cfg.p0 : r.p, cfg.p0, nf, cfg.unitWad, rnd);
        if (r.refP == 0) return v;
        (uint256 w,) = ODIndex.value(cfg.gear, r.refP, cfg.p0, nf, cfg.unitWad, rnd);
        v = high ? Math.max(v, w) : Math.min(v, w);
    }

    function _spreadBps(GearConfig memory cfg, PriceReading memory r) private view returns (uint256 s) {
        s = cfg.spreadBps;
        if (r.session == Session.EXTENDED) s = s * minter.tradeParams().extendedSpreadMultBps / BPS;
        if (s > BPS) s = BPS;
    }

    function _read(GearConfig memory cfg) private view returns (PriceReading memory) {
        return cfg.marketB == bytes32(0) ? guard.read(cfg.marketA) : guard.readRatio(cfg.marketA, cfg.marketB);
    }

    function _live(PriceReading memory r) private pure returns (bool) {
        return r.fresh && (r.session == Session.OPEN || r.session == Session.EXTENDED);
    }

    function _backable(bytes32 g, GearConfig memory cfg) private view {
        if (cfg.token == address(0) || cfg.gear == Gear.ECO || cfg.status != GearStatus.LISTED) revert NotBackable(g);
        if (minter.settledValue(g) != 0) revert NotBackable(g);
    }

    function _upliftOf(GearConfig memory cfg) private view returns (uint256) {
        bool on = _marketUplift(cfg.marketA) || (cfg.marketB != bytes32(0) && _marketUplift(cfg.marketB));
        return on ? _upliftBps : 0;
    }

    /// Never for a 24/7 market. For a stock market (one exchange calendar, so a pair uses the earlier close of its
    /// legs) from `closeAt - lead` of the next close of >= 24 h until its reopen. Unknown calendar time counts as
    /// active (fail closed: the guard is not live then either).
    function _marketUplift(bytes32 market) private view returns (bool) {
        if (market == bytes32(0) || guard.config(market).alwaysOpen) return false;
        uint256 t = block.timestamp;
        Session k = marketHours.kindAt(t);
        if (k == Session.UNKNOWN) return true;
        (uint64 closeAt, uint64 reopenAt) = marketHours.nextLongClose(t, MIN_CLOSED_FOR_UPLIFT);
        if (closeAt != 0 && t + _upliftLead >= closeAt && t < reopenAt) return true;
        if (k != Session.CLOSED) return false;
        // inside a closed stretch with < 24 h left: long if it was already closed 24 h before its reopen
        (, uint64 r1) = marketHours.nextLongClose(t, 1);
        if (r1 <= MIN_CLOSED_FOR_UPLIFT) return false;
        (, uint64 r2) = marketHours.nextLongClose(r1 - MIN_CLOSED_FOR_UPLIFT, MIN_CLOSED_FOR_UPLIFT);
        return r2 == r1;
    }

    function _feeOwed(VaultData storage v) private view returns (uint256 fee) {
        fee = M.tollFee(v.debtTokens, _cum(v.gearId), v.tollIndexSnapshot, _feeBps());
        if (fee > v.collateralUsdg) fee = v.collateralUsdg;
    }

    function _cum(bytes32 g) private view returns (uint256) {
        return minter.normState(g).cumTollPerTokenWad;
    }

    function _feeBps() private view returns (uint256 bps) {
        bps = 1000;
        try IODFees(fees).tollFeeBps() returns (uint16 b) {
            if (b <= BPS) bps = b;
        } catch {}
    }

    function _liveBatch(uint256 batchId) private view returns (uint256) {
        if (batchId == 0) return 0;
        Batch storage b = _batches[batchId];
        if (b.done || block.timestamp > uint256(b.sealedAt) + BATCH_TTL) return 0;
        return batchId;
    }

    function _pull(uint256 amount) private {
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = usdg.balanceOf(address(this)) - before;
        if (got != amount) revert UsdgNotReceived(amount, got);
    }

    function _known(uint256 vaultId) private view returns (VaultData storage v) {
        v = _vaults[vaultId];
        if (v.owner == address(0)) revert UnknownVault(vaultId);
    }

    function _owned(uint256 vaultId) private view returns (VaultData storage v) {
        v = _known(vaultId);
        if (v.owner != msg.sender) revert NotVaultOwner(vaultId);
    }
}

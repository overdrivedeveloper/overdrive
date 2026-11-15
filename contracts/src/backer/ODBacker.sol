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
import {IODStake} from "../interfaces/IODStake.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";
import {ODBackerMath as M} from "./ODBackerMath.sol";
import {ODLiquidation as L} from "./ODLiquidation.sol";
import {ODSaleCredit} from "./ODSaleCredit.sol";
import {ODMinterPricing} from "../governor/ODMinterPricing.sol";

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
    uint16 public constant MAX_SEAL_DRIFT_BPS = 100;
    uint64 public constant MIN_REWARD_USDG = 1e6;
    uint8 public constant MAX_BATCH = 50;
    uint32 public constant MAX_ROUND_AGE = 15 minutes;
    /// M-6: gas required before each vault of an execute (one liquidation with insurance and stake cover measured at
    /// about 0.3M on mocks); less reverts the whole execute and leaves the batch open
    uint256 public constant MIN_VAULT_GAS = 400_000;
    bytes32 public constant FEE_KIND = "BACKER_TOLL";
    uint256 internal constant BPS = 10_000;

    struct VaultData {
        address owner;
        bytes32 gearId;
        uint256 collateralUsdg;
        uint256 debtTokens;
        uint256 tollIndexSnapshot; // minter cumTollPerTokenWad at the last vault action
        uint256 batchId;
        uint256 ownTokens; // I4-1: the part of debtTokens minted to the owner's wallet and still open
        // I6-1: the part of collateralUsdg that is sale credit held by the Governor (direct-sale proceeds never leave
        // it), and the part of that still locked behind the debt sold to the Governor. Only USDG outside `held.usdg`
        // can be withdrawn; the lock falls with the sold debt and the Governor then pays the rest from its free cash.
        ODSaleCredit.Held held;
    }

    /// @notice Reverts when an address argument is zero.
    error ZeroAddress();
    /// @notice Reverts when parameters are invalid.
    error InvalidParams();
    /// @notice Reverts when the caller or action is not allowed.
    error NotAllowed();
    /// @notice Reverts when the vault does not exist.
    /// @param vaultId Id of the vault.
    error UnknownVault(uint256 vaultId);
    /// @notice Reverts when the USDG expected from a pull did not arrive.
    /// @param needed Amount needed.
    /// @param received Amount received.
    error UsdgNotReceived(uint256 needed, uint256 received);

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
    /// @inheritdoc IODBacker
    uint256 public totalHeld;
    uint256 public pendingFees;
    bool public mintPaused;
    address public stake; // bad-debt slash target after insurance (todo 09); 0 = none
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
        // I4-2: the uplift raises maintenance, so a raise can make a healthy vault sealable: admin (timelock) only
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAllowed();
        _upliftBps = upliftBps;
        _upliftLead = lead;
        emit UpliftSet(upliftBps, lead);
    }

    /// @inheritdoc IODBacker
    function setStake(address stake_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        stake = stake_;
        emit StakeSet(stake_);
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
        _settleHeld(v, 0, 0);
        if (amount > v.collateralUsdg - v.held.usdg) revert Undercollateralized(0, 0);
        v.collateralUsdg -= amount;
        totalCollateral -= amount;
        if (v.debtTokens != 0) {
            GearConfig memory cfg = registry.gear(v.gearId);
            PriceReading memory r = _read(cfg);
            if (minter.settledValue(v.gearId) == 0) {
                if (!r.fresh) revert MintingClosed("STALE");
                _priced(r);
            }
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
        uint256 sold = v.debtTokens - v.ownTokens;
        v.debtTokens -= tokens;
        governor.onBackerRepay(v.gearId, tokens, _ownCleared(v), v.owner);
        _settleHeld(v, sold, 0);
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
            _priced(r);
            cost = M.buyBackUsdg(tokens, _perToken(cfg, g, r, true), _spreadBps(cfg, r));
        }
        if (cost > maxCostUsdg) revert Slippage(cost, maxCostUsdg);
        if (cost > v.collateralUsdg) revert Undercollateralized(0, 0);
        // I6-1: the cost comes out of the sale credit first (cancelled: that USDG is already the Governor's cash)
        uint256 fromHeld = Math.min(cost, v.held.usdg);
        uint256 sold = v.debtTokens - v.ownTokens;
        v.collateralUsdg -= cost;
        totalCollateral -= cost;
        v.debtTokens -= tokens;
        if (cost != fromHeld) {
            usdg.forceApprove(address(governor), cost - fromHeld);
            governor.fundCash(cost - fromHeld);
        }
        governor.onBackerRepay(g, tokens, _ownCleared(v), v.owner);
        _settleHeld(v, sold, fromHeld);
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
    /// @dev I5-1: needs a live reading whose reference exists and agrees with the feed inside the guard's band, with
    /// no continuity or split pause (IODOracleGuard.liquidationBlock on each leg): a reference that disagrees with the
    /// feed never liquidates. I5-3: no separate round-age rule; the guard's per-market age limit and the agreeing
    /// reference (itself fresh) stand for the round, so a quiet feed does not block a seal. The batch keeps only vaults of
    /// `gearId`, not in a live batch, below maintenance (with uplift) at the sealed value with collateral net of the
    /// toll fee owed. The sealed value is the high side of value(p) and value(refP), Ceil (debt never under-valued).
    function sealBatch(bytes32 gearId, uint256[] calldata vaultIds) external nonReentrant returns (uint256 batchId) {
        uint256 n = vaultIds.length;
        if (n == 0 || n > MAX_BATCH) revert InvalidParams();
        GearConfig memory cfg = registry.gear(gearId);
        if (cfg.token == address(0)) revert NotBackable(gearId);
        if (minter.settledValue(gearId) != 0) revert SealRefused("SETTLED");
        try minter.accrue(gearId) {} catch {}
        bytes32 why = _liqBlock(cfg);
        if (why != 0) revert SealRefused(why);
        PriceReading memory r = _read(cfg);
        uint256 value = _perToken(cfg, gearId, r, true);
        uint256 maint = cfg.maintenanceBps + _upliftOf(cfg);
        batchId = ++batchCount;
        Batch storage b = _batches[batchId];
        b.gearId = gearId;
        b.sealedValueWad = value;
        b.sealedAt = uint64(block.timestamp);
        b.feedUpdatedAt = r.updatedAt;
        for (uint256 i; i < n; ++i) {
            uint256 id = vaultIds[i];
            VaultData storage v = _vaults[id];
            if (v.gearId != gearId || v.debtTokens == 0 || _liveBatch(v.batchId) != 0) continue;
            uint256 c = v.collateralUsdg - _feeOwed(v);
            if (M.ratioBps(c, M.debtValueWad(v.debtTokens, value)) >= maint) continue;
            v.batchId = batchId;
            b.vaultIds.push(id);
        }
        if (b.vaultIds.length == 0) revert SealRefused("NONE_UNHEALTHY");
        emit BatchSealed(batchId, gearId, value, b.sealedAt, b.vaultIds);
    }

    /// @inheritdoc IODBacker
    /// @dev Only in [sealedAt + SEAL_DELAY, sealedAt + BATCH_TTL]. Voids the batch (vaults free) when the reading is not
    /// live, the reference is missing or outside the band, a continuity or split pause is on (I5-1), or the current high-side value drifted more than MAX_SEAL_DRIFT_BPS from the sealed value. Each vault is
    /// liquidated in its own self-call under try/catch, so no vault (or its owner) can make the batch revert. No pause
    /// stops it: liquidations reduce risk. M-6: under MIN_VAULT_GAS before a vault, or a caught failure that was out of
    /// gas, reverts ExecuteOutOfGas (the batch stays open); the batch is done only when every vault returned cleanly
    /// (liquidated or released), so a failing vault (e.g. an executor that cannot receive USDG) leaves it open.
    function executeBatch(uint256 batchId) external nonReentrant returns (uint256 liquidated) {
        Batch storage b = _batches[batchId];
        uint256 s = b.sealedAt;
        if (s == 0) revert UnknownBatch(batchId);
        if (b.done) revert BatchDone(batchId);
        if (block.timestamp < s + SEAL_DELAY) revert BatchNotReady(uint64(s + SEAL_DELAY));
        if (block.timestamp > s + BATCH_TTL) revert BatchExpired();
        b.done = true; // reopened below when a vault failed (M-6)
        bytes32 g = b.gearId;
        GearConfig memory cfg = registry.gear(g);
        uint256 g0 = gasleft();
        try minter.accrue(g) {}
        catch {
            _gasGuard(g0);
        }
        bytes32 why = minter.settledValue(g) != 0 ? bytes32("NOT_LIVE") : _liqBlock(cfg);
        if (why != 0) {
            emit BatchVoided(batchId, why);
            return 0;
        }
        PriceReading memory r = _read(cfg);
        uint256 sealedV = b.sealedValueWad;
        uint256 nowV = _perToken(cfg, g, r, true);
        uint256 diff = nowV > sealedV ? nowV - sealedV : sealedV - nowV;
        if (diff * BPS > sealedV * MAX_SEAL_DRIFT_BPS) {
            emit BatchVoided(batchId, "DRIFT");
            return 0;
        }
        uint256 maint = cfg.maintenanceBps + _upliftOf(cfg);
        uint256 n = b.vaultIds.length;
        for (uint256 i; i < n; ++i) {
            g0 = gasleft();
            if (g0 < MIN_VAULT_GAS) revert ExecuteOutOfGas();
            try this.liquidateVault(batchId, b.vaultIds[i], msg.sender, maint) returns (bool ok) {
                if (ok) ++liquidated;
            } catch {
                // M-6: a starved vault (here, or nested: the inner guards revert with at most 1/64 + 1/4096 left)
                // reverts the whole execute; a real revert keeps the batch open for another executor
                _gasGuard(g0);
                b.done = false;
            }
        }
    }

    /// M-6: after a caught failure, revert the whole call when the callee used (almost) all the gas it was given
    /// (63/64 forwarded, so about 1/64 is left on an out-of-gas, plus 1/64 of that per nested level; 1/32 covers
    /// starvation a few calls deep): a gas-starved try never passes as handled.
    function _gasGuard(uint256 g0) private view {
        if (gasleft() <= g0 / 32) revert ExecuteOutOfGas();
    }

    /// One vault of an executing batch. Self-call only (its own revert scope, R6). Returns false when the vault was
    /// rescued (repaid or topped up above maintenance at the sealed value) and is released instead.
    /// @dev Split: executor bonus B = 5% of the debt value D (sealed value, Ceil to USDG); the Governor receives
    /// min(collateral - B, D) and takes over the debt; the rest returns to the vault. A shortfall D + B - collateral is
    /// asked of insurance first, then the stake; what is still missing is absorbed by Governor equity (bad debt).
    function liquidateVault(uint256 batchId, uint256 vaultId, address executor, uint256 maintBps)
        external
        returns (bool)
    {
        if (msg.sender != address(this)) revert NotAllowed();
        VaultData storage v = _vaults[vaultId];
        if (v.batchId != batchId || v.debtTokens == 0) return false;
        _charge(vaultId, v);
        uint256 dWad = M.debtValueWad(v.debtTokens, _batches[batchId].sealedValueWad);
        if (M.ratioBps(v.collateralUsdg, dWad) >= maintBps) return false;
        uint256 tokens = v.debtTokens;
        uint256 coll = v.collateralUsdg;
        v.debtTokens = 0;
        v.collateralUsdg = 0;
        totalCollateral -= coll;
        L.Split memory x = L.split(dWad, coll, BONUS_BPS, MIN_REWARD_USDG);
        uint256 pool = coll;
        if (x.gap != 0) pool += _recover(x.gap);
        x = L.settle(x, pool);
        if (x.floorGap != 0) x.bonus += _governorPays(v.gearId, x.floorGap);
        if (x.surplus != 0) {
            v.collateralUsdg = x.surplus;
            totalCollateral += x.surplus;
            emit CollateralMoved(vaultId, int256(x.surplus), x.surplus);
        }
        {
            // I6-1: sale credit pays the Governor's share first (cancelled, no transfer), then stays with the vault as
            // its surplus; only the rest is asked of the Governor's free cash, and the bonus is less by what it lacks
            (uint256 cancel, uint256 unpaid, uint256 out) =
                ODSaleCredit.seize(v.held, governor, x.toGovernor, x.surplus);
            x.toGovernor -= cancel;
            x.bonus -= unpaid;
            totalHeld -= out;
        }
        if (x.toGovernor != 0) usdg.safeTransfer(address(governor), x.toGovernor);
        governor.absorbLiquidation(v.gearId, tokens, _ownCleared(v), x.toGovernor, v.owner);
        if (x.bonus != 0) usdg.safeTransfer(executor, x.bonus);
        emit Liquidated(batchId, vaultId, tokens, coll - x.surplus, x.bonus, x.badDebt);
        return true;
    }

    /// Shortfall cover: insurance first, then the stake (if set). Amounts are measured by balance, never trusted.
    function _recover(uint256 gap) private returns (uint256 got) {
        uint256 before = usdg.balanceOf(address(this));
        if (address(insurance) != address(0)) {
            uint256 g0 = gasleft();
            try insurance.cover(gap) {}
            catch {
                _gasGuard(g0);
            }
        }
        got = usdg.balanceOf(address(this)) - before;
        if (got >= gap) return got;
        // the stake is optional (todo 09); its slash never reverts (SlashFailed returns 0), guarded anyway
        address st = stake;
        if (st != address(0)) {
            uint256 g1 = gasleft();
            try IODStake(st).slash(gap - got) {}
            catch {
                _gasGuard(g1);
            }
        }
        got = usdg.balanceOf(address(this)) - before;
    }

    /// Last resort for the executor's minimum reward (PERP-5): the Governor's free cash, through the backer sale hook
    /// with zero tokens (pays `amount` from tracked cash, no debt change). Returns what arrived (0 if refused).
    function _governorPays(bytes32 g, uint256 amount) private returns (uint256 got) {
        uint256 before = usdg.balanceOf(address(this));
        uint256 g0 = gasleft();
        try governor.onBackerMint(g, 0, true, amount, address(0)) {}
        catch {
            _gasGuard(g0);
        }
        got = usdg.balanceOf(address(this)) - before;
        if (got > amount) got = amount;
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
    function vaultOwnDebt(uint256 vaultId) external view returns (uint256) {
        return _vaults[vaultId].ownTokens;
    }

    /// @inheritdoc IODBacker
    function vaultHeld(uint256 vaultId) external view returns (uint256, uint256) {
        return (_vaults[vaultId].held.usdg, _vaults[vaultId].held.locked);
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
    function batch(uint256 batchId) external view returns (Batch memory) {
        return _batches[batchId];
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
        if (_liveBatch(v.batchId) != 0) revert InBatch(vaultId);
        if (mintPaused) revert MintingClosed("PAUSED");
        if (tokens == 0) revert InvalidParams();
        minter.accrue(g);
        _charge(vaultId, v);
        PriceReading memory r = _read(cfg);
        if (!_live(r)) revert MintingClosed("CLOSED");
        if (r.buysPaused) revert MintingClosed(r.reason == 0 ? bytes32("BUYS_PAUSED") : r.reason);
        if (r.refP == 0) revert MintingClosed("REF_UNAVAILABLE");
        v.debtTokens += tokens;
        // the sale value: credited (held by the Governor) when sold to the Governor, held back in the Governor's lock when minted to the owner
        uint256 value = M.proceedsUsdg(tokens, _perToken(cfg, g, r, false), _spreadBps(cfg, r));
        if (sell) {
            (bool paused, bytes32 why) = governor.buysPaused();
            if (paused) revert MintingClosed(why);
            proceeds = value;
            if (proceeds < minProceeds) revert Slippage(proceeds, minProceeds);
            // I6-1: the proceeds stay in the Governor as sale credit: collateral of this vault, locked behind the debt
            if (!governor.onBackerMint(g, tokens, true, proceeds, v.owner)) revert MintingClosed("GOVERNOR_CASH");
            v.collateralUsdg += proceeds;
            v.held.usdg += proceeds;
            v.held.locked += proceeds;
            totalCollateral += proceeds;
            totalHeld += proceeds;
            emit CollateralMoved(vaultId, int256(proceeds), v.collateralUsdg);
        } else {
            // supply first, then the book, so the Governor's net never dips by the new debt alone
            minter.backerMint(g, v.owner, tokens);
            v.ownTokens += tokens;
            if (!governor.onBackerMint(g, tokens, false, value, v.owner)) revert MintingClosed("GOVERNOR_CASH");
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
        uint256 liquid = v.collateralUsdg - v.held.usdg;
        if (fee > liquid) {
            // I6-1: the rest of the fee comes out of the sale credit, as far as the Governor's free cash pays it
            uint256 got = ODSaleCredit.payFee(v.held, governor, fee - liquid);
            totalHeld -= got;
            fee = liquid + got;
        }
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
        return ODMinterPricing.backerValue(cfg.gear, cfg.p0, cfg.unitWad, minter.normState(g).nf, r.p, r.refP, high);
    }

    /// Same lag floor as the minter (M-4, rescore 1): a mint-and-sell then repayWithUsdg (or the reverse) across a move
    /// of up to lagBandBps that neither source shows yet never pays (both legs' bands for a pair). Applied last.
    function _spreadBps(GearConfig memory cfg, PriceReading memory r) private view returns (uint256 s) {
        IODMinter.TradeParams memory tp = minter.tradeParams();
        s = cfg.spreadBps;
        if (r.session == Session.EXTENDED) s = s * tp.extendedSpreadMultBps / BPS;
        uint256 f = ODMinterPricing.lagFloorBps(cfg.gear, tp.lagBandBps, cfg.marketB != bytes32(0));
        if (s < f) s = f;
        if (s > BPS) s = BPS;
    }

    function _read(GearConfig memory cfg) private view returns (PriceReading memory) {
        return cfg.marketB == bytes32(0) ? guard.read(cfg.marketA) : guard.readRatio(cfg.marketA, cfg.marketB);
    }

    /// I4-3: an action that takes value out of a vault at a price (collateral out with debt open, debt bought back
    /// with collateral) never runs on the feed alone unless its round is recent: it needs a reference, or a live round
    /// at most MAX_ROUND_AGE old. Exits that use no price stay open: repay with tokens, withdraw with no debt.
    function _priced(PriceReading memory r) private view {
        if (r.refP == 0 && (!_live(r) || block.timestamp - r.updatedAt > MAX_ROUND_AGE)) {
            revert MintingClosed("REF_UNAVAILABLE");
        }
    }

    /// I5-1: why a liquidation must not be priced now (either leg of a pair), zero when it may.
    function _liqBlock(GearConfig memory cfg) private view returns (bytes32 why) {
        why = guard.liquidationBlock(cfg.marketA);
        if (why == 0 && cfg.marketB != bytes32(0)) why = guard.liquidationBlock(cfg.marketB);
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

    /// I4-1: lowers the vault's own-minted debt to the debt left and returns the part cleared. Debt sold to the
    /// Governor clears first, so the own-minted part (and the Governor's lock behind it) is the last to go: a repay or
    /// a liquidation never clears more own-minted debt than this vault itself still carries.
    function _ownCleared(VaultData storage v) private returns (uint256 cleared) {
        uint256 left = v.debtTokens;
        uint256 own = v.ownTokens;
        if (own > left) {
            cleared = own - left;
            v.ownTokens = left;
        }
    }

    /// I6-1: settles the vault's sale credit after its sold debt (debt not minted to the owner's wallet) fell from
    /// `soldBefore` and `cancel` of the credit paid a buy-back (ODSaleCredit.settle): the lock falls with the sold
    /// debt and the Governor pays the unlocked part from its free cash, as far as that goes.
    function _settleHeld(VaultData storage v, uint256 soldBefore, uint256 cancel) private {
        totalHeld -= ODSaleCredit.settle(v.held, governor, v.debtTokens - v.ownTokens, soldBefore, cancel);
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

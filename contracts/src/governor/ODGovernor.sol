// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GearConfig} from "../interfaces/ODTypes.sol";
import {IODGovernor} from "../interfaces/IODGovernor.sol";
import {IODGearRegistry} from "../interfaces/IODGearRegistry.sol";
import {IODOracleGuard} from "../interfaces/IODOracleGuard.sol";
import {IODInsurance} from "../interfaces/IODInsurance.sol";
import {IODFees} from "../interfaces/IODFees.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";
import {ODGovernorRisk} from "./ODGovernorRisk.sol";

/// @title ODGovernor
/// @notice The house book: an ERC-4626 vault of USDG owned by backers (allowlisted depositors) that is the
/// counterparty of every gear. It holds tracked cash, a ring-fenced exit reserve and hedge equity; it owes holders the
/// value of their gears net of backer debt. Buys pass its caps, stress budget and pauses; sells are never gated.
/// @dev Accounting is internal (`_b`: cash, exit reserve, backer sale lock): USDG sent by plain transfer changes
/// neither NAV nor the share price and can only be skimmed to ODInsurance. Seeding is by `deposit` only (VAULT-1). Shares have a 1e6 virtual
/// offset (12 dp) and the drawdown pause measures this vault's own share price, so an amount sent before the first
/// deposit belongs to the virtual shares and never reads as a loss. Non-upgradeable (DECISIONS D2).
contract ODGovernor is ERC4626, AccessControl, ReentrancyGuardTransient, IODGovernor {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant TO_WAD = 1e12; // USDG 6 dp to WAD
    uint256 private constant RING = 31;
    uint256 private constant DD_DAYS = 30;
    uint256 private constant MIN_FIRST_DEPOSIT = 1e6;
    uint256 private constant MAX_HEDGED_MARKETS = 64;
    int256 private constant TRANSIT_DUST = 1e6; // L-8: unabsorbed transit up to 1 USDG never ages (venue fee, rounding)

    IODGearRegistry public immutable registry;
    IODOracleGuard public immutable guard;
    IODInsurance public immutable insurance;
    IODFees public immutable fees;

    address public minter;
    address public backer;
    address public hedgerWallet;

    Params private _p;
    /// Free cash, the exit reserve and (M-7) the per-gear backer sale lock, tracked apart (see ODGovernorRisk.Books).
    ODGovernorRisk.Books private _b;
    uint128 private _owedToll;
    uint128 private _owedSpread;
    bool private _paused;

    mapping(bytes32 gearId => uint256) private _debt;
    mapping(bytes32 market => uint8) private _group;

    struct Stress {
        uint192 lossWad;
        uint64 at;
    }

    mapping(bytes32 market => Stress) private _stress;
    uint256 private _totalStress;

    struct Hedge {
        int256 deltaWad;
        uint128 equityUsdg;
        uint64 asOf;
        bool listed;
    }

    mapping(bytes32 market => Hedge) private _hedge;
    bytes32[] private _hedged;
    uint256 private _hedgePosted; // sum of the markets' posted equity (USDG)
    int256 private _transit; // USDG sent to the hedger (+) or returned (-) and not yet seen in a post
    uint64 private _transitAt; // L-2: when _transit last rose above TRANSIT_DUST (0 while it is not above it)
    ODGovernorRisk.JumpWindow private _jump; // unexplained hedge change this window (M-2)

    int256 private _eqWad;
    uint64 private _eqAt;
    uint256 private _eqSharePrice;
    uint256[RING] private _ring; // ((day + 1) << 224) | share price WAD, the day's highest sample

    mapping(address => bool) public isDepositor;

    struct Ticket {
        address owner;
        uint64 claimableAt;
        uint256 shares;
    }

    mapping(uint256 => Ticket) private _tickets;
    uint256 public nextTicket;
    bool private _escrowing;

    constructor(
        IERC20 usdg,
        address admin,
        address guardian,
        IODGearRegistry registry_,
        IODOracleGuard guard_,
        IODInsurance insurance_,
        address fees_
    ) ERC4626(usdg) ERC20("Overdrive Governor Share", "odGOV") {
        if (
            address(usdg) == address(0) || admin == address(0) || guardian == address(0)
                || address(registry_) == address(0) || address(guard_) == address(0)
                || address(insurance_) == address(0) || fees_ == address(0)
        ) revert InvalidParams();
        registry = registry_;
        guard = guard_;
        insurance = insurance_;
        fees = IODFees(fees_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ODRoles.GUARDIAN_ROLE, guardian);
        _p = Params({
            stressBudgetBps: 1500,
            capScaleBps: 5000,
            exitReserveFloorBps: 1000,
            minExitReserveUsdg: 1_000e6,
            maxHedgeEquityBps: 3000,
            maxHedgeJumpBps: 500,
            hedgeMaxAge: 2 hours,
            equityMaxAge: 1 hours,
            drawdownBps: 1000,
            withdrawDelay: 72 hours,
            shockStockBps: 2500,
            shockEtfBps: 1500,
            shockCryptoBps: 3000,
            shockPairBps: 2000,
            maxLockBps: 2000,
            maxLockOwnerBps: 2500,
            maxReserveMoveBps: 1000
        });
    }

    modifier onlyMinter() {
        if (msg.sender != minter || msg.sender == address(0)) revert NotMinter();
        _;
    }

    modifier onlyBacker() {
        if (msg.sender != backer || msg.sender == address(0)) revert NotBacker();
        _;
    }

    // ================================================================================= minter hooks

    /// @inheritdoc IODGovernor
    /// @dev Called after the minter minted `tokens` to the buyer and moved `usdgIn` to this contract. Reverts BuysPaused,
    /// CapExceeded or StressBudget; the minter's quote reads the same check through `buyBlock` (QUOTE-1).
    function onBuy(bytes32 gearId, uint256, uint256 usdgIn, uint256 spreadUsdg) external onlyMinter nonReentrant {
        _received(usdgIn);
        _b.cash += usdgIn;
        (bytes32 reason, uint256 a, uint256 b, bytes32 market, uint256 loss) = _check(gearId, 0);
        if (reason == "CAP") revert CapExceeded(gearId, a, b);
        if (reason == "STRESS") revert StressBudget(a, b);
        if (reason != 0) revert BuysPaused(reason);
        _storeStress(market, loss);
        _oweSpread(spreadUsdg);
        _settleFees();
        _emitBook(gearId);
    }

    /// @inheritdoc IODGovernor
    /// @dev Never reverts for caps, stress, pauses or drawdown (PERP-2). Books the protocol share of the spread as owed
    /// (paid from the next cash inflow), then pays. M-7: the share for tokens that took supply below the gear's own-minted
    /// backer debt comes from the gear's lock, then free cash, never the exit reserve or insurance; the rest (all of it
    /// when no such debt is open) from free cash, the exit reserve, then ODInsurance cover.
    /// Returns false (never reverts) when short or when the USDG transfer fails; a transfer failing for lack of gas
    /// reverts so a caller cannot choose gas to force a queued sell.
    function onSell(bytes32 gearId, uint256 tokens, uint256 spreadUsdg, address to, uint256 usdg)
        external
        onlyMinter
        nonReentrant
        returns (bool)
    {
        _oweSpread(spreadUsdg);
        if (tokens != 0) _emitBook(gearId); // a bare payout (no tokens) books no gear
        return ODGovernorRisk.paySell(_b, _debt, IERC20(asset()), insurance, registry, gearId, tokens, to, usdg);
    }

    /// @inheritdoc IODGovernor
    /// @dev Positive toll books tollFeeBps of it as a fee to ODFees ("TOLL"), paid from free cash now or owed; negative
    /// toll (ECO) books no fee. Never reverts.
    function onToll(bytes32 gearId, int256 tollValueUsdWad) external onlyMinter nonReentrant {
        uint256 fee;
        if (tollValueUsdWad > 0) {
            uint256 bps = 1000;
            try fees.tollFeeBps() returns (uint16 b) {
                if (b <= BPS) bps = b;
            } catch {}
            fee = uint256(tollValueUsdWad) * bps / BPS / TO_WAD;
            if (fee != 0) {
                _owedToll += uint128(fee);
                emit FeeOwed("TOLL", fee, _owedToll);
                _settleFees();
            }
        }
        emit TollBooked(gearId, tollValueUsdWad, fee);
    }

    // ================================================================================= backer hooks

    /// @inheritdoc IODGovernor
    /// @dev `soldToGovernor`: the backer's minted tokens go to the Governor's account (no supply change), lowering
    /// net; the proceeds come from free cash only (never the exit reserve), false when short. A net long beyond the
    /// gear's static cap reverts CapExceeded. Minted to the owner's wallet (M-7): `proceedsUsdg` (the tokens' sale
    /// value) moves from free cash into the gear's lock, false when short; reverts CapExceeded when the gear's total
    /// backer debt x value (net if every holder exits) passes the static cap. The tokens join the gear's own-minted
    /// debt (backerOwnDebt), the only debt that changes how a sell is paid. M-8: also false when the locks of all
    /// gears would pass Params.maxLockBps of free cash plus locks, so own mints cannot park the Governor's free cash.
    /// L-12: and false when `owner`'s open locks would pass Params.maxLockOwnerBps of that ceiling.
    function onBackerMint(bytes32 gearId, uint256 tokens, bool soldToGovernor, uint256 proceedsUsdg, address owner)
        external
        onlyBacker
        nonReentrant
        returns (bool)
    {
        if (proceedsUsdg > _b.cash) return false;
        if (!soldToGovernor && !ODGovernorRisk.lockOwn(_b, _p, gearId, owner, tokens, proceedsUsdg)) return false;
        _debt[gearId] += tokens;
        (uint256 open, uint256 cap, int256 net) = ODGovernorRisk.mintOpen(_ctx(), _debt, gearId, !soldToGovernor);
        if (net < 0 && open > cap) revert CapExceeded(gearId, open, cap);
        if (soldToGovernor && proceedsUsdg != 0) {
            _b.cash -= proceedsUsdg;
            if (!IERC20(asset()).trySafeTransfer(msg.sender, proceedsUsdg)) {
                _b.cash += proceedsUsdg;
                _debt[gearId] -= tokens;
                return false;
            }
        }
        _emitBook(gearId);
        return true;
    }

    /// @inheritdoc IODGovernor
    /// @dev Lowers the gear's own-minted debt by `ownTokens` and releases that share of its lock to free cash.
    function onBackerRepay(bytes32 gearId, uint256 tokens, uint256 ownTokens, address owner)
        external
        onlyBacker
        nonReentrant
    {
        _repay(gearId, tokens, ownTokens, owner);
        _emitBook(gearId);
    }

    /// @inheritdoc IODGovernor
    /// @dev The collateral (USDG) has already arrived; it becomes tracked cash. Releases the lock like a repay.
    function absorbLiquidation(
        bytes32 gearId,
        uint256 debtTokens,
        uint256 ownTokens,
        uint256 collateralUsdg,
        address owner
    ) external onlyBacker nonReentrant {
        _received(collateralUsdg);
        _repay(gearId, debtTokens, ownTokens, owner);
        _b.cash += collateralUsdg;
        _settleFees();
        emit Liquidation(gearId, debtTokens, collateralUsdg);
        _emitBook(gearId);
    }

    // ================================================================================= cash and reserve

    /// @inheritdoc IODGovernor
    function fundCash(uint256 usdg) external nonReentrant {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), usdg);
        _b.cash += usdg;
        emit CashFunded(msg.sender, usdg);
        _settleFees();
    }

    /// @inheritdoc IODGovernor
    function fundExitReserve(uint256 usdg) external nonReentrant {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), usdg);
        _b.reserve += usdg;
        emit ExitReserveMoved(usdg, _b.reserve);
    }

    /// @inheritdoc IODGovernor
    /// @dev I4-5: the keeper is held to Params.maxReserveMoveBps of free cash per 24 h window (ReserveMoveCap); the
    /// admin (the timelock) is not.
    function moveToExitReserve(uint256 usdg) external nonReentrant {
        bool admin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!admin && !hasRole(ODRoles.KEEPER_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, ODRoles.KEEPER_ROLE);
        }
        ODGovernorRisk.toReserve(_b, usdg, _p.maxReserveMoveBps, !admin);
    }

    /// @inheritdoc IODGovernor
    function moveFromExitReserve(uint256 usdg) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        ODGovernorRisk.fromReserve(_b, usdg);
        _settleFees();
    }

    /// @inheritdoc IODGovernor
    function skim() external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        IERC20 u = IERC20(asset());
        uint256 bal = u.balanceOf(address(this));
        uint256 books = _b.cash + _b.reserve + _b.locked;
        if (bal <= books) return;
        uint256 extra = bal - books;
        u.forceApprove(address(insurance), extra);
        insurance.fund(extra);
        emit Skimmed(extra);
    }

    // ================================================================================= hedger

    /// @inheritdoc IODGovernor
    function postHedge(bytes32 market, int256 hedgeDeltaWad, uint256 hedgeEquityUsdg, uint64 asOf)
        external
        nonReentrant
    {
        bool admin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!admin) _checkRole(ODRoles.HEDGER_ROLE);
        Hedge storage h = _hedge[market];
        if (asOf > block.timestamp || asOf < h.asOf) revert BadAsOf(asOf);
        if (hedgeEquityUsdg > type(uint128).max) revert InvalidParams();
        uint256 prev = h.equityUsdg;
        int256 t = _transit;
        // Cumulative bound per window, not per call (M-2): the rule lives in ODGovernorRisk.jumpRange.
        int256 absorbed = ODGovernorRisk.hedgeJump(_jump, _p, prev, hedgeEquityUsdg, t, _jumpEq(), admin);
        _setTransit(t - absorbed);
        if (!h.listed) {
            if (_hedged.length >= MAX_HEDGED_MARKETS) revert InvalidParams();
            h.listed = true;
            _hedged.push(market);
        }
        _hedgePosted = _hedgePosted - prev + hedgeEquityUsdg;
        h.deltaWad = hedgeDeltaWad;
        h.equityUsdg = uint128(hedgeEquityUsdg);
        h.asOf = asOf;
        emit HedgePosted(market, hedgeDeltaWad, hedgeEquityUsdg, asOf);
    }

    /// @inheritdoc IODGovernor
    function sendToHedger(uint256 usdg) external onlyRole(ODRoles.HEDGER_ROLE) nonReentrant {
        address to = hedgerWallet;
        if (to == address(0)) revert NoHedger();
        if (usdg > _b.cash) revert InsufficientCash(usdg, _b.cash);
        uint256 afterUsdg = _hedgeTotal() + usdg;
        uint256 cap = _eqWad > 0 ? Math.mulDiv(uint256(_eqWad), _p.maxHedgeEquityBps, BPS * TO_WAD) : 0;
        if (afterUsdg > cap) revert HedgeCap(afterUsdg, cap);
        _b.cash -= usdg;
        _setTransit(_transit + int256(usdg));
        IERC20(asset()).safeTransfer(to, usdg);
        emit SentToHedger(to, usdg);
    }

    /// @inheritdoc IODGovernor
    function returnFromHedger(uint256 usdg) external onlyRole(ODRoles.HEDGER_ROLE) nonReentrant {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), usdg);
        _b.cash += usdg;
        _setTransit(_transit - int256(usdg));
        emit ReturnedFromHedger(msg.sender, usdg);
        _settleFees();
    }

    // ================================================================================= risk

    /// @inheritdoc IODGovernor
    /// @dev Permissionless: recomputes the stress of `markets`, refreshes cached equity and samples the share price.
    function pokeRisk(bytes32[] calldata markets) external nonReentrant {
        ODGovernorRisk.Ctx memory c = _ctx();
        for (uint256 i; i < markets.length; ++i) {
            _storeStress(markets[i], _marketLoss(c, markets[i], 0, 0));
        }
        ODGovernorRisk.Book memory b = ODGovernorRisk.book(c, _debt);
        int256 e = _equityWad(b.mid);
        _refresh(e);
        emit RiskPoked(_totalStress, _budget(e), e);
    }

    /// @inheritdoc IODGovernor
    /// @dev Guardian or admin pause; only the admin (the 48 h timelock) unpauses.
    function setBuysPaused(bool paused) external {
        if (paused) {
            if (!hasRole(ODRoles.GUARDIAN_ROLE, msg.sender)) _checkRole(DEFAULT_ADMIN_ROLE);
        } else {
            _checkRole(DEFAULT_ADMIN_ROLE);
        }
        _paused = paused;
        emit BuysPausedSet(paused);
    }

    // ================================================================================= vault (backers)

    /// @notice Deposits USDG from an allowlisted depositor for itself, priced at the high edge of the NAV band.
    function deposit(uint256 assets, address receiver)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256 shares)
    {
        if (!isDepositor[msg.sender] || receiver != msg.sender) revert DepositorNotAllowed(msg.sender);
        ODGovernorRisk.Book memory b = ODGovernorRisk.book(_ctx(), _debt);
        uint256 supply = totalSupply();
        if (supply == 0 && assets < MIN_FIRST_DEPOSIT) revert FirstDepositTooSmall();
        int256 high = _equityHigh(b);
        if (high < 0 || (high == 0 && supply != 0)) revert NavNotPositive();
        shares = _shares(assets, high, supply);
        if (shares == 0) revert InvalidParams();
        _deposit(msg.sender, receiver, assets, shares);
        _b.cash += assets;
        _settleFees();
        _refresh(_equityWad(b.mid));
    }

    /// @notice Disabled: shares come only from `deposit`.
    function mint(uint256, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert UseWithdrawalQueue();
    }

    /// @notice Disabled: exits use `requestWithdraw` then `claim`.
    function withdraw(uint256, address, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert UseWithdrawalQueue();
    }

    /// @notice Disabled: exits use `requestWithdraw` then `claim`.
    function redeem(uint256, address, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert UseWithdrawalQueue();
    }

    /// @inheritdoc IODGovernor
    function requestWithdraw(uint256 shares) external nonReentrant returns (uint256 ticket) {
        if (shares == 0) revert InvalidParams();
        _escrowing = true;
        _transfer(msg.sender, address(this), shares);
        _escrowing = false;
        ticket = ++nextTicket;
        uint64 at = uint64(block.timestamp + _p.withdrawDelay);
        _tickets[ticket] = Ticket({owner: msg.sender, claimableAt: at, shares: shares});
        emit WithdrawalQueued(msg.sender, ticket, shares, at);
    }

    /// @inheritdoc IODGovernor
    /// @dev Pays at the low edge of the NAV band, limited by free cash and by the stress budget after payment; the
    /// unpaid shares stay on the ticket (a short claim pays less, never reverts for lack of cash). Never touches the
    /// exit reserve; open under every pause. Under a stale hedge the low edge leaves out all hedge equity (M-3): with
    /// `minAssetsOut == 0` the claim fails closed (HedgeStale), with an explicit minimum the caller accepts that price
    /// (L-6). Reverts ClaimBelowMin when the USDG paid is under the caller's `minAssetsOut`.
    function claim(uint256 ticket, uint256 minAssetsOut) external nonReentrant returns (uint256 paid) {
        Ticket storage t = _tickets[ticket];
        if (t.owner != msg.sender) revert NotTicketOwner(ticket);
        if (block.timestamp < t.claimableAt) revert TooEarly(t.claimableAt);
        // L-6: under a stale hedge the low edge holds no hedge equity; an explicit minimum accepts that price
        if (minAssetsOut == 0 && hedgeStale()) revert HedgeStale();
        uint256 shares = t.shares;
        ODGovernorRisk.Book memory b = ODGovernorRisk.book(_ctx(), _debt);
        int256 mid = _equityWad(b.mid);
        int256 low = _equityLow(b);
        uint256 supply = totalSupply();
        uint256 value = low > 0 ? Math.mulDiv(shares, uint256(low) / TO_WAD + 1, supply + 10 ** _decimalsOffset()) : 0;
        paid = value;
        if (paid > _b.cash) paid = _b.cash;
        uint256 room = _claimRoom(mid);
        if (paid > room) paid = room;
        if (paid < minAssetsOut) revert ClaimBelowMin(paid, minAssetsOut);
        if (paid != 0) {
            uint256 burn = paid == value ? shares : Math.mulDiv(shares, paid, value, Math.Rounding.Ceil);
            if (burn > shares) burn = shares;
            t.shares = shares - burn;
            _b.cash -= paid;
            _burn(address(this), burn);
            IERC20(asset()).safeTransfer(msg.sender, paid);
            emit Withdraw(msg.sender, msg.sender, msg.sender, paid, burn);
        }
        emit WithdrawalClaimed(msg.sender, ticket, paid);
        _refresh(mid - int256(paid * TO_WAD));
    }

    // ================================================================================= admin

    /// @inheritdoc IODGovernor
    function setMinter(address m) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minter != address(0)) revert AlreadySet();
        if (m == address(0)) revert InvalidParams();
        minter = m;
        emit ModuleSet("MINTER", m);
    }

    /// @inheritdoc IODGovernor
    function setBacker(address b) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (backer != address(0)) revert AlreadySet();
        if (b == address(0)) revert InvalidParams();
        backer = b;
        emit ModuleSet("BACKER", b);
    }

    /// @inheritdoc IODGovernor
    function setHedger(address w) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (w == address(0) || w == address(this)) revert InvalidParams();
        hedgerWallet = w;
        emit ModuleSet("HEDGER", w);
    }

    /// @inheritdoc IODGovernor
    function setDepositor(address account, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0) || account == address(this)) revert InvalidParams();
        isDepositor[account] = allowed;
        emit DepositorSet(account, allowed);
    }

    /// @inheritdoc IODGovernor
    function setMarketGroup(bytes32 market, uint8 group) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (group > 2) revert InvalidParams();
        _group[market] = group;
        emit MarketGroupSet(market, group);
    }

    /// @inheritdoc IODGovernor
    function setParams(Params calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ODGovernorRisk.setParams(_p, p);
    }

    // ================================================================================= views

    /// @notice NAV in USDG (6 dp): max(0, cash + exit reserve + hedge equity - liability at p - fees owed).
    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        int256 e = equity();
        return e > 0 ? uint256(e) / TO_WAD : 0;
    }

    /// @inheritdoc IODGovernor
    function equity() public view returns (int256) {
        return _equityWad(ODGovernorRisk.book(_ctx(), _debt).mid);
    }

    /// @inheritdoc IODGovernor
    function navBand() public view returns (int256 lowWad, int256 highWad) {
        ODGovernorRisk.Book memory b = ODGovernorRisk.book(_ctx(), _debt);
        return (_equityLow(b), _equityHigh(b));
    }

    /// @inheritdoc IODGovernor
    function sharePriceWad() public view returns (uint256) {
        return convertToAssets(10 ** decimals()) * TO_WAD;
    }

    /// @inheritdoc IODGovernor
    /// @dev Computed on read from the live share price: no latch, recovers by itself, and no function resets a peak.
    function drawdown() external view returns (uint256 peakWad, uint256 nowWad, bool tripped) {
        nowWad = sharePriceWad();
        peakWad = _peak();
        if (nowWad > peakWad && totalSupply() != 0) peakWad = nowWad;
        tripped = _tripped(peakWad, nowWad);
    }

    /// @inheritdoc IERC4626
    function maxDeposit(address receiver) public view override(ERC4626, IERC4626) returns (uint256) {
        if (!isDepositor[receiver]) return 0;
        try this.navBand() returns (int256, int256 high) {
            if (high < 0 || (high == 0 && totalSupply() != 0)) return 0;
            return type(uint256).max;
        } catch {
            return 0;
        }
    }

    /// @inheritdoc IERC4626
    function maxMint(address) public pure override(ERC4626, IERC4626) returns (uint256) {
        return 0;
    }

    /// @inheritdoc IERC4626
    function maxWithdraw(address) public pure override(ERC4626, IERC4626) returns (uint256) {
        return 0;
    }

    /// @inheritdoc IERC4626
    function maxRedeem(address) public pure override(ERC4626, IERC4626) returns (uint256) {
        return 0;
    }

    /// @notice Shares `assets` buys now (high edge of the NAV band).
    function previewDeposit(uint256 assets) public view override(ERC4626, IERC4626) returns (uint256) {
        (, int256 high) = navBand();
        return high < 0 ? 0 : _shares(assets, high, totalSupply());
    }

    /// @notice Indicative USDG for `shares` at today's low edge (a ticket pays at claim time).
    function previewRedeem(uint256 shares) public view override(ERC4626, IERC4626) returns (uint256) {
        (int256 low,) = navBand();
        return low > 0 ? Math.mulDiv(shares, uint256(low) / TO_WAD + 1, totalSupply() + 10 ** _decimalsOffset()) : 0;
    }

    /// @inheritdoc IODGovernor
    function buyBlock(bytes32 gearId, uint256 addTokens) external view returns (bytes32 reason) {
        (reason,,,,) = _check(gearId, addTokens);
    }

    /// @inheritdoc IODGovernor
    function canPay(uint256 usdg) external view returns (bool) {
        return canPaySell(0, 0, usdg, 0);
    }

    /// @inheritdoc IODGovernor
    /// @dev Mirrors onSell's payout split before the burn (QUOTE-1).
    function canPaySell(bytes32 gearId, uint256 tokens, uint256 usdg, uint256 cashDrain) public view returns (bool) {
        return ODGovernorRisk.canPaySell(_b, _debt, insurance, registry, gearId, tokens, usdg, cashDrain);
    }

    /// @inheritdoc IODGovernor
    function exposure(bytes32 market) external view returns (int256, int256, uint256) {
        return ODGovernorRisk.exposure(_ctx(), _debt, market);
    }

    /// @inheritdoc IODGovernor
    function netTokens(bytes32 gearId) external view returns (int256) {
        return _net(gearId);
    }

    /// @inheritdoc IODGovernor
    function backerDebt(bytes32 gearId) external view returns (uint256) {
        return _debt[gearId];
    }

    /// @inheritdoc IODGovernor
    function stressLoss() external view returns (uint256 lossWad, uint256 budgetWad) {
        return (_totalStress, _budget(_eqWad));
    }

    /// @inheritdoc IODGovernor
    function cachedStress(bytes32 market) external view returns (uint256, uint64) {
        Stress memory s = _stress[market];
        return (s.lossWad, s.at);
    }

    /// @inheritdoc IODGovernor
    function capOf(bytes32 gearId) external view returns (uint256 capWad, uint256 openWad) {
        uint256 staticCap;
        (openWad, staticCap,) = ODGovernorRisk.gearOpen(_ctx(), _debt, gearId, 0);
        capWad = _cap(staticCap);
    }

    /// @inheritdoc IODGovernor
    function exitReserve() external view returns (uint256) {
        return _b.reserve;
    }

    /// @inheritdoc IODGovernor
    function exitReserveFloor() external view returns (uint256) {
        uint256 open = ODGovernorRisk.book(_ctx(), _debt).holderOpen;
        uint256 f = Math.mulDiv(open, _p.exitReserveFloorBps, BPS * TO_WAD, Math.Rounding.Ceil);
        return f > _p.minExitReserveUsdg ? f : _p.minExitReserveUsdg;
    }

    /// @inheritdoc IODGovernor
    function freeCash() external view returns (uint256) {
        return _b.cash;
    }

    /// @inheritdoc IODGovernor
    function backerLock(bytes32 gearId) external view returns (uint256) {
        return _b.lock[gearId];
    }

    /// @inheritdoc IODGovernor
    function backerLockOf(address owner) external view returns (uint256) {
        return _b.ownerLocked[owner];
    }

    /// @inheritdoc IODGovernor
    function backerOwnDebt(bytes32 gearId) external view returns (uint256) {
        return _b.own[gearId];
    }

    /// @inheritdoc IODGovernor
    /// @dev True when any market with a live hedge (delta or equity not zero) has a post older than hedgeMaxAge, or
    /// more than TRANSIT_DUST of USDG sent to the hedger has gone unabsorbed by any post for longer than that (L-2:
    /// transit ages; L-8: a residue up to the dust floor does not).
    function hedgeStale() public view returns (bool) {
        uint256 maxAge = _p.hedgeMaxAge;
        uint256 at = _transitAt;
        if (at != 0 && block.timestamp > at + maxAge) return true;
        for (uint256 i; i < _hedged.length; ++i) {
            Hedge storage h = _hedge[_hedged[i]];
            if ((h.deltaWad != 0 || h.equityUsdg != 0) && block.timestamp > uint256(h.asOf) + maxAge) return true;
        }
        return false;
    }

    /// @inheritdoc IODGovernor
    function buysPaused() external view returns (bool, bytes32) {
        bytes32 r = _pauseReason(_eqSharePrice);
        return (r != 0, r);
    }

    /// @inheritdoc IODGovernor
    function feeOwed() external view returns (uint256) {
        return uint256(_owedToll) + _owedSpread;
    }

    /// @inheritdoc IODGovernor
    function getParams() external view returns (Params memory) {
        return _p;
    }

    /// @inheritdoc IODGovernor
    function hedgeMaxAge() external view returns (uint32) {
        return _p.hedgeMaxAge;
    }

    /// @inheritdoc IODGovernor
    function maxHedgeJumpBps() external view returns (uint16) {
        return _p.maxHedgeJumpBps;
    }

    /// @inheritdoc IODGovernor
    function hedgeJumpRange(bytes32 market) external view returns (uint256 lo, uint256 hi) {
        return ODGovernorRisk.jumpRange(_jump, _p, _hedge[market].equityUsdg, _transit, _jumpEq());
    }

    /// @inheritdoc IODGovernor
    function marketShockBps(bytes32 market) public view returns (uint16) {
        uint8 g = _group[market];
        return g == 0 ? _p.shockStockBps : g == 1 ? _p.shockEtfBps : _p.shockCryptoBps;
    }

    /// @inheritdoc IODGovernor
    function hedgeOf(bytes32 market) external view returns (int256, uint256, uint64) {
        Hedge storage h = _hedge[market];
        return (h.deltaWad, h.equityUsdg, h.asOf);
    }

    /// @inheritdoc IODGovernor
    function hedgeEquity() external view returns (uint256, int256) {
        return (_hedgePosted, _transit);
    }

    /// @inheritdoc IODGovernor
    function cachedEquity() external view returns (int256, uint64, uint256) {
        return (_eqWad, _eqAt, _eqSharePrice);
    }

    /// @inheritdoc IODGovernor
    function ticketOf(uint256 ticket) external view returns (address, uint256, uint64) {
        Ticket storage t = _tickets[ticket];
        return (t.owner, t.shares, t.claimableAt);
    }

    /// @notice Returns whether the contract supports an interface (ERC-165).
    /// @param id Identifier.
    /// @return  True when supported.
    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == type(IODGovernor).interfaceId || super.supportsInterface(id);
    }

    // ================================================================================= internals

    function _ctx() private view returns (ODGovernorRisk.Ctx memory) {
        return ODGovernorRisk.Ctx({registry: registry, guard: guard, minter: minter});
    }

    /// Buy gate shared by onBuy (which then stores the touched market's stress) and buyBlock (QUOTE-1).
    function _check(bytes32 gearId, uint256 addTokens)
        private
        view
        returns (bytes32, uint256, uint256, bytes32 market, uint256 loss)
    {
        bytes32 r = _pauseReason(_eqSharePrice);
        if (r != 0) return (r, 0, 0, 0, 0);
        ODGovernorRisk.Ctx memory c = _ctx();
        (uint256 open, uint256 staticCap,) = ODGovernorRisk.gearOpen(c, _debt, gearId, addTokens);
        uint256 cap = _cap(staticCap);
        if (open > cap) return ("CAP", open, cap, 0, 0);
        market = registry.gear(gearId).marketA;
        loss = _marketLoss(c, market, gearId, addTokens);
        uint256 total = _totalStress - _stress[market].lossWad + loss;
        uint256 budget = _budget(_eqWad);
        if (total > budget) return ("STRESS", total, budget, 0, 0);
        return (0, 0, 0, market, loss);
    }

    function _pauseReason(uint256 sharePrice) private view returns (bytes32) {
        if (_paused) return "PAUSED";
        if (_eqAt == 0 || block.timestamp > uint256(_eqAt) + _p.equityMaxAge) return "EQUITY_STALE";
        if (hedgeStale()) return "HEDGE_STALE";
        if (_tripped(_peak(), sharePrice)) return "DRAWDOWN";
        return 0;
    }

    function _marketLoss(ODGovernorRisk.Ctx memory c, bytes32 market, bytes32 addId, uint256 addTokens)
        private
        view
        returns (uint256)
    {
        Hedge storage h = _hedge[market];
        bool fresh = h.asOf != 0 && block.timestamp <= uint256(h.asOf) + _p.hedgeMaxAge;
        ODGovernorRisk.Shock memory sh = ODGovernorRisk.Shock({
            sWad: int256(uint256(marketShockBps(market))) * 1e14,
            pairWad: int256(uint256(_p.shockPairBps)) * 1e14,
            hedgeDeltaWad: fresh ? h.deltaWad : int256(0)
        });
        return ODGovernorRisk.marketLoss(c, _debt, market, sh, addId, addTokens);
    }

    function _storeStress(bytes32 market, uint256 loss) private {
        if (loss > type(uint192).max) loss = type(uint192).max;
        _totalStress = _totalStress - _stress[market].lossWad + loss;
        _stress[market] = Stress({lossWad: uint192(loss), at: uint64(block.timestamp)});
    }

    function _budget(int256 e) private view returns (uint256) {
        return e > 0 ? Math.mulDiv(uint256(e), _p.stressBudgetBps, BPS) : 0;
    }

    function _cap(uint256 staticCap) private view returns (uint256) {
        uint256 eqCap = _eqWad > 0 ? Math.mulDiv(uint256(_eqWad), _p.capScaleBps, BPS) : 0;
        return staticCap < eqCap ? staticCap : eqCap;
    }

    /// Most a claim can take and leave stress <= budget: equity - stress / stressBudgetBps (USDG).
    function _claimRoom(int256 eqWad) private view returns (uint256) {
        uint256 need = Math.mulDiv(_totalStress, BPS, _p.stressBudgetBps, Math.Rounding.Ceil);
        if (eqWad <= 0 || uint256(eqWad) <= need) return 0;
        return (uint256(eqWad) - need) / TO_WAD;
    }

    /// L-5: the jump window anchors on cached equity less hedge equity, so posts cannot raise their own next window.
    function _jumpEq() private view returns (int256) {
        return _eqWad - int256(_hedgeTotal() * TO_WAD);
    }

    /// L-2: the age of unabsorbed transit starts when it rises above the dust floor and clears when it falls to it
    /// (L-8), so a residue never stales a fresh hedge and a later send ages from its own time.
    function _setTransit(int256 t) private {
        if (t <= TRANSIT_DUST) _transitAt = 0;
        else if (_transit <= TRANSIT_DUST) _transitAt = uint64(block.timestamp);
        _transit = t;
    }

    function _hedgeTotal() private view returns (uint256) {
        int256 t = int256(_hedgePosted) + _transit;
        return t > 0 ? uint256(t) : 0;
    }

    function _assetsWad(bool withHedge) private view returns (int256) {
        uint256 a = _b.cash + _b.reserve + _b.locked + (withHedge ? _hedgeTotal() : 0);
        return int256(a * TO_WAD) - int256((uint256(_owedToll) + _owedSpread) * TO_WAD);
    }

    function _equityWad(int256 liability) private view returns (int256) {
        return _assetsWad(true) - liability;
    }

    /// Low edge: the larger liability per gear, and hedge equity counted only while no hedge post is stale.
    function _equityLow(ODGovernorRisk.Book memory b) private view returns (int256) {
        return _assetsWad(!hedgeStale()) - b.worse;
    }

    function _equityHigh(ODGovernorRisk.Book memory b) private view returns (int256) {
        return _assetsWad(true) - b.better;
    }

    /// shares = assets x (supply + 1e6) / (NAV_high + 1), rounded down.
    function _shares(uint256 assets, int256 highWad, uint256 supply) private pure returns (uint256) {
        uint256 nav = highWad > 0 ? Math.ceilDiv(uint256(highWad), TO_WAD) : 0;
        return Math.mulDiv(assets, supply + 10 ** _decimalsOffset(), nav + 1);
    }

    /// Caches equity, its share price (OZ convertToAssets formula at that equity) and samples the drawdown ring.
    function _refresh(int256 e) private {
        uint256 supply = totalSupply();
        uint256 ta = e > 0 ? uint256(e) / TO_WAD : 0;
        uint256 sp = Math.mulDiv(10 ** decimals(), ta + 1, supply + 10 ** _decimalsOffset()) * TO_WAD;
        _eqWad = e;
        _eqAt = uint64(block.timestamp);
        _eqSharePrice = sp;
        if (supply == 0 || sp > type(uint224).max) return;
        uint256 day = block.timestamp / 1 days + 1;
        uint256 slot = day % RING;
        uint256 w = _ring[slot];
        if (w >> 224 != day || uint224(w) < sp) _ring[slot] = (day << 224) | sp;
    }

    /// Highest sampled share price over the last 30 days (0 when none).
    function _peak() private view returns (uint256 peak) {
        uint256 day = block.timestamp / 1 days + 1;
        for (uint256 i; i < RING; ++i) {
            uint256 x = _ring[i];
            uint256 d = x >> 224;
            if (d != 0 && day - d < DD_DAYS && uint224(x) > peak) peak = uint224(x);
        }
    }

    function _tripped(uint256 peak, uint256 nowWad) private view returns (bool) {
        return peak > nowWad && (peak - nowWad) * BPS > peak * _p.drawdownBps;
    }

    function _received(uint256 usdg) private view {
        uint256 need = _b.cash + _b.reserve + _b.locked + usdg;
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        if (bal < need) revert UsdgNotReceived(need, bal);
    }

    function _oweSpread(uint256 spreadUsdg) private {
        if (spreadUsdg == 0) return;
        uint256 bps = 1000;
        try fees.protocolSpreadShareBps() returns (uint16 b) {
            if (b <= BPS) bps = b;
        } catch {}
        uint256 fee = spreadUsdg * bps / BPS;
        if (fee == 0) return;
        _owedSpread += uint128(fee);
        emit FeeOwed("SPREAD", fee, _owedSpread);
    }

    /// Pays owed fees from free cash, toll first. Never reverts: a failed transfer leaves the fee owed.
    function _settleFees() private {
        _settleOne("TOLL");
        _settleOne("SPREAD");
    }

    function _settleOne(bytes32 kind) private {
        bool toll = kind == "TOLL";
        uint256 owed = toll ? _owedToll : _owedSpread;
        uint256 amt = owed < _b.cash ? owed : _b.cash;
        if (amt == 0) return;
        if (!IERC20(asset()).trySafeTransfer(address(fees), amt)) return;
        _b.cash -= amt;
        if (toll) _owedToll = uint128(owed - amt);
        else _owedSpread = uint128(owed - amt);
        try fees.notify(kind, bytes32(0), amt) {} catch {}
        emit FeePaid(kind, amt);
    }

    function _net(bytes32 gearId) private view returns (int256) {
        return int256(IERC20(registry.gear(gearId).token).totalSupply()) - int256(_debt[gearId]);
    }

    /// Lowers the gear's backer debt by `tokens`; releases the lock share of `ownTokens` and that of `owner`'s meter.
    function _repay(bytes32 gearId, uint256 tokens, uint256 ownTokens, address owner) private {
        ODGovernorRisk.repay(_b, _debt, gearId, tokens, ownTokens, owner);
    }

    function _emitBook(bytes32 gearId) private {
        uint256 d = _debt[gearId];
        emit BookUpdated(gearId, int256(IERC20(registry.gear(gearId).token).totalSupply()) - int256(d), d);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// Shares reach this contract only through requestWithdraw.
    function _update(address from, address to, uint256 value) internal override {
        if (to == address(this) && from != address(0) && !_escrowing) revert UseWithdrawalQueue();
        super._update(from, to, value);
    }
}

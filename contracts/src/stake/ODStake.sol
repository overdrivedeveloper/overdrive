// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {IODStake} from "../interfaces/IODStake.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";
import {IODPriceSource, IODSwapAdapter} from "../fees/IODSwapRoute.sol";

/// @title ODStake
/// @notice Staked $OVRD: slashable first-loss capital behind the Governor (after insurance, before Governor equity),
/// spread-discount tiers for traders, the recipient of ODFees' stakers bucket, and vote weight for markets and caps.
/// The vote is off-chain and the timelock enacts it; no contract reads `votingPower` to change toll maths, the
/// normalisation factor or pricing.
/// @dev Rules (todo 09):
///  - $OVRD is issued by a launchpad, never here. Its address is a constructor parameter.
///  - Stakes are shares of one tracked $OVRD balance (`totalAssets`, never balanceOf, so a donation cannot move the
///    share price), 1:1 until a slash. A slash lowers `totalAssets`, so active stakes and stakes waiting out the
///    unstake delay lose the same fraction.
///  - Unstake: `requestUnstake`, wait UNSTAKE_DELAY, `unstake`; or `cancelUnstake`. These and `claimRewards` are never
///    paused; only new stakes can be paused (guardian pauses, timelock unpauses).
///  - `slash` is callable by the Governor and the Backer only. It sells staked $OVRD through the set route with the
///    output floored at the TWAP less slippage, capped by the stake, and sends the USDG to the caller. A missing or
///    failing route returns 0 and emits `SlashFailed`; it never reverts for that.
///  - `notifyRewards` (ODFees only) pulls USDG and streams it over REWARD_PERIOD to active shares, per second staked.
///  - Vote weight counts only stake older than VOTE_WARMUP: stake added up to `t - VOTE_WARMUP` less everything moved
///    out up to `t` (removals are charged to the oldest stake first, which can only undercount).
contract ODStake is AccessControl, ReentrancyGuardTransient, IODStake {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;

    uint256 private constant BPS = 10_000;
    uint256 private constant ACC = 1e36;
    uint256 private constant RATE = 1e18;
    uint256 private constant PRICE_TO_USDG = 1e30;

    uint32 public constant UNSTAKE_DELAY = 7 days;
    uint32 public constant VOTE_WARMUP = 7 days;
    uint32 public constant REWARD_PERIOD = 7 days;
    uint16 public constant MAX_SPREAD_DISCOUNT_BPS = 2_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    uint256 public constant MAX_TIERS = 4;
    /// @notice A slash always leaves at least totalShares / this token wei, so the share price never reaches zero.
    uint256 public constant MAX_SHARES_PER_ASSET = 1e12;
    uint256 public constant SPOT_BAND_BPS = 50;
    bytes32 public constant FEES_ROLE = keccak256("FEES_ROLE");

    struct Tier {
        uint128 minStake;
        uint16 spreadDiscountBps;
    }

    struct Request {
        uint256 shares;
        uint64 readyAt;
    }

    IERC20 public immutable ovrd;
    IERC20 public immutable usdg;
    address public immutable governor;
    address public immutable backer;

    IODPriceSource public priceSource;
    IODSwapAdapter public swapAdapter;
    uint24 public poolFee;
    uint16 public slippageBps = 300;
    /// @notice Most cover (USDG 6 dp) the stake reports, set from the measured depth of the $OVRD/USDG pool.
    uint256 public coverCapUsdg;
    bool public depositsPaused;

    uint256 public totalShares;
    uint256 public totalAssets;
    uint256 public activeShares;
    mapping(address account => uint256 shares) public sharesOf;
    mapping(address account => Request) public requests;

    uint256 public rewardPerShare;
    uint256 public rewardRate;
    uint64 public periodFinish;
    uint64 public lastUpdate;
    /// @notice Streamed while nobody was staked; restreamed with the next notify.
    uint256 public unassigned;
    mapping(address account => uint256) public rewardPerSharePaid;
    mapping(address account => uint256) public owed;

    mapping(address account => Checkpoints.Trace208) private _votesIn;
    mapping(address account => Checkpoints.Trace208) private _votesOut;

    Tier[] private _tiers;

    event UnstakeCancelled(address indexed account, uint256 shares);
    event RewardsNotified(uint256 usdg, uint256 rewardRate, uint64 periodFinish);
    event SlashRouteSet(address priceSource, address swapAdapter, uint24 fee, uint16 slippageBps);
    event CoverCapSet(uint256 capUsdg);
    event TiersSet(uint256 count);
    event DepositsPausedSet(bool paused);

    error InvalidParams();
    error NothingToUnstake();
    error DepositsPaused();
    error FutureLookup(uint256 timepoint);

    constructor(IERC20 ovrd_, IERC20 usdg_, address admin, address governor_, address backer_) {
        if (
            address(ovrd_) == address(0) || address(usdg_) == address(0) || admin == address(0)
                || governor_ == address(0) || backer_ == address(0) || address(ovrd_) == address(usdg_)
        ) revert InvalidParams();
        if (IERC20Metadata(address(ovrd_)).decimals() != 18) revert InvalidParams();
        ovrd = ovrd_;
        usdg = usdg_;
        governor = governor_;
        backer = backer_;
        lastUpdate = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------------ staking

    function stake(uint256 amount) external override nonReentrant returns (uint256 shares) {
        if (depositsPaused) revert DepositsPaused();
        if (amount == 0) revert InvalidParams();
        _touch(msg.sender);
        uint256 before = ovrd.balanceOf(address(this));
        ovrd.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = ovrd.balanceOf(address(this)) - before;
        shares = Math.mulDiv(received, totalShares + 1, totalAssets + 1);
        if (shares == 0) revert InvalidParams();
        totalShares += shares;
        totalAssets += received;
        sharesOf[msg.sender] += shares;
        activeShares += shares;
        _bump(_votesIn[msg.sender], shares);
        emit Staked(msg.sender, received, shares);
    }

    function requestUnstake(uint256 shares) external override nonReentrant {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert NothingToUnstake();
        _touch(msg.sender);
        sharesOf[msg.sender] -= shares;
        activeShares -= shares;
        _bump(_votesOut[msg.sender], shares);
        Request storage q = requests[msg.sender];
        q.shares += shares;
        q.readyAt = uint64(block.timestamp + UNSTAKE_DELAY);
        emit UnstakeRequested(msg.sender, shares, q.readyAt);
    }

    function cancelUnstake() external nonReentrant {
        Request memory q = requests[msg.sender];
        if (q.shares == 0) revert NothingToUnstake();
        _touch(msg.sender);
        delete requests[msg.sender];
        sharesOf[msg.sender] += q.shares;
        activeShares += q.shares;
        _bump(_votesIn[msg.sender], q.shares);
        emit UnstakeCancelled(msg.sender, q.shares);
    }

    /// @notice Pays out a matured request at the current (post-slash) share value.
    function unstake() external override nonReentrant returns (uint256 amount) {
        Request memory q = requests[msg.sender];
        if (q.shares == 0) revert NothingToUnstake();
        if (block.timestamp < q.readyAt) revert NotReady(q.readyAt);
        amount = assetsOf(q.shares);
        delete requests[msg.sender];
        totalShares -= q.shares;
        totalAssets -= amount;
        ovrd.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, q.shares, amount);
    }

    function claimRewards() external override nonReentrant returns (uint256 paid) {
        _touch(msg.sender);
        paid = owed[msg.sender];
        if (paid == 0) return 0;
        owed[msg.sender] = 0;
        usdg.safeTransfer(msg.sender, paid);
        emit RewardsClaimed(msg.sender, paid);
    }

    /// @notice ODFees only: pulls `amount` USDG and streams it (plus anything unassigned) over REWARD_PERIOD.
    function notifyRewards(uint256 amount) external nonReentrant onlyRole(FEES_ROLE) {
        _accrue();
        if (amount != 0) usdg.safeTransferFrom(msg.sender, address(this), amount);
        uint256 remaining = periodFinish > block.timestamp ? (periodFinish - block.timestamp) * rewardRate : 0;
        uint256 fresh = amount + unassigned;
        unassigned = 0;
        rewardRate = (fresh * RATE + remaining) / REWARD_PERIOD;
        periodFinish = uint64(block.timestamp + REWARD_PERIOD);
        emit RewardsNotified(amount, rewardRate, periodFinish);
    }

    // ------------------------------------------------------------------------------------------------ first loss

    /// @inheritdoc IODStake
    function slash(uint256 usdgNeeded) external override nonReentrant returns (uint256 usdgSent) {
        if (msg.sender != governor && msg.sender != backer) revert NotSlasher();
        uint256 price = _price();
        IODSwapAdapter adapter = swapAdapter;
        uint256 slashable = _slashable();
        if (usdgNeeded == 0 || slashable == 0) return 0;
        if (price == 0 || address(adapter) == address(0)) {
            emit SlashFailed(usdgNeeded);
            return 0;
        }
        uint256 floorBps = BPS - slippageBps;
        uint256 amount = Math.mulDiv(usdgNeeded, PRICE_TO_USDG * BPS, price * floorBps, Math.Rounding.Ceil);
        if (amount > slashable) amount = slashable;
        uint256 minOut = Math.mulDiv(amount, price * floorBps, PRICE_TO_USDG * BPS);
        if (minOut == 0 || !_spotNearTwap(price)) {
            emit SlashFailed(usdgNeeded);
            return 0;
        }
        uint256 tokBefore = ovrd.balanceOf(address(this));
        uint256 outBefore = usdg.balanceOf(msg.sender);
        ovrd.forceApprove(address(adapter), amount);
        try adapter.swapExactIn(address(ovrd), address(usdg), poolFee, amount, minOut, msg.sender) {
            uint256 tokAfter = ovrd.balanceOf(address(this));
            uint256 sold = tokBefore > tokAfter ? tokBefore - tokAfter : 0;
            if (sold > slashable) sold = slashable;
            totalAssets -= sold;
            uint256 outAfter = usdg.balanceOf(msg.sender);
            usdgSent = outAfter > outBefore ? outAfter - outBefore : 0;
            emit Slashed(usdgNeeded, sold, usdgSent);
        } catch {
            emit SlashFailed(usdgNeeded);
        }
        ovrd.forceApprove(address(adapter), 0);
    }

    /// @inheritdoc IODStake
    function coverValueUsdg() external view override returns (uint256 cover) {
        if (address(swapAdapter) == address(0)) return 0;
        uint256 price = _price();
        if (price == 0) return 0;
        cover = Math.mulDiv(_slashable(), price * (BPS - slippageBps), PRICE_TO_USDG * BPS);
        if (cover > coverCapUsdg) cover = coverCapUsdg;
    }

    // ------------------------------------------------------------------------------------------------ tiers and votes

    /// @inheritdoc IODStake
    /// @dev Bounded loop over at most MAX_TIERS entries; cannot revert for any account.
    function feeDiscountOf(address account) external view override returns (uint16 spreadDiscountBps) {
        uint256 n = _tiers.length;
        if (n == 0) return 0;
        uint256 amount = assetsOf(sharesOf[account]);
        for (uint256 i = n; i > 0; --i) {
            Tier memory t = _tiers[i - 1];
            if (amount >= t.minStake) return t.spreadDiscountBps;
        }
    }

    /// @inheritdoc IODStake
    function votingPower(address account, uint256 timepoint) external view override returns (uint256) {
        if (timepoint > block.timestamp) revert FutureLookup(timepoint);
        if (timepoint < VOTE_WARMUP) return 0;
        uint256 inOld = _votesIn[account].upperLookupRecent(SafeCast.toUint48(timepoint - VOTE_WARMUP));
        uint256 outNow = _votesOut[account].upperLookupRecent(SafeCast.toUint48(timepoint));
        return inOld > outNow ? inOld - outNow : 0;
    }

    function tiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    // ------------------------------------------------------------------------------------------------ views

    function assetsOf(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, totalAssets + 1, totalShares + 1);
    }

    function stakeOf(address account) external view returns (uint256) {
        return assetsOf(sharesOf[account]);
    }

    function earned(address account) external view returns (uint256) {
        uint256 rps = rewardPerShare;
        uint256 t = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        if (t > lastUpdate && activeShares != 0) {
            rps += Math.mulDiv(rewardRate * (t - lastUpdate), ACC / RATE, activeShares);
        }
        return owed[account] + Math.mulDiv(sharesOf[account], rps - rewardPerSharePaid[account], ACC);
    }

    // ------------------------------------------------------------------------------------------------ admin (timelock)

    /// @notice A zero price source or adapter turns the first-loss sale off (`slash` returns 0, cover reads 0).
    function setSlashRoute(address source, address adapter, uint24 fee, uint16 slippage)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (slippage > MAX_SLIPPAGE_BPS) revert InvalidParams();
        if (source != address(0) && source.code.length == 0) revert InvalidParams();
        if (adapter != address(0) && (adapter.code.length == 0 || fee == 0)) revert InvalidParams();
        priceSource = IODPriceSource(source);
        swapAdapter = IODSwapAdapter(adapter);
        poolFee = fee;
        slippageBps = slippage;
        emit SlashRouteSet(source, adapter, fee, slippage);
    }

    function setCoverCap(uint256 capUsdg) external onlyRole(DEFAULT_ADMIN_ROLE) {
        coverCapUsdg = capUsdg;
        emit CoverCapSet(capUsdg);
    }

    /// @notice Ascending `minStake`, at most MAX_TIERS, discount at most MAX_SPREAD_DISCOUNT_BPS of the spread.
    function setTiers(Tier[] calldata t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (t.length > MAX_TIERS) revert InvalidParams();
        delete _tiers;
        for (uint256 i; i < t.length; ++i) {
            if (t[i].minStake == 0 || (i != 0 && t[i].minStake <= t[i - 1].minStake)) revert InvalidParams();
            if (t[i].spreadDiscountBps > MAX_SPREAD_DISCOUNT_BPS) revert InvalidParams();
            _tiers.push(t[i]);
        }
        emit TiersSet(t.length);
    }

    /// @notice The guardian (or admin) pauses new stakes; only the admin (timelock) unpauses.
    function setDepositsPaused(bool paused) external {
        if (paused) {
            if (!hasRole(ODRoles.GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
                revert AccessControlUnauthorizedAccount(msg.sender, ODRoles.GUARDIAN_ROLE);
            }
        } else {
            _checkRole(DEFAULT_ADMIN_ROLE);
        }
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    // ------------------------------------------------------------------------------------------------ internals

    function _bump(Checkpoints.Trace208 storage trace, uint256 shares) private {
        trace.push(SafeCast.toUint48(block.timestamp), SafeCast.toUint208(uint256(trace.latest()) + shares));
    }

    function _touch(address account) private {
        _accrue();
        uint256 rps = rewardPerShare;
        owed[account] += Math.mulDiv(sharesOf[account], rps - rewardPerSharePaid[account], ACC);
        rewardPerSharePaid[account] = rps;
    }

    function _accrue() private {
        uint256 t = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        uint256 last = lastUpdate;
        if (t > last) {
            uint256 streamed = rewardRate * (t - last);
            if (activeShares == 0) unassigned += streamed / RATE;
            else rewardPerShare += Math.mulDiv(streamed, ACC / RATE, activeShares);
        }
        lastUpdate = uint64(block.timestamp);
    }

    function _slashable() private view returns (uint256) {
        uint256 keep = Math.ceilDiv(totalShares, MAX_SHARES_PER_ASSET);
        return totalAssets > keep ? totalAssets - keep : 0;
    }

    function _spotNearTwap(uint256 twap) private view returns (bool) {
        uint256 spot = _read(abi.encodeCall(IODPriceSource.spotPrice, (address(ovrd), poolFee)));
        if (spot == 0) return false;
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        return diff * BPS <= twap * SPOT_BAND_BPS;
    }

    function _price() private view returns (uint256) {
        IODPriceSource src = priceSource;
        if (address(src) == address(0)) return 0;
        return _read(abi.encodeCall(IODPriceSource.referencePrice, (address(ovrd), poolFee)));
    }

    /// @dev Static call to the price source; a revert, short return or missing source reads as 0 (fail closed).
    function _read(bytes memory data) private view returns (uint256 v) {
        address src = address(priceSource);
        if (src.code.length == 0) return 0;
        (bool ok, bytes memory ret) = src.staticcall(data);
        if (!ok || ret.length < 32) return 0;
        v = abi.decode(ret, (uint256));
    }
}

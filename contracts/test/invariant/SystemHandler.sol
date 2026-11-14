// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockPyth} from "../mocks/MockPyth.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockKindCalendar} from "../mocks/OracleMocks.sol";
import {HookRouter} from "../hook/HookFixture.sol";
import {ODBackerHarness} from "../backer/BackerFixture.sol";
import {ODOracleGuard} from "overdrive/oracle/ODOracleGuard.sol";
import {ODVolOracle} from "overdrive/oracle/ODVolOracle.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODVolOracle, VolPost} from "overdrive/interfaces/IODVolOracle.sol";
import {Gear, GearConfig, NormState, PriceReading, Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {ActorSet, ActorLib} from "./ActorSet.sol";
import {Ghosts} from "./Ghosts.sol";

/// Everything the handler drives: the real protocol from SystemFixture (+ real ODBacker, local v4 PoolManager and
/// ODHook, and a real 48 h TimelockController holding the admin role). Only feeds, Pyth, the calendar, Stock Tokens
/// and USDG are mocks.
struct SystemRefs {
    MockUSDG usdg;
    MockKindCalendar cal;
    MockPyth pyth;
    ODOracleGuard guard;
    ODVolOracle vol;
    ODGearRegistry reg;
    ODGovernor gov;
    ODMinter minter;
    ODFees fees;
    ODBackerHarness backer;
    ODHook hook;
    HookRouter router;
    TimelockController timelock;
    address pm;
    address lp;
    uint256 volKey;
}

/// One multi-contract handler over the whole system (todo 12). Every action is bounded, never reverts itself, and
/// records what it did in the ghosts. The per-area handlers (BackerInvariant, LiquidationInvariant, GovernorInvariant,
/// StakeInvariant) keep their own focused properties; this one checks the cross-contract ones.
contract SystemHandler is Test, Ghosts {
    using ActorLib for ActorSet;

    uint256 internal constant N_MARKETS = 3; // TSLA, NVDA, ETH
    bytes32 internal constant UNPAUSE_SALT = "od-unpause";

    SystemRefs internal s;
    ActorSet internal a;
    bytes32[3] internal markets;
    bytes32 internal pairVolKey;
    bytes32[] internal gearIds;
    address[] internal tokens; // gear token per gearIds entry (cached: the registry returns a large struct)
    bool[] internal isEco;
    MockAggregator[3] internal feeds;
    MockStockToken[3] internal stocks; // address(0) for ETH
    uint256[3] public priceOf; // WAD
    bool[3] public haltedOf;
    mapping(bytes32 key => uint64) internal sigmaOf;
    mapping(bytes32 key => uint64) internal nonceOf;
    mapping(bytes32 key => uint256) internal postedAt;

    uint256[] internal tickets; // minter queue tickets opened by holders
    uint256[] internal vaultIds;
    uint256[] internal lpTickets;
    mapping(uint256 which => uint256) internal unpauseRound;
    mapping(uint256 which => bool) internal pausedOf;

    // per-call snapshots
    uint256 internal _resBefore;
    uint256 internal _feePendingBefore;
    uint256 internal _feeHeldBefore;
    uint256 internal _feeBalBefore;
    uint256 internal _feeOwedBefore;
    mapping(bytes32 gear => uint256) public lastNf;
    mapping(bytes32 gear => uint256) public lastCum;

    constructor(
        SystemRefs memory refs,
        ActorSet memory actors,
        bytes32[3] memory markets_,
        bytes32[] memory gearIds_,
        MockAggregator[3] memory feeds_,
        MockStockToken[3] memory stocks_,
        uint64[4] memory sigmas
    ) {
        s = refs;
        a = actors;
        markets = markets_;
        gearIds = gearIds_;
        feeds = feeds_;
        stocks = stocks_;
        pairVolKey = refs.vol.pairKey(markets_[0], markets_[1]);
        for (uint256 i; i < N_MARKETS; ++i) {
            (, int256 ans,,,) = feeds_[i].latestRoundData();
            priceOf[i] = uint256(ans) * 1e10;
            sigmaOf[markets_[i]] = sigmas[i];
            nonceOf[markets_[i]] = refs.vol.lastNonce(markets_[i]);
            postedAt[markets_[i]] = block.timestamp;
        }
        sigmaOf[pairVolKey] = sigmas[3];
        nonceOf[pairVolKey] = refs.vol.lastNonce(pairVolKey);
        postedAt[pairVolKey] = block.timestamp;
        for (uint256 i; i < gearIds_.length; ++i) {
            GearConfig memory c = refs.reg.gear(gearIds_[i]);
            tokens.push(c.token);
            isEco.push(c.gear == Gear.ECO);
            NormState memory n = refs.minter.normState(gearIds_[i]);
            lastNf[gearIds_[i]] = n.nf;
            lastCum[gearIds_[i]] = n.cumTollPerTokenWad;
        }
        feesNotified = refs.fees.pending() + refs.fees.totalHeld();
    }

    // ============================================================================================ step wrapper

    modifier step(bytes32 name) {
        _snap();
        _;
        _check(name);
    }

    function _snap() internal {
        _resBefore = s.gov.exitReserve();
        _feePendingBefore = s.fees.pending();
        _feeHeldBefore = s.fees.totalHeld();
        _feeBalBefore = s.usdg.balanceOf(address(s.fees));
        _feeOwedBefore = s.gov.feeOwed();
        _holderPaidThisCall = 0;
    }

    /// R7 (NF direction, bounds, cumulative toll), R8 (reserve falls only inside a holder payout) and R12 (fee
    /// intake and payout), all against the state before this call.
    function _check(bytes32 name) internal {
        for (uint256 i; i < gearIds.length; ++i) {
            bytes32 g = gearIds[i];
            NormState memory n = s.minter.normState(g);
            // normState is a projection to now (gap rate = worse of stored and current, so it moves with price inside
            // an interval); it equals the stored state only in the second of a commit. Committed NF and cumulative
            // toll must be monotone; any projection must sit on the right side of the last commit.
            bool wrongWay = isEco[i] ? n.nf < lastNf[g] : n.nf > lastNf[g];
            if (wrongWay || n.nf < 1e9 || n.nf > 1e24 || n.cumTollPerTokenWad < lastCum[g]) {
                ++nfViolations;
                lastNfViolation = name;
            }
            if (n.lastAccrual == block.timestamp) {
                lastNf[g] = n.nf;
                lastCum[g] = n.cumTollPerTokenWad;
            }
        }
        uint256 resNow = s.gov.exitReserve();
        if (resNow < _resBefore) {
            uint256 drawn = _resBefore - resNow;
            reserveDrawn += drawn;
            if (drawn <= _holderPaidThisCall) reservePaidToHolders += drawn;
            else ++reserveViolations;
        }
        uint256 pend = s.fees.pending();
        uint256 held = s.fees.totalHeld();
        uint256 bal = s.usdg.balanceOf(address(s.fees));
        if (name == "distributeFees") {
            // F12-1 (fixed in fix round 3): distribute pays the Governor bucket through fundCash, which settles the
            // Governor's owed fees back into ODFees and notifies them (pending += x). Books must move by exactly
            // (x notified - measured outflow); feeDoubleBooked records any growth beyond that, and R5/R12 are strict.
            uint256 owedNow = s.gov.feeOwed();
            uint256 x = _feeOwedBefore > owedNow ? _feeOwedBefore - owedNow : 0; // fees paid in during the call
            int256 overBefore = int256(_feePendingBefore + _feeHeldBefore) - int256(_feeBalBefore);
            int256 delta = int256(pend + held) - int256(bal) - overBefore; // books growth beyond the balance
            if (bal > _feeBalBefore + x || delta < 0 || uint256(delta) > x) {
                ++feeViolations;
            } else {
                feesNotified += x;
                feesPaidOut += _feeBalBefore + x - bal; // USDG that actually left ODFees
                feeDoubleBooked += uint256(delta);
            }
        } else {
            if (pend < _feePendingBefore || held != _feeHeldBefore) ++feeViolations;
            else feesNotified += pend - _feePendingBefore;
        }
        _count(name, true);
    }

    // ============================================================================================ helpers

    function _gear(uint256 idx) internal view returns (bytes32) {
        return gearIds[idx % gearIds.length];
    }

    /// A (holder, gear) pair starting at the fuzzed one that actually holds tokens, so sells are not mostly no-ops.
    function _held(uint256 actor, uint256 gearIdx) internal view returns (address who, bytes32 g, uint256 bal) {
        uint256 n = gearIds.length;
        for (uint256 k; k < 5 * n; ++k) {
            who = a.holder(actor % 5 + k / n);
            g = _gear(gearIdx % n + k);
            bal = _tok(g).balanceOf(who);
            if (bal != 0) return (who, g, bal);
        }
        return (address(0), bytes32(0), 0);
    }

    function _tok(bytes32 g) internal view returns (IERC20) {
        return IERC20(s.reg.gear(g).token);
    }

    function _reading(bytes32 g) internal view returns (PriceReading memory) {
        GearConfig memory c = s.reg.gear(g);
        return c.marketB == bytes32(0) ? s.guard.read(c.marketA) : s.guard.readRatio(c.marketA, c.marketB);
    }

    function _now64() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    function _quote(address who, bytes32 g, bool isBuy, bool exactIn, uint256 amount)
        internal
        returns (bool ok, Quote memory q)
    {
        vm.prank(who);
        try s.minter.quote(g, isBuy, exactIn, amount) returns (Quote memory r) {
            (ok, q) = (true, r);
        } catch {}
    }

    function _push(uint256 mi) internal {
        bytes32 m = markets[mi];
        int64 px = int64(int256(priceOf[mi] / 1e10));
        if (!haltedOf[mi]) {
            feeds[mi].push(int256(px));
            s.pyth
                .setPrice(keccak256(abi.encode("pyth", m)), px, uint64(uint256(int256(px)) / 1000), -8, block.timestamp);
        }
        try s.guard.poke(m) {} catch {}
    }

    function _postVol(bytes32 key, uint64 sigmaBps) internal returns (bool ok) {
        VolPost memory p = VolPost({
            market: key,
            sigmaBps: sigmaBps,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(block.timestamp + 2 hours),
            nonce: nonceOf[key] + 1
        });
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(s.volKey, s.vol.hashPost(p));
        try s.vol.post(p, abi.encodePacked(r, ss, v)) {
            ok = true;
            nonceOf[key] = p.nonce;
            sigmaOf[key] = sigmaBps;
            postedAt[key] = block.timestamp;
        } catch {}
    }

    function _repost(bytes32 key) internal {
        if (block.timestamp >= postedAt[key] + s.vol.MIN_POST_INTERVAL()) _postVol(key, sigmaOf[key]);
    }

    function _pokeRisk() internal {
        bytes32[] memory ms = new bytes32[](3);
        (ms[0], ms[1], ms[2]) = (markets[0], markets[1], markets[2]);
        try s.gov.pokeRisk(ms) {} catch {}
    }

    /// Oracles keep publishing (feeds, references, vol posts) unless a market is halted; the keeper pokes risk.
    function _refresh() internal {
        for (uint256 i; i < N_MARKETS; ++i) {
            _push(i);
            _repost(markets[i]);
        }
        _repost(pairVolKey);
        _pokeRisk();
    }

    /// Session of the stock calendar at `t` (UTC, a coarse US schedule): weekends CLOSED; 13:30 to 20:00 OPEN;
    /// 08:00 to 13:30 and 20:00 to 24:00 EXTENDED; otherwise CLOSED. ETH is 24/7 and ignores it.
    function _sessionAt(uint256 t) internal pure returns (Session) {
        uint256 dow = (t / 1 days + 4) % 7; // 0 = Sunday
        if (dow == 0 || dow == 6) return Session.CLOSED;
        uint256 sec = t % 1 days;
        if (sec >= 13.5 hours && sec < 20 hours) return Session.OPEN;
        if (sec >= 8 hours) return Session.EXTENDED;
        return Session.CLOSED;
    }

    function _fund(address who, uint256 amount, address spender) internal {
        s.usdg.mint(who, amount);
        vm.prank(who);
        s.usdg.approve(spender, type(uint256).max);
    }

    // ============================================================================================ holders

    /// Holder buy, direct or through the v4 hook, exact in or exact out. R3: executed amounts equal the quote
    /// taken in the same state (and a refused quote means a refused buy).
    function buy(uint256 actor, uint256 gearIdx, uint256 usdg, bool viaHook, bool exactIn) external step("buy") {
        address who = a.holder(actor);
        bytes32 g = _gear(gearIdx);
        uint256 amount = exactIn ? _bound(usdg, 1e6, 20_000e6) : _bound(usdg, 1e18, 20_000e18);
        (bool qok, Quote memory q) = _quote(who, g, true, exactIn, amount);
        uint256 fund = exactIn ? amount : (qok ? q.amountIn : 50_000e6);
        if (viaHook) {
            _hookTrade(who, g, true, exactIn, amount, qok, q, fund);
            return;
        }
        _fund(who, fund, address(s.minter));
        IERC20 t = _tok(g);
        uint256 b0 = t.balanceOf(who);
        vm.startPrank(who);
        bool ok;
        uint256 res;
        if (exactIn) {
            try s.minter.buy(g, amount, 0, who, _now64()) returns (uint256 out) {
                (ok, res) = (true, out);
            } catch {}
        } else {
            try s.minter.buyExactTokens(g, amount, fund, who, _now64()) returns (uint256 paid) {
                (ok, res) = (true, paid);
            } catch {}
        }
        vm.stopPrank();
        uint256 got = t.balanceOf(who) - b0;
        expectedBal[who][address(t)] += exactIn ? (ok ? res : 0) : (ok ? amount : 0);
        ++quoteChecks;
        if (ok != qok) _mismatch("buy-refusal");
        else if (ok && (exactIn ? res != q.amountOut : res != q.amountIn)) _mismatch("buy-amount");
        else if (ok && got != (exactIn ? res : amount)) _mismatch("buy-delivered");
        if (!ok) ++revertsOf["buy"];
    }

    /// Holder sell, direct or through the hook. R1 (reserve above floor pays), R3 (quote) and R4 (only UseQueue).
    function sell(uint256 actor, uint256 gearIdx, uint256 tokens, bool viaHook, bool exactIn) external step("sell") {
        (address who, bytes32 g, uint256 bal) = _held(actor, gearIdx);
        if (bal == 0) return;
        IERC20 t = _tok(g);
        uint256 amount;
        if (exactIn) {
            amount = _bound(tokens, 1, bal);
        } else {
            (bool vok, Quote memory full) = _quote(who, g, false, true, bal);
            if (!vok || full.amountOut < 2e6) return;
            amount = _bound(tokens, 1e6, full.amountOut / 2);
        }
        (bool qok, Quote memory q) = _quote(who, g, false, exactIn, amount);
        uint256 reserve = s.gov.exitReserve();
        bool aboveFloor = reserve >= s.gov.exitReserveFloor();
        PriceReading memory r = _reading(g);
        uint256 payout = exactIn ? q.amountOut : amount;
        bool r1 = qok && aboveFloor && r.p != 0 && r.refP != 0 && payout != 0 && payout <= reserve
            && s.minter.settledValue(g) == 0;
        // The hook takes the input tokens out of the PoolManager before the swapper settles, so a hook sell needs the
        // PoolManager to physically hold that many gear tokens (other users' ERC-6909 balances; seeded here). A
        // larger sell goes direct instead and is counted: the minter path is the exit that must always work.
        if (viaHook && (exactIn ? amount : q.amountIn) > t.balanceOf(s.pm)) {
            viaHook = false;
            ++hookSellsOverPmBalance;
        }
        if (viaHook) {
            _hookTrade(who, g, false, exactIn, amount, qok, q, 0);
            return;
        }
        uint256 u0 = s.usdg.balanceOf(who);
        uint256 b0 = t.balanceOf(who);
        bool ok;
        uint256 res;
        bytes memory err;
        vm.startPrank(who);
        if (exactIn) {
            try s.minter.sell(g, amount, 0, who, _now64()) returns (uint256 out) {
                (ok, res) = (true, out);
            } catch (bytes memory e) {
                err = e;
            }
        } else {
            try s.minter.sellForExactUsdg(g, amount, bal, who, _now64()) returns (uint256 used) {
                (ok, res) = (true, used);
            } catch (bytes memory e) {
                err = e;
            }
        }
        vm.stopPrank();
        uint256 paidOut = s.usdg.balanceOf(who) - u0;
        uint256 burned = b0 - t.balanceOf(who);
        if (ok) {
            expectedBal[who][address(t)] -= burned;
            _holderPaidThisCall = paidOut;
        } else {
            ++revertsOf["sell"];
            bytes4 sel = _sel(err);
            if (sel == IODMinter.UseQueue.selector) {
                ++sellUseQueue;
                if (r1) ++r1Violations;
            } else if (sel != IODMinter.BelowMinimum.selector) {
                _gated("sell", err);
            }
        }
        if (r1) ++r1Checked;
        if (qok) {
            ++quoteChecks;
            if (ok == q.queued) {
                _mismatch("sell-queued-flag");
            } else if (ok && (exactIn ? res != q.amountOut : res != q.amountIn)) {
                _mismatch("sell-amount");
            } else if (ok && (exactIn ? burned != amount || paidOut != res : burned != res || paidOut != amount)) {
                _mismatch("sell-delivered");
            }
        }
    }

    function queueSell(uint256 actor, uint256 gearIdx, uint256 tokens) external step("queueSell") {
        (address who, bytes32 g, uint256 bal) = _held(actor, gearIdx);
        if (bal == 0) return;
        IERC20 t = _tok(g);
        tokens = _bound(tokens, 1, bal);
        vm.prank(who);
        try s.minter.queueSell(g, tokens, 0, who) returns (uint256 ticket) {
            tickets.push(ticket);
            expectedBal[who][address(t)] -= tokens;
            escrowOf[address(t)] += tokens;
        } catch (bytes memory e) {
            ++revertsOf["queueSell"];
            _gated("queueSell", e);
        }
    }

    function fillQueued(uint256 ticketIdx) external step("fillQueued") {
        if (tickets.length == 0) return;
        uint256 ticket = tickets[ticketIdx % tickets.length];
        (bytes32 g, address owner,, uint256 tokens,) = s.minter.queuedSell(ticket);
        if (tokens == 0) return;
        uint256 u0 = s.usdg.balanceOf(owner);
        vm.prank(a.keeper);
        try s.minter.fillQueued(ticket) {
            escrowOf[address(_tok(g))] -= tokens;
            _holderPaidThisCall = s.usdg.balanceOf(owner) - u0;
        } catch {
            ++revertsOf["fillQueued"];
        }
    }

    function cancelQueued(uint256 actor, uint256 ticketIdx) external step("cancelQueued") {
        if (tickets.length == 0) return;
        uint256 ticket = tickets[ticketIdx % tickets.length];
        (bytes32 g, address owner,, uint256 tokens,) = s.minter.queuedSell(ticket);
        if (tokens == 0) return;
        address who = actor % 4 == 0 ? a.holder(actor >> 8) : owner; // sometimes a non-owner tries
        vm.prank(who);
        try s.minter.cancelQueued(ticket) {
            if (who != owner) _gated("cancel-by-non-owner", ""); // a stranger moved someone's ticket
            address t = address(_tok(g));
            escrowOf[t] -= tokens;
            expectedBal[owner][t] += tokens;
        } catch (bytes memory e) {
            ++revertsOf["cancelQueued"];
            if (who == owner) _gated("cancelQueued", e);
        }
    }

    // ============================================================================================ the v4 hook

    function _swapParams(bytes32 g, bool isBuy, bool exactIn, uint256 amount)
        internal
        view
        returns (PoolKey memory key, IPoolManager.SwapParams memory p)
    {
        key = s.hook.poolKeyOf(g);
        bool usdgIs0 = Currency.unwrap(key.currency0) == address(s.usdg);
        p.zeroForOne = isBuy == usdgIs0;
        p.amountSpecified = exactIn ? -int256(amount) : int256(amount);
        p.sqrtPriceLimitX96 = p.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    /// A trade through the PoolManager and ODHook. R3 twice: the minter quote and the V4Quoter-style quote (simulate,
    /// revert, decode) both equal what the swapper paid and received.
    function _hookTrade(
        address who,
        bytes32 g,
        bool isBuy,
        bool exactIn,
        uint256 amount,
        bool qok,
        Quote memory q,
        uint256 fund
    ) internal {
        IERC20 t = _tok(g);
        IERC20 tin = isBuy ? IERC20(address(s.usdg)) : t;
        IERC20 tout = isBuy ? t : IERC20(address(s.usdg));
        if (isBuy) s.usdg.mint(who, fund);
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _swapParams(g, isBuy, exactIn, amount);
        vm.prank(who);
        tin.approve(address(s.router), type(uint256).max);
        (bool vq, uint256 vIn, uint256 vOut) = _v4Quote(who, key, p, isBuy);
        uint256 in0 = tin.balanceOf(who);
        uint256 out0 = tout.balanceOf(who);
        vm.prank(who);
        bool ok;
        bytes memory err;
        try s.router.swap(key, p) {
            ok = true;
        } catch (bytes memory e) {
            err = e;
        }
        uint256 paid = in0 - tin.balanceOf(who);
        uint256 got = tout.balanceOf(who) - out0;
        if (isBuy) expectedBal[who][address(t)] += got;
        else expectedBal[who][address(t)] -= paid;
        if (!isBuy && ok) _holderPaidThisCall = got;
        bytes32 name = isBuy ? bytes32("buy") : bytes32("sell");
        if (!ok) ++revertsOf[name];
        if (!ok && !isBuy && qok && !q.queued) _gated("sell-hook", err); // the minter would pay, the hook refused
        if (!ok && !isBuy && qok && q.queued) ++sellUseQueue;
        ++quoteChecks;
        // a buy the minter refuses must fail through the hook too; a sell the minter queues must fail
        if (isBuy && ok != qok) _mismatch("hook-buy-refusal");
        if (!isBuy && qok && ok == q.queued) _mismatch("hook-sell-queued-flag");
        if (ok != vq) _mismatch("v4quote-refusal");
        if (ok && qok && (paid != q.amountIn || got != q.amountOut)) _mismatch("hook-vs-minter-quote");
        if (ok && vq && (paid != vIn || got != vOut)) _mismatch("hook-vs-v4quote");
    }

    function _v4Quote(address who, PoolKey memory key, IPoolManager.SwapParams memory p, bool isBuy)
        internal
        returns (bool ok, uint256 amountIn, uint256 amountOut)
    {
        vm.prank(who);
        try s.router.quote(key, p) returns (int128 a0, int128 a1) {
            bool usdgIs0 = Currency.unwrap(key.currency0) == address(s.usdg);
            (int128 du, int128 dt) = usdgIs0 ? (a0, a1) : (a1, a0);
            (int128 dIn, int128 dOut) = isBuy ? (du, dt) : (dt, du);
            if (dIn > 0 || dOut < 0) return (false, 0, 0);
            (ok, amountIn, amountOut) = (true, uint256(uint128(-dIn)), uint256(uint128(dOut)));
        } catch {}
    }

    // ============================================================================================ time and inputs

    /// Up to 3 days, crossing sessions and weekends. Oracles keep publishing (except halted markets); the keeper
    /// pokes risk.
    function warp(uint256 seconds_) external step("warp") {
        seconds_ = _bound(seconds_, 1, 3 days);
        vm.warp(block.timestamp + seconds_);
        s.cal.setKind(_sessionAt(block.timestamp));
        _refresh();
    }

    /// Feed and reference move together by up to +-30% (a jump past the guard's continuity band latches a pause).
    function movePrice(uint256 marketIdx, int256 moveBps) external step("movePrice") {
        uint256 mi = marketIdx % N_MARKETS;
        moveBps = _bound(moveBps, -3000, 3000);
        uint256 p = priceOf[mi] * uint256(10_000 + moveBps) / 10_000;
        if (p < 1e18) p = 1e18;
        if (p > 1_000_000e18) p = 1_000_000e18;
        priceOf[mi] = p;
        _push(mi);
        _pokeRisk();
    }

    function haltFeed(uint256 marketIdx, bool halted) external step("haltFeed") {
        uint256 mi = marketIdx % N_MARKETS;
        halted = halted && (marketIdx >> 8) % 3 == 0; // halts are rarer than resumptions, so runs keep trading
        haltedOf[mi] = halted;
        if (address(stocks[mi]) != address(0)) stocks[mi].setOraclePaused(halted);
        _push(mi);
    }

    function postVol(uint256 marketIdx, uint64 sigmaBps) external step("postVol") {
        uint256 k = marketIdx % 4;
        bytes32 key = k == 3 ? pairVolKey : markets[k];
        sigmaBps = uint64(_bound(sigmaBps, 1000, 4000));
        if (block.timestamp < postedAt[key] + s.vol.MIN_POST_INTERVAL()) return;
        if (!_postVol(key, sigmaBps)) ++revertsOf["postVol"];
    }

    function accrue(uint256 gearIdx) external step("accrue") {
        try s.minter.accrue(_gear(gearIdx)) {}
        catch {
            ++revertsOf["accrue"];
        }
    }

    function pokeRisk() external step("pokeRisk") {
        _pokeRisk();
    }

    // ============================================================================================ backers

    function backerOpen(uint256 actor, uint256 gearIdx, uint256 usdg) external step("backerOpen") {
        address who = a.backer(actor);
        bytes32 g = _gear(gearIdx);
        if (s.reg.gear(g).gear == Gear.ECO) return; // not backable (negative toll)
        usdg = _bound(usdg, 50e6, 20_000e6);
        _fund(who, usdg, address(s.backer));
        vm.prank(who);
        try s.backer.openVault(g, usdg) returns (uint256 id) {
            vaultIds.push(id);
        } catch {
            ++revertsOf["backerOpen"];
        }
    }

    function _vault(uint256 idx) internal view returns (uint256 id, address owner, bytes32 g, uint256 debt) {
        if (vaultIds.length == 0) return (0, address(0), 0, 0);
        id = vaultIds[idx % vaultIds.length];
        (owner, g,, debt,) = s.backer.vault(id);
    }

    function backerMint(uint256 actor, uint256 vaultIdx, uint256 tokens, bool sellToGovernor)
        external
        step("backerMint")
    {
        actor;
        (uint256 id, address owner, bytes32 g,) = _vault(vaultIdx);
        if (id == 0) return;
        // up to the most the vault may mint at its initial ratio, so later moves can make it unhealthy
        (uint256 coll, uint256 debtWad,, uint256 req,) = s.backer.health(id);
        (uint256 v,) = s.minter.valuePerToken(g);
        uint256 room = req == 0 ? 0 : coll * 1e12 * 10_000 / req;
        uint256 maxTokens = v == 0 || room <= debtWad ? 1e18 : (room - debtWad) * 1e18 / v;
        tokens = _bound(tokens, 1e18, maxTokens < 1e18 ? 1e18 : maxTokens);
        vm.prank(owner);
        try s.backer.mint(id, tokens, sellToGovernor, 0) {}
        catch {
            ++revertsOf["backerMint"];
        }
    }

    /// Repay with tokens (never blocked, R4) when the owner holds some; otherwise with USDG.
    function backerRepay(uint256 actor, uint256 vaultIdx, uint256 tokens) external step("backerRepay") {
        actor;
        (uint256 id, address owner, bytes32 g, uint256 debt) = _vault(vaultIdx);
        if (id == 0 || debt == 0) return;
        uint256 bal = _tok(g).balanceOf(owner);
        if (bal != 0) {
            tokens = _bound(tokens, 1, bal < debt ? bal : debt);
            vm.prank(owner);
            try s.backer.repay(id, tokens) {}
            catch (bytes memory e) {
                ++revertsOf["backerRepay"];
                _gated("backerRepay", e);
            }
            return;
        }
        tokens = _bound(tokens, 1, debt);
        _fund(owner, 100_000e6, address(s.backer));
        vm.prank(owner);
        try s.backer.repayWithUsdg(id, tokens, type(uint256).max) {}
        catch {
            ++revertsOf["backerRepay"];
        }
    }

    /// Anyone tops a vault up; never blocked (R4).
    function backerDeposit(uint256 actor, uint256 vaultIdx, uint256 usdg) external step("backerDeposit") {
        (uint256 id,,,) = _vault(vaultIdx);
        if (id == 0) return;
        address who = a.backer(actor);
        usdg = _bound(usdg, 0, 5_000e6);
        _fund(who, usdg, address(s.backer));
        vm.prank(who);
        try s.backer.deposit(id, usdg) {}
        catch (bytes memory e) {
            ++revertsOf["backerDeposit"];
            _gated("backerDeposit", e);
        }
    }

    function backerWithdraw(uint256 actor, uint256 vaultIdx, uint256 usdg) external step("backerWithdraw") {
        actor;
        (uint256 id, address owner,,) = _vault(vaultIdx);
        if (id == 0) return;
        usdg = _bound(usdg, 0, 20_000e6);
        vm.prank(owner);
        try s.backer.withdraw(id, usdg, owner) {}
        catch {
            ++revertsOf["backerWithdraw"];
        }
    }

    /// The liquidator seals every unhealthy free vault of a gear, waits, and executes. Holders are never in it.
    function sealAndExecute(uint256 gearIdx, uint256 waitSeconds) external step("sealAndExecute") {
        bytes32 g = _gear(gearIdx);
        uint256[] memory ids = new uint256[](vaultIds.length);
        uint256 n;
        for (uint256 i; i < vaultIds.length && n < 50; ++i) {
            (, bytes32 vg,, uint256 debt, uint256 inBatch) = s.backer.vault(vaultIds[i]);
            if (vg != g || debt == 0 || inBatch != 0) continue;
            (,, uint256 ratio,, uint256 maint) = s.backer.health(vaultIds[i]);
            if (ratio < maint) ids[n++] = vaultIds[i];
        }
        if (n == 0) return;
        assembly {
            mstore(ids, n)
        }
        vm.prank(a.liquidator);
        uint256 batchId;
        try s.backer.sealBatch(g, ids) returns (uint256 b) {
            batchId = b;
            ++batchesSealed;
        } catch {
            ++revertsOf["sealAndExecute"];
            return;
        }
        waitSeconds = _bound(waitSeconds, s.backer.SEAL_DELAY(), s.backer.BATCH_TTL() + 60);
        vm.warp(block.timestamp + waitSeconds);
        _refresh();
        vm.prank(a.liquidator);
        try s.backer.executeBatch(batchId) returns (uint256 liq) {
            ++batchesExecuted;
            vaultsLiquidated += liq;
        } catch {
            ++revertsOf["sealAndExecute"];
        }
    }

    // ============================================================================================ the Governor

    function governorDeposit(uint256 usdg) external step("governorDeposit") {
        usdg = _bound(usdg, 1e6, 200_000e6);
        _fund(s.lp, usdg, address(s.gov));
        vm.prank(s.lp);
        try s.gov.deposit(usdg, s.lp) {}
        catch {
            ++revertsOf["governorDeposit"];
        }
    }

    /// The LP queues a withdrawal and claims every matured ticket. A claim is refused only for a stale hedge post.
    /// fix-audit2 changes the claim rules: the allowed-refusal set here follows main at 1704788.
    function governorRequestAndClaim(uint256 shares) external step("governorRequestAndClaim") {
        uint256 bal = s.gov.balanceOf(s.lp);
        if (bal > 1) {
            vm.prank(s.lp);
            try s.gov.requestWithdraw(_bound(shares, 1, bal / 2)) returns (uint256 tk) {
                lpTickets.push(tk);
            } catch {
                ++revertsOf["governorRequestAndClaim"];
            }
        }
        for (uint256 i; i < lpTickets.length; ++i) {
            (, uint256 sh, uint64 at) = s.gov.ticketOf(lpTickets[i]);
            if (sh == 0 || block.timestamp < at) continue;
            vm.prank(s.lp);
            try s.gov.claim(lpTickets[i], 0) {}
            catch (bytes memory e) {
                if (_sel(e) == IODGovernor.HedgeStale.selector) ++claimHedgeStale;
                else _gated("claim", e);
            }
        }
    }

    /// Keeper moves free cash into the exit reserve: payouts then lean on the reserve (R1, R8).
    function keeperFundReserve(uint256 usdg) external step("keeperFundReserve") {
        uint256 cash = s.gov.trackedCash();
        usdg = _bound(usdg, 0, cash);
        vm.prank(a.keeper);
        try s.gov.moveToExitReserve(usdg) {}
        catch {
            ++revertsOf["keeperFundReserve"];
        }
    }

    // ============================================================================================ donations (GEN-3)

    /// A plain USDG transfer to a core contract. R9: share price, books, vault health and quotes are unchanged.
    function donate(uint256 targetIdx, uint256 usdg) external step("donate") {
        address[5] memory targets =
            [address(s.gov), address(s.backer), address(s.minter), address(s.hook), address(s.fees)];
        address target = targets[targetIdx % 5];
        usdg = _bound(usdg, 1, 1_000_000e6);
        bytes32 before = _fingerprint();
        s.usdg.mint(target, usdg);
        donatedUsdg[target] += usdg;
        ++donationChecks;
        if (_fingerprint() != before) {
            ++donationEffects;
            lastDonationEffect = bytes32(uint256(uint160(target)));
        }
    }

    /// Everything a donation must not move, hashed.
    function _fingerprint() internal returns (bytes32 h) {
        h = keccak256(
            abi.encode(
                s.gov.sharePriceWad(),
                s.gov.trackedCash(),
                s.gov.exitReserve(),
                s.gov.totalAssets(),
                s.backer.totalCollateral(),
                s.fees.pending(),
                s.fees.totalHeld()
            )
        );
        uint256 n = vaultIds.length < 5 ? vaultIds.length : 5;
        for (uint256 i; i < n; ++i) {
            (uint256 c, uint256 d, uint256 r,,) = s.backer.health(vaultIds[i]);
            h = keccak256(abi.encode(h, c, d, r));
        }
        for (uint256 i; i < gearIds.length; i += 3) {
            (bool ok, Quote memory q) = _quote(a.stranger, gearIds[i], false, true, 100e18);
            h = keccak256(abi.encode(h, ok, q.amountOut, q.queued));
            (ok, q) = _quote(a.stranger, gearIds[i], true, true, 1_000e6);
            h = keccak256(abi.encode(h, ok, q.amountOut));
        }
    }

    // ============================================================================================ pauses (R11)

    function _pauseCall(uint256 which, bool paused) internal view returns (address target, bytes memory data) {
        which %= 4;
        if (which == 0) return (address(s.gov), abi.encodeCall(ODGovernor.setBuysPaused, (paused)));
        if (which == 1) return (address(s.backer), abi.encodeWithSignature("setMintPaused(bool)", paused));
        return (address(s.guard), abi.encodeCall(ODOracleGuard.setBuysPaused, (markets[which == 2 ? 0 : 2], paused)));
    }

    function guardianPause(uint256 which) external step("guardianPause") {
        (address target, bytes memory data) = _pauseCall(which, true);
        vm.prank(a.guardian);
        (bool ok,) = target.call(data);
        if (ok) {
            ++guardianPauses;
            pausedOf[which % 4] = true;
        } else {
            ++revertsOf["guardianPause"];
        }
    }

    /// Schedules the unpause on the real TimelockController, lets the 48 h delay pass (oracles keep publishing) and
    /// executes it. Before that, the guardian, the keeper and a stranger each try to unpause directly, and once more
    /// while the operation is pending: every such call must revert, and so must an early execute.
    function timelockUnpause(uint256 which) external step("timelockUnpause") {
        which %= 4;
        for (uint256 k; k < 4 && !pausedOf[which]; ++k) {
            which = (which + 1) % 4; // prefer something the guardian actually paused
        }
        (address target, bytes memory data) = _pauseCall(which, false);
        _othersTryUnpause(target, data);
        TimelockController tl = s.timelock;
        bytes32 salt = keccak256(abi.encode(UNPAUSE_SALT, which, unpauseRound[which]++));
        uint256 delay = tl.getMinDelay();
        vm.prank(a.proposer);
        tl.schedule(target, 0, data, bytes32(0), salt, delay);
        vm.prank(a.stranger);
        try tl.execute(target, 0, data, bytes32(0), salt) {
            ++nonTimelockUnpauses; // executed before the delay
        } catch {}
        vm.warp(block.timestamp + delay);
        s.cal.setKind(_sessionAt(block.timestamp));
        _refresh();
        _othersTryUnpause(target, data);
        vm.prank(a.stranger); // executor role is open; only the proposer schedules
        try tl.execute(target, 0, data, bytes32(0), salt) {
            ++timelockUnpauses;
            pausedOf[which] = false;
        } catch {
            ++revertsOf["timelockUnpause"];
        }
    }

    function _othersTryUnpause(address target, bytes memory data) internal {
        address[3] memory others = [a.guardian, a.keeper, a.stranger];
        for (uint256 i; i < 3; ++i) {
            vm.prank(others[i]);
            (bool bad,) = target.call(data);
            if (bad) ++nonTimelockUnpauses;
        }
    }

    // ============================================================================================ fees

    function distributeFees() external step("distributeFees") {
        try s.fees.distribute() {}
        catch {
            ++revertsOf["distributeFees"];
        }
    }

    // ============================================================================================ views for the test

    function ticketCount() external view returns (uint256) {
        return tickets.length;
    }

    function vaultCount() external view returns (uint256) {
        return vaultIds.length;
    }

    function gearCount() external view returns (uint256) {
        return gearIds.length;
    }

    function gearAt(uint256 i) external view returns (bytes32) {
        return gearIds[i];
    }

    function tokenAt(uint256 i) external view returns (address) {
        return tokens[i];
    }

    function holderAt(uint256 i) external view returns (address) {
        return a.holders[i];
    }
}

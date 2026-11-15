// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IODInsurance} from "../interfaces/IODInsurance.sol";
import {GearConfig, GearStatus, NormState, PriceReading} from "../interfaces/ODTypes.sol";
import {ODPowers} from "../interfaces/ODPowers.sol";
import {IODGearRegistry} from "../interfaces/IODGearRegistry.sol";
import {IODOracleGuard} from "../interfaces/IODOracleGuard.sol";
import {IODMinter} from "../interfaces/IODMinter.sol";
import {IODGovernor} from "../interfaces/IODGovernor.sol";
import {ODIndex} from "../math/ODIndex.sol";

/// @title ODGovernorRisk
/// @notice The Governor's per-gear loops: book liability (at p and at the reference price), exposure, per-gear open
/// value and the exact power stress per market. External library (delegatecall) so ODGovernor stays under 24,576 bytes.
/// @dev Units: gear tokens 18 dp, values USD WAD, liabilities signed USD WAD (positive = owed to holders).
/// net(g) = token supply - backer debt; a negative net is a Governor long (an asset).
library ODGovernorRisk {
    uint256 internal constant WAD = 1e18;

    /// The Governor's cash books: free cash, the exit reserve, and (M-7) per gear the backer sale lock, free cash a
    /// backer mint to the owner's wallet held back (`locked` is its sum), and `own`, the backer debt still open from
    /// such mints, in tokens. A sell's share for tokens that take supply below `own` is the share that debt answers
    /// for: the lock pays it, then free cash. Debt sold to the Governor is not in `own` and changes no payout.
    struct Books {
        uint256 cash;
        uint256 reserve;
        uint256 locked;
        mapping(bytes32 gearId => uint256) lock;
        mapping(bytes32 gearId => uint256) own;
    }

    struct Ctx {
        IODGearRegistry registry;
        IODOracleGuard guard;
        address minter;
    }

    /// Liabilities: mid at the guard's p, low-NAV side (the larger liability of p and refP per gear), high-NAV side
    /// (the smaller), and the holder open value (supply x value at p, for the exit reserve floor).
    struct Book {
        int256 mid;
        int256 worse;
        int256 better;
        uint256 holderOpen;
    }

    /// Hedge jump window (M-2): the unexplained hedge-equity change summed over every market since `start`, measured
    /// against the Governor's cached equity at `start` (USDG, 6 dp). Restarts every hedgeMaxAge.
    struct JumpWindow {
        uint64 start;
        int96 netUsdg;
        uint96 anchorUsdg;
    }

    struct Shock {
        int256 sWad; // single-name shock (WAD, e.g. 0.25e18)
        int256 pairWad; // pair ratio shock
        int256 hedgeDeltaWad; // 0 when the market's hedge post is stale
    }

    // --------------------------------------------------------------------------------------------- hedge jump

    /// @notice The hedge equity a non-admin post may set on a market whose last post is `prev` (M-2). Rule: the
    /// unexplained change r (the change less USDG in transit of the same sign) keeps |r| <= A and
    /// |window net + r| <= A, A = maxHedgeJumpBps x the window's anchor equity. The window restarts every hedgeMaxAge
    /// at the cached equity then, so in any block NAV moves at most A from the anchor whatever the number of posts,
    /// and any hedgeMaxAge seconds move it at most 2A. This is the ONE rule: postHedge and hedgeJumpRange use it.
    function jumpRange(JumpWindow storage w, IODGovernor.Params storage p, uint256 prev, int256 transit, int256 eqWad)
        external
        view
        returns (uint256 lo, uint256 hi)
    {
        (, lo, hi) = _range(w, p, prev, transit, eqWad);
    }

    /// @notice Checks one post against the rule (skipped for `admin`), writes the window and returns the USDG of
    /// transit the post absorbs. Reverts HedgeJump(prev, next, room on that side) outside the range.
    function hedgeJump(
        JumpWindow storage w,
        IODGovernor.Params storage p,
        uint256 prev,
        uint256 next,
        int256 transit,
        int256 eqWad,
        bool admin
    ) external returns (int256 absorbed) {
        int256 change = int256(next) - int256(prev);
        if (transit > 0 && change > 0) absorbed = change < transit ? change : transit;
        else if (transit < 0 && change < 0) absorbed = change > transit ? change : transit;
        if (admin) return absorbed;
        (JumpWindow memory nw, uint256 lo, uint256 hi) = _range(w, p, prev, transit, eqWad);
        if (next < lo || next > hi) revert IODGovernor.HedgeJump(prev, next, next > prev ? hi - prev : prev - lo);
        nw.netUsdg += int96(change - absorbed);
        w.start = nw.start;
        w.netUsdg = nw.netUsdg;
        w.anchorUsdg = nw.anchorUsdg;
    }

    function _range(JumpWindow storage w, IODGovernor.Params storage p, uint256 prev, int256 transit, int256 eqWad)
        private
        view
        returns (JumpWindow memory nw, uint256 lo, uint256 hi)
    {
        nw = w;
        if (nw.start == 0 || block.timestamp >= uint256(nw.start) + p.hedgeMaxAge) {
            uint256 a = eqWad > 0 ? uint256(eqWad) / 1e12 : 0;
            nw = JumpWindow({
                start: uint64(block.timestamp),
                netUsdg: 0,
                anchorUsdg: uint96(a > type(uint96).max ? type(uint96).max : a)
            });
        }
        int256 cap = int256(uint256(nw.anchorUsdg) * p.maxHedgeJumpBps / 10_000);
        int256 n = nw.netUsdg;
        int256 rLo = n > 0 ? -cap : -cap - n; // max(-A, -A - net)
        int256 rHi = n < 0 ? cap : cap - n; // min(A, A - net)
        // In-transit USDG explains a change of its own sign, so it widens the range on that side only.
        if (transit < 0) rLo += transit;
        else rHi += transit;
        int256 l = int256(prev) + rLo;
        int256 h = int256(prev) + rHi;
        lo = l > 0 ? uint256(l) : 0;
        hi = h > 0 ? uint256(h) : 0;
    }

    // --------------------------------------------------------------------------------------------- book

    /// @notice Computes the book of every listed gear from supply and backer debt.
    /// @param c The context with the registry and modules.
    /// @param debt Backer debt per gear id, in tokens.
    /// @return b  The b.
    function book(Ctx memory c, mapping(bytes32 => uint256) storage debt) external view returns (Book memory b) {
        uint256 n = c.registry.gearCount();
        for (uint256 i; i < n; ++i) {
            bytes32 id = c.registry.gearIdAt(i);
            GearConfig memory cfg = c.registry.gear(id);
            uint256 supply = IERC20(cfg.token).totalSupply();
            int256 net = int256(supply) - int256(debt[id]);
            if (supply == 0 && net == 0) continue;
            (uint256 v, uint256 vRef, bool hasRef) = _values(c, id, cfg, net >= 0);
            int256 atP = mulNet(net, v);
            b.mid += atP;
            int256 atRef = hasRef ? mulNet(net, vRef) : atP;
            b.worse += atP > atRef ? atP : atRef;
            b.better += atP < atRef ? atP : atRef;
            b.holderOpen += Math.mulDiv(supply, v, WAD);
        }
    }

    /// |net| x value at p for one gear, with `addTokens` more supply (a buy not yet minted).
    function gearOpen(Ctx memory c, mapping(bytes32 => uint256) storage debt, bytes32 id, uint256 addTokens)
        external
        view
        returns (uint256 openWad, uint256 capUsdWad, int256 net)
    {
        GearConfig memory cfg = c.registry.gear(id);
        net = int256(IERC20(cfg.token).totalSupply() + addTokens) - int256(debt[id]);
        (uint256 v,,) = _values(c, id, cfg, net >= 0);
        int256 val = mulNet(net, v);
        openWad = uint256(val >= 0 ? val : -val);
        capUsdWad = cfg.capUsdWad;
    }

    /// M-7: open value and static cap checked at a backer mint. Sold to the Governor (`own` false): the live net, as
    /// gearOpen. Minted to the owner's wallet (`own` true): the worst case once every holder has exited, net = -(total
    /// backer debt), so later holder exits cannot push the gear past its cap.
    function mintOpen(Ctx memory c, mapping(bytes32 => uint256) storage debt, bytes32 id, bool own)
        external
        view
        returns (uint256 openWad, uint256 capUsdWad, int256 net)
    {
        GearConfig memory cfg = c.registry.gear(id);
        net = own ? -int256(debt[id]) : int256(IERC20(cfg.token).totalSupply()) - int256(debt[id]);
        (uint256 v,,) = _values(c, id, cfg, net >= 0);
        int256 val = mulNet(net, v);
        openWad = uint256(val >= 0 ? val : -val);
        capUsdWad = cfg.capUsdWad;
    }

    /// A backer mint to the owner's wallet (M-7): moves `usdg`, the tokens' sale value, from free cash into the gear's
    /// lock and adds the tokens to its own-minted debt. M-8: refused (false, nothing moved) when the locks of all gears
    /// would then pass `maxLockBps` of free cash plus locks. The mint costs the owner nothing, so without this ceiling
    /// own mints on unused gears could park all free cash, starving LP claims and pushing every holder sell onto the
    /// exit reserve and insurance. The caller has checked `usdg <= b.cash`.
    function lockOwn(Books storage b, bytes32 id, uint256 tokens, uint256 usdg, uint256 maxLockBps)
        external
        returns (bool)
    {
        uint256 locked = b.locked + usdg;
        if (locked * 10_000 > (b.cash + b.locked) * maxLockBps) return false;
        b.cash -= usdg;
        b.lock[id] += usdg;
        b.locked = locked;
        b.own[id] += tokens;
        return true;
    }

    /// IODGovernor.setParams: every field inside its hard range (InvalidParams otherwise), stored, ParamsSet emitted.
    /// Here for the Governor's code size.
    function setParams(IODGovernor.Params storage to, IODGovernor.Params calldata p) external {
        if (
            p.stressBudgetBps == 0 || p.stressBudgetBps > 5000 || p.capScaleBps == 0 || p.capScaleBps > 10_000
                || p.exitReserveFloorBps > 5000 || p.maxHedgeEquityBps > 8000 || p.maxHedgeJumpBps > 5000
                || p.hedgeMaxAge < 10 minutes || p.hedgeMaxAge > 1 days || p.equityMaxAge < 5 minutes
                || p.equityMaxAge > 1 days || p.drawdownBps < 100 || p.drawdownBps > 5000 || p.withdrawDelay < 1 hours
                || p.withdrawDelay > 30 days || !_shockOk(p.shockStockBps) || !_shockOk(p.shockEtfBps)
                || !_shockOk(p.shockCryptoBps) || !_shockOk(p.shockPairBps) || p.maxLockBps > 5000
        ) revert IODGovernor.InvalidParams();
        to.stressBudgetBps = p.stressBudgetBps;
        to.capScaleBps = p.capScaleBps;
        to.exitReserveFloorBps = p.exitReserveFloorBps;
        to.minExitReserveUsdg = p.minExitReserveUsdg;
        to.maxHedgeEquityBps = p.maxHedgeEquityBps;
        to.maxHedgeJumpBps = p.maxHedgeJumpBps;
        to.hedgeMaxAge = p.hedgeMaxAge;
        to.equityMaxAge = p.equityMaxAge;
        to.drawdownBps = p.drawdownBps;
        to.withdrawDelay = p.withdrawDelay;
        to.shockStockBps = p.shockStockBps;
        to.shockEtfBps = p.shockEtfBps;
        to.shockCryptoBps = p.shockCryptoBps;
        to.shockPairBps = p.shockPairBps;
        to.maxLockBps = p.maxLockBps;
        emit IODGovernor.ParamsSet(p);
    }

    function _shockOk(uint16 b) private pure returns (bool) {
        return b != 0 && b <= 9000;
    }

    // ------------------------------------------------------------------------------------------- payout

    /// Pays a sell of `tokens` for `usdg` (IODGovernor.onSell), supply read here, after the burn. The share for tokens
    /// that took supply below the gear's own-minted backer debt comes from the gear's lock, then free cash, never the
    /// exit reserve or insurance; the rest (all of it when no such debt is open) from free cash, the exit reserve,
    /// then ODInsurance cover. False when short or when the transfer fails (reverts when out of gas).
    function paySell(
        Books storage b,
        IERC20 u,
        IODInsurance ins,
        IODGearRegistry reg,
        bytes32 id,
        uint256 tokens,
        address to,
        uint256 usdg
    ) external returns (bool) {
        if (to == address(0)) return false;
        if (usdg == 0) return true;
        (uint256 fromLock, uint256 cashBelow, uint256 above) = _split(b, id, _supply(reg, id, tokens), tokens, usdg);
        uint256 cash = b.cash;
        uint256 res = b.reserve;
        if (cashBelow > cash) return false;
        if (cash - cashBelow + res < above) {
            cash += _drawInsurance(u, ins, above - (cash - cashBelow) - res);
            b.cash = cash;
            if (cash - cashBelow + res < above) return false;
        }
        uint256 fromCash = cash - cashBelow >= above ? usdg - fromLock : cash;
        uint256 fromRes = usdg - fromLock - fromCash;
        b.lock[id] -= fromLock;
        b.locked -= fromLock;
        b.cash = cash - fromCash;
        b.reserve = res - fromRes;
        uint256 g0 = gasleft();
        if (!SafeERC20.trySafeTransfer(u, to, usdg)) {
            if (gasleft() <= g0 / 63) revert IODGovernor.PayOutOfGas();
            b.lock[id] += fromLock;
            b.locked += fromLock;
            b.cash = cash;
            b.reserve = res;
            return false;
        }
        emit IODGovernor.PaidOut(to, usdg, fromRes != 0);
        return true;
    }

    /// Whether paySell would pay (QUOTE-1) for `tokens` still in supply, after `cashDrain` of free cash leaves first
    /// (the trade's own fee settlement).
    function canPaySell(
        Books storage b,
        IODInsurance ins,
        IODGearRegistry reg,
        bytes32 id,
        uint256 tokens,
        uint256 usdg,
        uint256 cashDrain
    ) external view returns (bool) {
        uint256 supply = _supply(reg, id, tokens);
        (, uint256 cashBelow, uint256 above) = _split(b, id, supply > tokens ? supply - tokens : 0, tokens, usdg);
        uint256 cash = b.cash > cashDrain ? b.cash - cashDrain : 0;
        if (cashBelow > cash) return false;
        uint256 have = cash - cashBelow + b.reserve;
        if (have >= above) return true;
        try ins.balance() returns (uint256 ib) {
            return have + ib >= above;
        } catch {
            return false;
        }
    }

    /// Supply of the gear for a sell of `tokens` (0 when none: a bare payout reads no gear).
    function _supply(IODGearRegistry reg, bytes32 id, uint256 tokens) private view returns (uint256) {
        return tokens == 0 ? 0 : IERC20(reg.gear(id).token).totalSupply();
    }

    /// The share of `usdg` for the tokens that took supply below the gear's own-minted backer debt (rounded up),
    /// split into the part the lock covers and the part free cash must cover, and `above`, the rest. Supply below
    /// that debt means net below zero, so `above` holds every share above zero net and every share below zero that
    /// only debt sold to the Governor explains.
    function _split(Books storage b, bytes32 id, uint256 supply, uint256 tokens, uint256 usdg)
        private
        view
        returns (uint256 fromLock, uint256 cashBelow, uint256 above)
    {
        uint256 below;
        uint256 own = b.own[id];
        if (own > supply && tokens != 0) {
            below = own - supply >= tokens ? usdg : Math.mulDiv(usdg, own - supply, tokens, Math.Rounding.Ceil);
        }
        uint256 lk = b.lock[id];
        fromLock = below < lk ? below : lk;
        cashBelow = below - fromLock;
        above = usdg - below;
    }

    /// Lowers the gear's backer debt by `tokens` (IODGovernor.onBackerRepay, absorbLiquidation). I4-1: only
    /// `ownTokens`, the own-minted debt the repaying vault itself cleared (ODBacker tracks it per vault), lowers the
    /// gear's own-minted debt, and the lock is released to free cash in that proportion of the own-minted debt (Floor:
    /// rounds toward staying locked; all of it when no own-minted debt is left). A repay of debt sold to the Governor
    /// (`ownTokens` 0) releases nothing.
    function repay(Books storage b, mapping(bytes32 => uint256) storage debt, bytes32 id, uint256 tokens, uint256 ownTokens)
        external
    {
        uint256 d = debt[id];
        uint256 lk = b.lock[id];
        uint256 own = b.own[id];
        bool all = ownTokens >= own;
        uint256 rel = all ? lk : Math.mulDiv(lk, ownTokens, own);
        debt[id] = tokens >= d ? 0 : d - tokens;
        b.own[id] = all ? 0 : own - ownTokens;
        b.lock[id] = lk - rel;
        b.locked -= rel;
        b.cash += rel;
    }

    function _drawInsurance(IERC20 u, IODInsurance ins, uint256 usdg) private returns (uint256 got) {
        uint256 before = u.balanceOf(address(this));
        try ins.cover(usdg) returns (uint256) {} catch {}
        uint256 bal = u.balanceOf(address(this));
        got = bal > before ? bal - before : 0;
        if (got > usdg) got = usdg; // anything beyond the request stays untracked (skim)
        emit IODGovernor.InsuranceDrawn(usdg, got);
    }

    // ----------------------------------------------------------------------------------------- exposure

    /// delta += p_eff x V x net, gamma += p_eff (p_eff - 1) x V x net, open += |net| x V; p_eff = power on marketA and
    /// -power on a pair's marketB.
    function exposure(Ctx memory c, mapping(bytes32 => uint256) storage debt, bytes32 market)
        external
        view
        returns (int256 delta, int256 gamma, uint256 open)
    {
        bytes32[] memory ids = c.registry.gearsOfMarket(market);
        for (uint256 i; i < ids.length; ++i) {
            GearConfig memory cfg = c.registry.gear(ids[i]);
            int256 net = int256(IERC20(cfg.token).totalSupply()) - int256(debt[ids[i]]);
            if (net == 0) continue;
            (uint256 v,,) = _values(c, ids[i], cfg, net >= 0);
            int256 val = mulNet(net, v);
            int256 p = ODPowers.powerWad(cfg.gear);
            if (cfg.marketB == market) p = -p;
            delta += p * val / int256(WAD);
            gamma += (p * (p - int256(WAD)) / int256(WAD)) * val / int256(WAD);
            open += uint256(val >= 0 ? val : -val);
        }
    }

    // ------------------------------------------------------------------------------------------- stress

    /// Worst loss over shocks {-s, -s/2, +s/2, +s} of the book in `market` (net x V x (shockFactor - 1)) less the hedge
    /// P&L hedgeDelta x shock, floored at 0; plus, separately, the worst loss of the pairs whose numerator is `market`,
    /// shocked on the ratio (a pair is stressed once, under its marketA). `addId` gets `addTokens` more supply.
    function marketLoss(
        Ctx memory c,
        mapping(bytes32 => uint256) storage debt,
        bytes32 market,
        Shock memory sh,
        bytes32 addId,
        uint256 addTokens
    ) external view returns (uint256 lossWad) {
        int256[4] memory single;
        int256[4] memory pair;
        bytes32[] memory ids = c.registry.gearsOfMarket(market);
        for (uint256 i; i < ids.length; ++i) {
            GearConfig memory cfg = c.registry.gear(ids[i]);
            bool isPair = cfg.marketB != bytes32(0);
            if (isPair && cfg.marketA != market) continue;
            uint256 supply = IERC20(cfg.token).totalSupply();
            if (ids[i] == addId) supply += addTokens;
            int256 net = int256(supply) - int256(debt[ids[i]]);
            if (net == 0) continue;
            _addShocks(isPair ? pair : single, c, ids[i], cfg, net, isPair ? sh.pairWad : sh.sWad);
        }
        int256 worstS;
        int256 worstP;
        int256 d = sh.hedgeDeltaWad; // L-2: clamped first so delta x shock cannot overflow
        if (d > type(int128).max) d = type(int128).max;
        else if (d < -type(int128).max) d = -type(int128).max;
        for (uint256 k; k < 4; ++k) {
            // L-2: the posted hedge P&L counts at most the book's own move at that shock, so a wrong or hostile delta
            // can at most double the unhedged loss (it can never make stress unbounded)
            int256 hp = d * shockAt(sh.sWad, k) / int256(WAD);
            int256 bound = single[k] >= 0 ? single[k] : -single[k];
            if (hp > bound) hp = bound;
            else if (hp < -bound) hp = -bound;
            int256 l = single[k] - hp;
            if (l > worstS) worstS = l;
            if (pair[k] > worstP) worstP = pair[k];
        }
        lossWad = uint256(worstS) + uint256(worstP);
    }

    /// Shock k of {-s, -s/2, +s/2, +s}.
    function shockAt(int256 s, uint256 k) internal pure returns (int256) {
        if (k == 0) return -s;
        if (k == 1) return -s / 2;
        if (k == 2) return s / 2;
        return s;
    }

    function _addShocks(int256[4] memory acc, Ctx memory c, bytes32 id, GearConfig memory cfg, int256 net, int256 s)
        private
        view
    {
        (uint256 v,,) = _values(c, id, cfg, net >= 0);
        int256 val = mulNet(net, v);
        // Rounded toward more loss: a larger factor for a Governor short, a smaller one for a long.
        Math.Rounding rnd = net >= 0 ? Math.Rounding.Ceil : Math.Rounding.Floor;
        for (uint256 k; k < 4; ++k) {
            int256 f = int256(ODIndex.shockFactor(cfg.gear, shockAt(s, k), rnd)) - int256(WAD);
            acc[k] += val * f / int256(WAD);
        }
    }

    // ------------------------------------------------------------------------------------------ helpers

    /// Signed net x value / 1e18, magnitude rounded up for a liability (net > 0) and down for an asset (net < 0).
    function mulNet(int256 net, uint256 v) internal pure returns (int256) {
        if (net >= 0) return int256(Math.mulDiv(uint256(net), v, WAD, Math.Rounding.Ceil));
        return -int256(Math.mulDiv(uint256(-net), v, WAD));
    }

    /// Value per token at the guard's p (CLOSED/HALTED: the guard's last good) and at refP (hasRef false when 0).
    /// Rounded up when the Governor is short (`up`), down when long. SETTLED gears use the minter's final value.
    function _values(Ctx memory c, bytes32 id, GearConfig memory cfg, bool up)
        private
        view
        returns (uint256 v, uint256 vRef, bool hasRef)
    {
        if (cfg.status == GearStatus.SETTLED && c.minter != address(0)) {
            try IODMinter(c.minter).valuePerToken(id) returns (uint256 fv, bool) {
                return (fv, fv, false);
            } catch {}
        }
        PriceReading memory r =
            cfg.marketB == bytes32(0) ? c.guard.read(cfg.marketA) : c.guard.readRatio(cfg.marketA, cfg.marketB);
        uint256 nf = _nf(c.minter, id);
        Math.Rounding rnd = up ? Math.Rounding.Ceil : Math.Rounding.Floor;
        (v,) = ODIndex.value(cfg.gear, r.p == 0 ? cfg.p0 : r.p, cfg.p0, nf, cfg.unitWad, rnd);
        if (r.refP != 0) {
            (vRef,) = ODIndex.value(cfg.gear, r.refP, cfg.p0, nf, cfg.unitWad, rnd);
            hasRef = true;
        }
    }

    function _nf(address minter, bytes32 id) private view returns (uint256) {
        if (minter == address(0)) return WAD;
        try IODMinter(minter).normState(id) returns (NormState memory s) {
            return s.nf == 0 ? WAD : s.nf;
        } catch {
            return WAD;
        }
    }
}

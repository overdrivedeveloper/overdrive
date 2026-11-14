// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
        for (uint256 k; k < 4; ++k) {
            int256 l = single[k] - sh.hedgeDeltaWad * shockAt(sh.sWad, k) / int256(WAD);
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

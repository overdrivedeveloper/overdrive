// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Gear, GearConfig, GearStatus, NormState, PriceReading, Session} from "../interfaces/ODTypes.sol";
import {IODMinter} from "../interfaces/IODMinter.sol";
import {IODGovernor} from "../interfaces/IODGovernor.sol";
import {IODGearRegistry} from "../interfaces/IODGearRegistry.sol";
import {IODOracleGuard} from "../interfaces/IODOracleGuard.sol";
import {IODVolOracle, VolReading} from "../interfaces/IODVolOracle.sol";
import {IODFees} from "../interfaces/IODFees.sol";
import {ODIndex} from "../math/ODIndex.sol";
import {ODNorm} from "../math/ODNorm.sol";
import {ODToll} from "../math/ODToll.sol";

/// @title ODMinterPricing
/// @notice The ONE pricing path of ODMinter: `context` (reads plus the trade's own accrual, simulated), `trade`
/// (value basis, spread, amounts) and `buyGate`. `quote`, `buy*`, `sell*`, `fillQueued` and `hookSwap` all go through
/// these three functions, so a quote equals its execution to the wei (QUOTE-1).
/// @dev Units: tokens 18 dp, USDG 6 dp, values and prices USD WAD per 1e18 tokens, so tokens x price / 1e30 = USDG.
/// Every rounding sides with the Governor: buys round value and price up and tokens down, sells the other way.
library ODMinterPricing {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SCALE = 1e30;
    uint256 internal constant USDG_TO_WAD = 1e12;
    /// @notice Most a staking tier may take off a spread, as a share of it: ODStake.MAX_SPREAD_DISCOUNT_BPS (20%).
    uint256 internal constant MAX_DISCOUNT_BPS = 2_000;

    struct Deps {
        IODGearRegistry registry;
        IODOracleGuard guard;
        IODVolOracle vol;
        IODGovernor governor;
        address fees;
    }

    /// Everything a trade needs, read once. Accrual fields are the result the trade's own accrual WILL write.
    struct Ctx {
        bytes32 id;
        GearConfig cfg;
        PriceReading r;
        VolReading vol;
        bool live; // OPEN or EXTENDED, fresh
        bool settled;
        uint256 settledValue;
        int256 net; // holder supply - backer debt
        // accrual
        bool accrues; // false: same second, settled or unknown (no write)
        uint256 nf; // before
        uint256 nfNew; // after
        int256 rateNew; // stored per-second rate after
        uint64 sigma; // sigma used and stored
        uint256 dt;
        int256 tollValue; // on the Governor's net short, signed (positive: holders pay)
        uint256 cumAdd; // positive toll per token
        uint256 feeDrain; // USDG the Governor's onToll moves out of free cash (fee settlement)
    }

    struct Trade {
        uint256 value; // value per token used
        uint256 price; // value +/- spread
        uint16 spreadBps;
        uint256 tokens;
        uint256 usdg;
        uint256 spreadUsdg; // USDG of spread inside the trade (protocol share is booked by the Governor)
        bool queued; // sell: no safe price now (use the queue)
        bool inDomain;
    }

    // ------------------------------------------------------------------------------------------------ context

    /// @notice Reads the gear, the guard (single name or pair), the vol post and the book, and simulates the accrual
    /// the trade performs first (R1, R2). Never reverts for a known gear; an unknown gear returns token == 0.
    /// Off a live reading `c.r.refP` is kept only when every leg's reference is a fresh Pyth print (I7-1); otherwise
    /// it is 0 and `trade` queues the sell.
    function context(
        Deps memory d,
        bytes32 id,
        NormState memory s,
        uint64 lastSigma,
        uint256 settledV,
        uint128 usageMax
    ) external view returns (Ctx memory c) {
        c.id = id;
        c.cfg = d.registry.gear(id);
        c.nf = s.nf == 0 ? WAD : s.nf;
        c.nfNew = c.nf;
        c.rateNew = s.tollPerSecWad;
        c.sigma = lastSigma;
        if (c.cfg.token == address(0)) return c;
        bytes32 a = c.cfg.marketA;
        bytes32 b = c.cfg.marketB;
        c.r = b == bytes32(0) ? d.guard.read(a) : d.guard.readRatio(a, b);
        c.live = (c.r.session == Session.OPEN || c.r.session == Session.EXTENDED) && c.r.fresh;
        // I7-1: off a live reading (CLOSED, UNKNOWN, HALTED) the feed price is frozen, so the reference alone decides
        // what a sell is paid. A v3 TWAP can be held at the frozen price by one actor for one window; a Pyth print
        // inside refMaxAge cannot. Without a Pyth print on every leg there is no reference: the sell goes to the queue
        // and fills at the first live round. Buys are closed off a live reading either way.
        if (!c.live && c.r.refP != 0 && !(_fromPyth(d.guard, a) && (b == bytes32(0) || _fromPyth(d.guard, b)))) {
            c.r.refP = 0;
        }
        c.net = int256(IERC20(c.cfg.token).totalSupply()) - int256(d.governor.backerDebt(id));
        c.vol = _vol(d.vol, b == bytes32(0) ? a : keccak256(abi.encode(a, b)));
        if (settledV != 0) {
            c.settled = true;
            c.settledValue = settledV;
            return c;
        }
        if (s.lastAccrual == block.timestamp) return c; // same second: no-op
        c.accrues = true;
        if (!c.vol.stale || c.sigma == 0) c.sigma = c.vol.sigmaBps; // stale: keep the last sigma
        // usage: open value of the gear over its static cap, at the guard's p and the current NF
        uint256 p = c.r.p == 0 ? c.cfg.p0 : c.r.p;
        (uint256 vBefore,) = ODIndex.value(c.cfg.gear, p, c.cfg.p0, c.nf, c.cfg.unitWad, Math.Rounding.Floor);
        uint256 absNet = c.net >= 0 ? uint256(c.net) : uint256(-c.net);
        uint256 openWad = Math.mulDiv(absNet, vBefore, WAD);
        int256 cur =
            ODToll.perSecond(ODToll.tollPerYear(c.cfg.gear, c.sigma, ODToll.usage(openWad, c.cfg.capUsdWad, usageMax)));
        c.rateNew = cur;
        if (s.lastAccrual == 0) return c; // first touch starts the clock
        c.dt = block.timestamp - s.lastAccrual;
        c.nfNew = ODNorm.step(c.nf, ODToll.gapRate(s.tollPerSecWad, cur), c.dt);
        if (c.nfNew == c.nf) return c;
        int256 tv = ODNorm.tollValue(absNet, vBefore, c.nf, c.nfNew);
        c.tollValue = c.net >= 0 ? tv : -tv;
        if (c.nfNew < c.nf) c.cumAdd = uint256(ODNorm.tollValue(WAD, vBefore, c.nf, c.nfNew));
        if (c.tollValue > 0) c.feeDrain = _feeDrain(d, uint256(c.tollValue));
    }

    /// The Governor's onToll books tollFeeBps of a positive toll and then pays every owed fee from free cash.
    function _feeDrain(Deps memory d, uint256 tollValue) private view returns (uint256) {
        uint256 bps = 1000;
        try IODFees(d.fees).tollFeeBps() returns (uint16 x) {
            if (x <= BPS) bps = x;
        } catch {}
        uint256 fee = tollValue * bps / BPS / USDG_TO_WAD;
        if (fee == 0) return 0;
        uint256 owed = d.governor.feeOwed() + fee;
        uint256 cash = d.governor.freeCash();
        return owed < cash ? owed : cash;
    }

    function _fromPyth(IODOracleGuard guard, bytes32 market) private view returns (bool pyth) {
        (, pyth) = guard.refPrice(market);
    }

    function _vol(IODVolOracle vol, bytes32 key) private view returns (VolReading memory v) {
        try vol.read(key) returns (VolReading memory x) {
            v = x;
        } catch {
            v.stale = true;
            v.hardStale = true;
        }
    }

    // -------------------------------------------------------------------------------------------------- trade

    /// @notice Value basis, spread and amounts of one trade (R4, R5, R7, R8, R11). `amount` is USDG for exact-in buys
    /// and exact-out sells, tokens otherwise. A sell with no safe price returns queued = true: no feed price, no
    /// reference, or (I7-1) a reading that is not live whose only reference is a v3 TWAP.
    function trade(
        Ctx memory c,
        IODMinter.TradeParams memory tp,
        bool isBuy,
        bool exactIn,
        uint256 amount,
        uint16 discountBps
    ) external pure returns (Trade memory t) {
        t.inDomain = true;
        if (c.settled) {
            t.value = c.settledValue; // no spread in any session
        } else {
            uint256 p = c.r.p;
            uint256 ref = c.r.refP;
            if (p == 0 || ref == 0) {
                // Fail closed (ORC-FAILCLOSED): never a price from one source alone. Buys are blocked by the gate.
                t.queued = true;
                return t;
            }
            Math.Rounding rnd = isBuy ? Math.Rounding.Ceil : Math.Rounding.Floor;
            (uint256 vp, bool inP) = ODIndex.value(c.cfg.gear, p, c.cfg.p0, c.nfNew, c.cfg.unitWad, rnd);
            (uint256 vr, bool inR) = ODIndex.value(c.cfg.gear, ref, c.cfg.p0, c.nfNew, c.cfg.unitWad, rnd);
            // Worse of the two VALUES for the trader: higher for a buyer, lower for a seller (REVERSE included).
            t.value = isBuy ? (vp > vr ? vp : vr) : (vp < vr ? vp : vr);
            t.inDomain = inP && inR;
            t.spreadBps = _spread(c, tp, isBuy, exactIn, amount, t.value, discountBps);
        }
        if (t.value == 0) {
            t.queued = !isBuy;
            return t;
        }
        t.price = isBuy
            ? Math.mulDiv(t.value, BPS + t.spreadBps, BPS, Math.Rounding.Ceil)
            : Math.mulDiv(t.value, BPS - t.spreadBps, BPS);
        if (t.price == 0) {
            t.queued = !isBuy;
            return t;
        }
        if (isBuy) {
            if (exactIn) {
                t.usdg = amount;
                t.tokens = Math.mulDiv(amount, SCALE, t.price);
            } else {
                t.tokens = amount;
                t.usdg = Math.mulDiv(amount, t.price, SCALE, Math.Rounding.Ceil);
            }
            uint256 atValue = Math.mulDiv(t.tokens, t.value, SCALE);
            t.spreadUsdg = t.usdg > atValue ? t.usdg - atValue : 0;
        } else {
            if (exactIn) {
                t.tokens = amount;
                t.usdg = Math.mulDiv(amount, t.price, SCALE);
            } else {
                t.usdg = amount;
                t.tokens = Math.mulDiv(amount, SCALE, t.price, Math.Rounding.Ceil);
            }
            uint256 atValue = Math.mulDiv(t.tokens, t.value, SCALE);
            t.spreadUsdg = atValue > t.usdg ? atValue - t.usdg : 0;
        }
    }

    /// base (x extendedSpreadMultBps in EXTENDED) + closedSellExtraBps on a non-live sell + inventory skew (only when
    /// the trade grows |net|, sized at value) less the staking share, capped at maxTotalSpreadBps, never below the lag floor.
    function _spread(
        Ctx memory c,
        IODMinter.TradeParams memory tp,
        bool isBuy,
        bool exactIn,
        uint256 amount,
        uint256 value,
        uint16 discountBps
    ) private pure returns (uint16) {
        uint256 s = c.cfg.spreadBps;
        if (c.r.session == Session.EXTENDED) s = s * tp.extendedSpreadMultBps / BPS;
        if (!isBuy && !c.live) s += tp.closedSellExtraBps;
        // Trade size in tokens at value (no spread): deterministic for quote and execution alike.
        uint256 est = (isBuy == exactIn) ? Math.mulDiv(amount, SCALE, value) : amount;
        int256 netAfter = isBuy ? c.net + int256(est) : c.net - int256(est);
        uint256 absBefore = c.net >= 0 ? uint256(c.net) : uint256(-c.net);
        uint256 absAfter = netAfter >= 0 ? uint256(netAfter) : uint256(-netAfter);
        if (absAfter > absBefore && c.cfg.capUsdWad != 0) {
            uint256 skew = uint256(tp.inventorySlopeBps) * Math.mulDiv(absAfter, value, WAD) / c.cfg.capUsdWad;
            s += skew > tp.maxSkewBps ? tp.maxSkewBps : skew;
        }
        // Staking discount is a SHARE of the spread (ODStake tiers), at most MAX_DISCOUNT_BPS of it; the discount
        // rounds down so a spread above zero stays above zero (M-1).
        uint256 dsc = discountBps > MAX_DISCOUNT_BPS ? MAX_DISCOUNT_BPS : discountBps;
        s -= s * dsc / BPS;
        if (s > tp.maxTotalSpreadBps) s = tp.maxTotalSpreadBps;
        // Lag floor (M-4): neither the feed nor the reference may show a move of up to lagBandBps yet. A round trip
        // across such a move gains at most the gear's value ratio R; paying f per side costs (1+f)/(1-f) >= R when
        // f >= |power| x band / 2 x (1 + |power| x band). Applied last, so no discount, cap or session lowers it.
        // A pair is priced on pA / pB and each leg may hide its own band, so its floor uses both bands (rescore 2).
        uint256 f = lagFloorBps(c.cfg.gear, tp.lagBandBps, c.cfg.marketB != bytes32(0));
        return uint16(s > f ? s : f);
    }

    /// @notice Per-side spread floor, in bps, that makes a buy-then-sell round trip across a price move of up to
    /// `bandBps` (which neither price source shows yet) unprofitable for `gear` (M-4). Rounds up.
    /// `pair`: the gear is priced on the ratio of two markets, each of which may lag by `bandBps` in opposite
    /// directions, so the ratio can hide (1 + b) / (1 - b). The floor is sized on the sum of both legs' bands (2b),
    /// which covers that ratio for every gear and every band from 1 to 300 bps (M-4 pair leg, rescore 2).
    function lagFloorBps(Gear gear, uint256 bandBps, bool pair) internal pure returns (uint256) {
        if (pair) bandBps *= 2;
        uint256 pw = gear == Gear.CRUISE
            ? 15_000
            : gear == Gear.SPORT ? 20_000 : gear == Gear.RACE ? 30_000 : gear == Gear.ECO ? 5_000 : 10_000;
        uint256 m = pw * bandBps; // |power| x band, in bps x BPS
        return Math.mulDiv(m, BPS * BPS + m, 2 * BPS * BPS * BPS, Math.Rounding.Ceil);
    }

    // ------------------------------------------------------------------------------------------------ buy gate

    /// @notice 0 when a buy of `t` may execute (R3); otherwise the reason for BuysClosed.
    function buyGate(Deps memory d, Ctx memory c, Trade memory t) external view returns (bytes32) {
        if (c.cfg.token == address(0)) return "UNKNOWN";
        if (c.settled) return "SETTLED";
        if (c.cfg.status != GearStatus.LISTED) return "STATUS";
        Session s = c.r.session;
        if (s != Session.OPEN && s != Session.EXTENDED) return "CLOSED";
        if (!c.r.fresh) return "STALE";
        if (c.r.buysPaused) return c.r.reason == bytes32(0) ? bytes32("PAUSED") : c.r.reason;
        if (c.r.p == 0 || c.r.refP == 0) return "REF_UNAVAILABLE";
        if (!t.inDomain) return "DOMAIN";
        if (c.vol.hardStale) return "VOL_HARD_STALE";
        if (c.cfg.gear != Gear.ECO) {
            if (_blocked(c.vol)) return "EARNINGS";
            if (c.cfg.marketB != bytes32(0)) {
                if (_blocked(_vol(d.vol, c.cfg.marketA)) || _blocked(_vol(d.vol, c.cfg.marketB))) return "EARNINGS";
            }
        }
        return d.governor.buyBlock(c.id, t.tokens);
    }

    function _blocked(VolReading memory v) private view returns (bool) {
        return v.buyBlockTo != 0 && block.timestamp >= v.buyBlockFrom && block.timestamp < v.buyBlockTo;
    }

    /// @notice Value per token at `p` (or p0 when 0) with NF `nf`, rounded down.
    /// ODBacker's value per token, WAD (here for the backer's code size). `high`: the higher of value(p) and
    /// value(refP), Ceil (debt is never under-valued); otherwise the lower, Floor. `p` 0 reads as p0; `refP` 0 leaves
    /// the feed value alone (the backer decides which actions may run without a reference, I4-3).
    function backerValue(Gear gear, uint256 p0, uint256 unitWad, uint256 nf, uint256 p, uint256 refP, bool high)
        external
        pure
        returns (uint256 v)
    {
        Math.Rounding rnd = high ? Math.Rounding.Ceil : Math.Rounding.Floor;
        (v,) = ODIndex.value(gear, p == 0 ? p0 : p, p0, nf, unitWad, rnd);
        if (refP == 0) return v;
        (uint256 w,) = ODIndex.value(gear, refP, p0, nf, unitWad, rnd);
        v = high ? Math.max(v, w) : Math.min(v, w);
    }

    /// @notice Gear value per token at price `p` (0 means the gear's base price p0) and normalisation factor `nf`.
    /// @return v Value per token in USD WAD (ODIndex.value), rounded down.
    /// @return inDomain False outside the gear's domain (buys blocked, settlement).
    function valueAt(GearConfig memory cfg, uint256 p, uint256 nf) external pure returns (uint256 v, bool inDomain) {
        (v, inDomain) = ODIndex.value(cfg.gear, p == 0 ? cfg.p0 : p, cfg.p0, nf, cfg.unitWad, Math.Rounding.Floor);
    }
}

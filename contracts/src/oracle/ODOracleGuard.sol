// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Session, PriceReading, MarketConfig} from "../interfaces/ODTypes.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";
import {IODOracleGuard} from "../interfaces/IODOracleGuard.sol";
import {ODTwapReader} from "./ODTwapReader.sol";

/// @title ODOracleGuard
/// @notice Every price that moves money comes from here. Chainlink (proxy) is the primary price; Pyth, when fresh,
/// else a Uniswap v3 TWAP, is the reference that decides whether buys may proceed. The guard only reports: nothing
/// here can block a sell. Buys fail closed: no reference, a reference outside the band, a split window, a continuity
/// latch, a halt or a manual pause all set `buysPaused` with a reason.
/// @dev `read` is a view that reverts only on an unknown market. Every external read (feed, Stock Token, Pyth, pool,
/// calendar, sequencer feed) is a gas-capped low-level staticcall with return-length checks, so a broken source
/// degrades to HALTED or "reference unavailable". `poke` (permissionless) is the only function besides the admin
/// setters that changes state. Constructor-initialised, no proxy. DEFAULT_ADMIN_ROLE is the timelock.
contract ODOracleGuard is AccessControl, IODOracleGuard {
    // ------------------------------------------------------------------ constants

    uint32 public constant DEFAULT_MAX_AGE_24H_HEARTBEAT = 26 hours;
    uint32 public constant DEFAULT_MAX_AGE_CLOSED = 5 days;
    uint32 public constant MIN_MAX_AGE_CLOSED = 2 days;
    uint32 public constant MAX_MAX_AGE_CLOSED = 14 days;
    uint16 public constant MAX_REF_BAND_BPS = 2000;
    uint256 public constant SPLIT_CLASS_BPS = 500;
    uint256 public constant MAX_P = 1e33;
    uint256 public constant EXTERNAL_READ_GAS = 300_000;

    uint32 public constant MIN_TWAP_WINDOW = 10 minutes;
    uint32 public constant MAX_TWAP_WINDOW = 1 days;
    uint32 public constant MAX_REF_MAX_AGE = 1 days;
    /// @notice Pyth confidence must be at most 2% of its price to count as a reference.
    uint256 public constant PYTH_MAX_CONF_BPS = 200;
    uint256 public constant SPLIT_LEAD = 24 hours;
    uint256 public constant SPLIT_TAIL = 1 hours;
    uint8 public constant CONFIRMATIONS_TO_CLEAR = 2;
    uint256 public constant MAX_MULTIPLIER = 1e24;
    uint8 public constant MAX_FEED_DECIMALS = 36;
    uint256 public constant SEQUENCER_GRACE = 1 hours;

    bytes32 public constant REASON_MANUAL = "MANUAL";
    bytes32 public constant REASON_DISABLED = "DISABLED";
    bytes32 public constant REASON_SPLIT = "SPLIT_PENDING";
    bytes32 public constant REASON_CONTINUITY = "CONTINUITY";
    bytes32 public constant REASON_HALTED = "HALTED";
    bytes32 public constant REASON_REF_BAND = "REF_BAND";
    bytes32 public constant REASON_REF_UNAVAILABLE = "REF_UNAVAILABLE";

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant DERIVED_HALT_PROBES = 16;
    uint256 private constant DERIVED_HALT_STEP = 6 hours;

    // ------------------------------------------------------------------ storage

    struct MarketState {
        uint128 lastGoodP;
        uint64 lastGoodAt; // feed updatedAt of the last good reading
        uint64 splitPauseUntil; // latched by poke while a split-class change is in its window
        uint128 lastGoodMult; // effective multiplier at the last good reading
        uint128 pendingP; // continuity: the jumped price waiting for confirmation
        uint128 pendingMult;
        uint64 pendingAt; // feed updatedAt of the last counted round
        uint8 confirmations;
        bool manualPaused;
        bool contPaused;
        uint64 haltedSince; // halt latch: only moves earlier, cleared by the next live good reading
    }

    /// @dev Values fixed by setMarket from the feed and the pool, so `read` makes no extra calls for them.
    struct Derived {
        uint8 feedDecimals;
        bool baseIsToken0;
        uint8 scaleExp;
    }

    struct TokenData {
        bool ok;
        bool oraclePaused;
        uint256 ui;
        uint256 pending;
        uint256 effectiveAt;
        uint256 mult;
    }

    /// @dev Everything one evaluation learns; poke uses the extra fields to update state.
    struct Eval {
        PriceReading r;
        Session kind;
        bool live;
        uint256 liveP;
        uint256 feedUpdatedAt;
        uint256 mult;
        bool splitCond;
        uint256 splitUntil;
        bool jump;
        bool fromPyth;
    }

    address public immutable marketHours;
    address public immutable pyth;
    address public immutable sequencerFeed;

    mapping(bytes32 market => MarketConfig) private _cfg;
    mapping(bytes32 market => Derived) private _derived;
    mapping(bytes32 market => MarketState) private _st;

    constructor(address admin, address guardian, address marketHours_, address pyth_, address sequencerFeedOrZero) {
        if (admin == address(0) || guardian == address(0) || marketHours_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ODRoles.GUARDIAN_ROLE, guardian);
        marketHours = marketHours_;
        pyth = pyth_;
        sequencerFeed = sequencerFeedOrZero;
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc IODOracleGuard
    function setMarket(bytes32 market, MarketConfig calldata cfg) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (market == bytes32(0)) revert InvalidConfig();
        if (
            cfg.maxAgeOpen == 0 || (!cfg.alwaysOpen && cfg.maxAgeExtended == 0) || cfg.maxAgeClosed < MIN_MAX_AGE_CLOSED
                || cfg.maxAgeClosed > MAX_MAX_AGE_CLOSED || cfg.refBandBps == 0 || cfg.refBandBps > MAX_REF_BAND_BPS
                || cfg.continuityBps == 0 || cfg.continuityBps > BPS
        ) revert InvalidConfig();
        if (cfg.pythId != bytes32(0) && (pyth == address(0) || cfg.refMaxAge == 0 || cfg.refMaxAge > MAX_REF_MAX_AGE)) {
            revert InvalidConfig();
        }
        if (cfg.stockToken != address(0) && cfg.stockToken.code.length == 0) revert InvalidConfig();

        Derived memory d;
        d.feedDecimals = _validateFeed(cfg.feed);
        if (cfg.twapPool != address(0)) (d.baseIsToken0, d.scaleExp) = _validatePool(cfg);

        _cfg[market] = cfg;
        _derived[market] = d;
        emit MarketSet(market, cfg);
    }

    /// @inheritdoc IODOracleGuard
    /// @dev The guardian (or admin) may pause. Only the admin may unpause; that also clears a continuity latch,
    /// accepting the jumped price as the new last good price.
    function setBuysPaused(bytes32 market, bool paused) external {
        _requireKnown(market);
        MarketState storage st = _st[market];
        if (paused) {
            if (!hasRole(ODRoles.GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
                revert AccessControlUnauthorizedAccount(msg.sender, ODRoles.GUARDIAN_ROLE);
            }
            st.manualPaused = true;
            emit BuysPausedSet(market, true, REASON_MANUAL);
            return;
        }
        _checkRole(DEFAULT_ADMIN_ROLE);
        st.manualPaused = false;
        emit BuysPausedSet(market, false, REASON_MANUAL);
        if (st.contPaused) {
            st.contPaused = false;
            st.confirmations = 0;
            st.lastGoodP = st.pendingP;
            st.lastGoodAt = st.pendingAt;
            st.lastGoodMult = st.pendingMult;
            emit BuysPausedSet(market, false, REASON_CONTINUITY);
            emit LastGoodSet(market, st.pendingP, st.pendingAt);
        }
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IODOracleGuard
    function read(bytes32 market) public view returns (PriceReading memory) {
        return _evaluate(market).r;
    }

    /// @inheritdoc IODOracleGuard
    /// @dev p = pA * 1e18 / pB (rounded down; 0 when pB is 0); refP only when both legs have one; the worse session
    /// (HALTED > UNKNOWN > CLOSED > EXTENDED > OPEN); fresh only when both are; buys paused when either leg is.
    function readRatio(bytes32 a, bytes32 b) external view returns (PriceReading memory r) {
        PriceReading memory ra = read(a);
        PriceReading memory rb = read(b);
        r.p = rb.p == 0 ? 0 : Math.mulDiv(ra.p, WAD, rb.p);
        r.refP = ra.refP == 0 || rb.refP == 0 ? 0 : Math.mulDiv(ra.refP, WAD, rb.refP);
        r.session = uint8(ra.session) >= uint8(rb.session) ? ra.session : rb.session;
        r.fresh = ra.fresh && rb.fresh;
        r.buysPaused = ra.buysPaused || rb.buysPaused;
        r.reason = ra.reason != bytes32(0) ? ra.reason : rb.reason;
        r.updatedAt = ra.updatedAt < rb.updatedAt ? ra.updatedAt : rb.updatedAt;
    }

    /// @inheritdoc IODOracleGuard
    function lastGood(bytes32 market) external view returns (uint256 p, uint64 at) {
        MarketState storage st = _st[market];
        return (st.lastGoodP, st.lastGoodAt);
    }

    /// @inheritdoc IODOracleGuard
    function config(bytes32 market) external view returns (MarketConfig memory) {
        return _cfg[market];
    }

    /// @inheritdoc IODOracleGuard
    function refPrice(bytes32 market) external view returns (uint256 refP, bool fromPyth) {
        Eval memory e = _evaluate(market);
        return (e.r.refP, e.fromPyth);
    }

    /// @inheritdoc IODOracleGuard
    function buysPausedReason(bytes32 market) external view returns (bytes32) {
        return _evaluate(market).r.reason;
    }

    /// @inheritdoc IODOracleGuard
    /// @dev The earlier of poke's latch and the halt derived from the feed's own staleness (no poke needed).
    function haltedSince(bytes32 market) external view returns (uint64) {
        MarketConfig memory cfg = _requireKnown(market);
        uint64 latched = _st[market].haltedSince;
        uint64 derived = _derivedHalt(cfg, _derived[market].feedDecimals);
        if (latched == 0) return derived;
        return derived != 0 && derived < latched ? derived : latched;
    }

    function marketState(bytes32 market) external view returns (MarketState memory) {
        return _st[market];
    }

    function derivedConfig(bytes32 market) external view returns (Derived memory) {
        return _derived[market];
    }

    // ------------------------------------------------------------------ state update

    /// @inheritdoc IODOracleGuard
    function poke(bytes32 market) external returns (PriceReading memory) {
        Eval memory e = _evaluate(market);
        MarketState storage st = _st[market];

        if (e.splitCond && st.splitPauseUntil < e.splitUntil) {
            st.splitPauseUntil = uint64(e.splitUntil);
            emit BuysPausedSet(market, true, REASON_SPLIT);
        }

        if (e.live) {
            if (st.contPaused) {
                if (e.feedUpdatedAt > st.pendingAt) {
                    if (_within(e.liveP, st.pendingP, _cfg[market].continuityBps)) {
                        uint8 c = st.confirmations + 1;
                        st.pendingAt = uint64(e.feedUpdatedAt);
                        emit ContinuityConfirmed(market, c, e.liveP);
                        if (c >= CONFIRMATIONS_TO_CLEAR) {
                            st.contPaused = false;
                            st.confirmations = 0;
                            _setLastGood(market, st, e);
                            emit BuysPausedSet(market, false, REASON_CONTINUITY);
                        } else {
                            st.confirmations = c;
                        }
                    } else {
                        _setPending(st, e);
                    }
                }
            } else if (e.jump) {
                st.contPaused = true;
                _setPending(st, e);
                emit BuysPausedSet(market, true, REASON_CONTINUITY);
            } else {
                _setLastGood(market, st, e);
            }
        } else if (e.r.session == Session.HALTED) {
            // Store the halt start on first sight, in any session, so it never moves later (a later calendar push
            // cannot restart the clock). It only moves earlier, to the feed-derived start; in session with no derived
            // start (issuer pause, sequencer, unreadable token) it starts now.
            uint64 since = st.haltedSince;
            uint64 next = since;
            uint64 der = _derivedHalt(_cfg[market], _derived[market].feedDecimals);
            if (der != 0 && (next == 0 || der < next)) next = der;
            if (next == 0 && (e.kind == Session.OPEN || e.kind == Session.EXTENDED)) next = uint64(block.timestamp);
            if (next != since) {
                st.haltedSince = next;
                emit HaltLatched(market, next);
            }
        }
        return _evaluate(market).r;
    }

    function _setLastGood(bytes32 market, MarketState storage st, Eval memory e) private {
        st.haltedSince = 0;
        st.lastGoodP = uint128(e.liveP);
        st.lastGoodAt = uint64(e.feedUpdatedAt);
        st.lastGoodMult = uint128(e.mult);
        emit LastGoodSet(market, e.liveP, uint64(e.feedUpdatedAt));
    }

    function _setPending(MarketState storage st, Eval memory e) private {
        st.pendingP = uint128(e.liveP);
        st.pendingMult = uint128(e.mult);
        st.pendingAt = uint64(e.feedUpdatedAt);
        st.confirmations = 0;
    }

    // ------------------------------------------------------------------ evaluation

    function _evaluate(bytes32 market) private view returns (Eval memory e) {
        MarketConfig memory cfg = _requireKnown(market);
        MarketState memory st = _st[market];
        Derived memory d = _derived[market];
        e.kind = cfg.alwaysOpen ? Session.OPEN : _sessionKind(block.timestamp);
        bool inSession = e.kind == Session.OPEN || e.kind == Session.EXTENDED;

        TokenData memory t = _readToken(cfg.stockToken);
        e.mult = t.mult;
        bool halted = !t.ok || t.oraclePaused || _sequencerDown();

        // Split-class pending multiplier change: pause buys from effectiveAt - 24 h until effectiveAt + 1 h.
        if (t.ok && t.effectiveAt != 0) {
            uint256 eff = t.effectiveAt;
            bool inWindow = block.timestamp + SPLIT_LEAD >= eff && block.timestamp < eff + SPLIT_TAIL;
            bool afterSwitch = block.timestamp >= eff && block.timestamp < eff + SPLIT_TAIL;
            e.splitCond = (inWindow && t.pending != 0 && _splitClass(t.pending, t.ui))
                || (afterSwitch && st.lastGoodMult != 0 && _splitClass(t.mult, st.lastGoodMult));
            e.splitUntil = eff + SPLIT_TAIL;
        }
        bool splitActive = e.splitCond || block.timestamp < st.splitPauseUntil;

        if (!inSession) {
            // Never a CLOSED price for a feed that was halted in session, or one older than maxAgeClosed.
            if (
                st.haltedSince != 0
                    || (st.lastGoodP != 0 && block.timestamp > uint256(st.lastGoodAt) + cfg.maxAgeClosed)
                    || _derivedHalt(cfg, d.feedDecimals) != 0
            ) halted = true;
        } else {
            uint256 maxAge = e.kind == Session.OPEN ? cfg.maxAgeOpen : cfg.maxAgeExtended;
            (bool valid, uint256 raw, uint256 updatedAt) = _readFeed(cfg.feed, d.feedDecimals);
            if (!valid || block.timestamp - updatedAt > maxAge) halted = true;
            if (!halted) {
                uint256 p = cfg.multiplierEmbedded ? raw : Math.mulDiv(raw, t.mult, WAD);
                if (p == 0 || p > MAX_P) {
                    halted = true;
                } else {
                    e.liveP = p;
                    e.feedUpdatedAt = updatedAt;
                    if (st.lastGoodP != 0 && !_within(p, st.lastGoodP, cfg.continuityBps)) {
                        // Feed and multiplier moved at different instants: never trade on that price.
                        if (_explainedByMultiplier(p, st, t, cfg.continuityBps)) halted = true;
                        else if (!st.contPaused) e.jump = true; // a latched jump is handled by poke's confirmations
                    }
                }
            }
        }

        PriceReading memory r = e.r;
        (r.refP, e.fromPyth) = _reference(cfg, d, t.ok ? t.mult : 0); // 0: no multiplier known
        if (halted) {
            r.session = Session.HALTED;
            r.p = st.lastGoodP;
            r.updatedAt = st.lastGoodAt;
            r.fresh = false;
        } else if (inSession) {
            e.live = true;
            r.session = e.kind;
            r.p = e.liveP;
            r.updatedAt = uint64(e.feedUpdatedAt);
            r.fresh = true;
        } else {
            r.session = e.kind; // CLOSED or UNKNOWN
            r.p = st.lastGoodP;
            r.updatedAt = st.lastGoodAt;
            r.fresh = st.lastGoodP != 0;
        }

        // Fail closed for buys: a live reading needs a reference inside the band. Neither check touches p, session
        // or fresh, and a missing reference never skips the check.
        bytes32 refReason;
        if (e.live) {
            if (r.refP == 0) refReason = REASON_REF_UNAVAILABLE;
            else if (!_within(r.p, r.refP, cfg.refBandBps)) refReason = REASON_REF_BAND;
        }

        if (!cfg.enabled) r.reason = REASON_DISABLED;
        else if (st.manualPaused) r.reason = REASON_MANUAL;
        else if (st.contPaused || e.jump) r.reason = REASON_CONTINUITY;
        else if (splitActive) r.reason = REASON_SPLIT;
        else if (halted) r.reason = REASON_HALTED;
        else r.reason = refReason;
        r.buysPaused = r.reason != bytes32(0);
    }

    /// @dev A jump is explained when p moved by the ratio of a split-class multiplier change: the pending pair
    /// (uiMultiplier to newUIMultiplier) or the change since the last good reading.
    function _explainedByMultiplier(uint256 p, MarketState memory st, TokenData memory t, uint256 bps)
        private
        pure
        returns (bool)
    {
        uint256 ratio = Math.mulDiv(p, WAD, st.lastGoodP);
        if (t.pending != 0 && _splitClass(t.pending, t.ui)) {
            if (_within(ratio, Math.mulDiv(t.pending, WAD, t.ui), bps)) return true;
            if (_within(ratio, Math.mulDiv(t.ui, WAD, t.pending), bps)) return true;
        }
        uint256 prev = st.lastGoodMult;
        if (prev != 0 && _splitClass(t.mult, prev)) {
            if (_within(ratio, Math.mulDiv(t.mult, WAD, prev), bps)) return true;
            if (_within(ratio, Math.mulDiv(prev, WAD, t.mult), bps)) return true;
        }
        return false;
    }

    /// @dev |a - b| <= b * bps / 1e4.
    function _within(uint256 a, uint256 b, uint256 bps) private pure returns (bool) {
        uint256 diff = a > b ? a - b : b - a;
        return diff * BPS <= b * bps;
    }

    /// @dev True when `next` differs from `current` by more than SPLIT_CLASS_BPS of `current`.
    function _splitClass(uint256 next, uint256 current) private pure returns (bool) {
        uint256 diff = next > current ? next - current : current - next;
        return diff * BPS > current * SPLIT_CLASS_BPS;
    }

    function _requireKnown(bytes32 market) private view returns (MarketConfig memory cfg) {
        cfg = _cfg[market];
        if (cfg.feed == address(0)) revert MarketUnknown(market);
    }

    // ------------------------------------------------------------------ setMarket validation

    /// @dev The feed must be a Chainlink proxy: it has code, `aggregator()` names a different contract with code, and
    /// `decimals()` is at most 36. An aggregator address passed directly fails the `aggregator()` check.
    function _validateFeed(address feed) private view returns (uint8) {
        if (feed == address(0) || feed.code.length == 0) revert InvalidConfig();
        (bool okA, uint256 agg) = _staticWord(feed, abi.encodeWithSignature("aggregator()"));
        if (!okA || agg == 0 || agg > type(uint160).max) revert InvalidConfig();
        address aggregator = address(uint160(agg));
        if (aggregator == feed || aggregator.code.length == 0) revert InvalidConfig();
        (bool okD, uint256 dec) = _staticWord(feed, abi.encodeWithSignature("decimals()"));
        if (!okD || dec > MAX_FEED_DECIMALS) revert InvalidConfig();
        return uint8(dec);
    }

    /// @dev The pool must hold the Stock Token on exactly one side; both tokens' decimals fix the price scale.
    function _validatePool(MarketConfig calldata cfg) private view returns (bool baseIsToken0, uint8 scaleExp) {
        if (
            cfg.stockToken == address(0) || cfg.twapPool.code.length == 0 || cfg.twapWindow < MIN_TWAP_WINDOW
                || cfg.twapWindow > MAX_TWAP_WINDOW
        ) revert InvalidConfig();
        (bool ok0, uint256 t0) = _staticWord(cfg.twapPool, abi.encodeWithSignature("token0()"));
        (bool ok1, uint256 t1) = _staticWord(cfg.twapPool, abi.encodeWithSignature("token1()"));
        if (!ok0 || !ok1) revert InvalidConfig();
        baseIsToken0 = address(uint160(t0)) == cfg.stockToken;
        if (baseIsToken0 == (address(uint160(t1)) == cfg.stockToken)) revert InvalidConfig(); // neither, or both
        address quote = address(uint160(baseIsToken0 ? t1 : t0));
        (bool okB, uint256 bd) = _staticWord(cfg.stockToken, abi.encodeWithSignature("decimals()"));
        (bool okQ, uint256 qd) = _staticWord(quote, abi.encodeWithSignature("decimals()"));
        if (!okB || !okQ || bd > 36 || qd > 36 || 18 + bd < qd || 18 + bd - qd > 60) revert InvalidConfig();
        scaleExp = uint8(18 + bd - qd);
    }

    // ------------------------------------------------------------------ external reads (never revert)

    function _sessionKind(uint256 ts) private view returns (Session) {
        (bool ok, uint256 v) = _staticWord(marketHours, abi.encodeWithSignature("kindAt(uint256)", ts));
        // The calendar never reports HALTED; anything out of range is UNKNOWN.
        if (!ok || v > uint256(Session.UNKNOWN)) return Session.UNKNOWN;
        return Session(v);
    }

    function _readToken(address token) private view returns (TokenData memory t) {
        if (token == address(0)) {
            // ETH, BTC: no Stock Token, no multiplier.
            t.ok = true;
            t.ui = WAD;
            t.mult = WAD;
            return t;
        }
        bool ok1;
        bool ok2;
        bool ok3;
        bool ok4;
        uint256 paused;
        (ok1, t.ui) = _staticWord(token, abi.encodeWithSignature("uiMultiplier()"));
        (ok2, t.pending) = _staticWord(token, abi.encodeWithSignature("newUIMultiplier()"));
        (ok3, t.effectiveAt) = _staticWord(token, abi.encodeWithSignature("effectiveAt()"));
        (ok4, paused) = _staticWord(token, abi.encodeWithSignature("oraclePaused()"));
        t.oraclePaused = paused != 0; // any non-zero word (including a malformed bool) counts as paused
        // Effective multiplier: the pending one once effectiveAt has passed (whether or not the token's uiMultiplier()
        // switches by itself at effectiveAt).
        t.mult = (t.effectiveAt != 0 && block.timestamp >= t.effectiveAt && t.pending != 0) ? t.pending : t.ui;
        t.ok = ok1 && ok2 && ok3 && ok4 && t.ui != 0 && t.ui <= MAX_MULTIPLIER && t.pending <= MAX_MULTIPLIER
            && t.mult != 0;
    }

    /// @dev The halt start derived from the feed alone, so the latch and any settle clock do not depend on a poke.
    /// The latest round is stale in session from updatedAt + maxAge on; the first such moment the calendar puts in
    /// session (probing that instant and every 6 h after it for 4 days) is the start. For a 24/7 market that is
    /// updatedAt + maxAgeOpen + 1. 0 = not stale in session so far, or unreadable (then only poke's latch applies).
    function _derivedHalt(MarketConfig memory cfg, uint8 decimals_) private view returns (uint64) {
        (bool valid,, uint256 updatedAt) = _readFeed(cfg.feed, decimals_);
        if (!valid) return 0;
        if (cfg.alwaysOpen) {
            uint256 s = updatedAt + uint256(cfg.maxAgeOpen) + 1;
            return s <= block.timestamp ? uint64(s) : 0;
        }
        uint256 t = updatedAt + Math.max(cfg.maxAgeOpen, cfg.maxAgeExtended) + 1;
        for (uint256 k; k < DERIVED_HALT_PROBES && t <= block.timestamp; ++k) {
            Session kind = _sessionKind(t);
            if (kind == Session.OPEN || kind == Session.EXTENDED) return uint64(t);
            t += DERIVED_HALT_STEP;
        }
        return 0;
    }

    /// @return valid answer > 0, updatedAt in (0, now] (future-dated rejected), scaled answer within MAX_P
    /// @return raw answer scaled to WAD (multiplier not applied)
    /// @return updatedAt the round's updatedAt
    function _readFeed(address feed, uint8 decimals_)
        private
        view
        returns (bool valid, uint256 raw, uint256 updatedAt)
    {
        (bool ok, bytes memory data) = feed.staticcall{gas: EXTERNAL_READ_GAS}(
            abi.encodeWithSignature("latestRoundData()")
        );
        if (!ok || data.length < 160) return (false, 0, 0);
        int256 answer;
        assembly ("memory-safe") {
            answer := mload(add(data, 64))
            updatedAt := mload(add(data, 128))
        }
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0, 0);
        uint256 a = uint256(answer);
        if (decimals_ <= 18) {
            uint256 factor = 10 ** (18 - decimals_);
            if (a > MAX_P / factor) return (false, 0, updatedAt);
            raw = a * factor;
        } else {
            raw = a / 10 ** (decimals_ - 18);
            if (raw == 0 || raw > MAX_P) return (false, 0, updatedAt);
        }
        valid = true;
    }

    /// @dev Reference price: Pyth when configured, published within refMaxAge (not in the future) and conf/price at
    /// most 2%; else the v3 TWAP when the pool's history covers the window; else 0. Never spot.
    function _reference(MarketConfig memory cfg, Derived memory d, uint256 mult)
        private
        view
        returns (uint256 refP, bool fromPyth)
    {
        if (cfg.pythId != bytes32(0)) {
            refP = _pythPrice(cfg, mult);
            if (refP != 0) return (refP, true);
        }
        if (cfg.twapPool != address(0)) {
            refP = ODTwapReader.price(
                ODTwapReader.Source({
                    pool: cfg.twapPool, window: cfg.twapWindow, baseIsToken0: d.baseIsToken0, scaleExp: d.scaleExp
                }),
                MAX_P
            );
        }
    }

    function _pythPrice(MarketConfig memory cfg, uint256 mult) private view returns (uint256 v) {
        if (pyth == address(0)) return 0;
        (bool ok, bytes memory data) =
            pyth.staticcall{gas: EXTERNAL_READ_GAS}(abi.encodeWithSignature("getPriceUnsafe(bytes32)", cfg.pythId));
        // Price { int64 price; uint64 conf; int32 expo; uint256 publishTime } = 4 words.
        if (!ok || data.length < 128) return 0;
        int256 price;
        uint256 conf;
        int256 expo;
        uint256 publishTime;
        assembly ("memory-safe") {
            price := mload(add(data, 32))
            conf := mload(add(data, 64))
            expo := mload(add(data, 96))
            publishTime := mload(add(data, 128))
        }
        if (price <= 0 || price != int256(int64(price)) || conf > type(uint64).max) return 0;
        if (expo != int256(int32(expo)) || expo > 0 || expo < -36) return 0;
        if (publishTime > block.timestamp || block.timestamp - publishTime > cfg.refMaxAge) return 0;
        uint256 pr = uint256(price);
        if (conf * BPS > pr * PYTH_MAX_CONF_BPS) return 0;
        uint256 e = uint256(-expo);
        v = e <= 18 ? pr * 10 ** (18 - e) : pr / 10 ** (e - 18);
        if (!cfg.pythMultiplierEmbedded) {
            if (mult == 0) return 0; // unreadable Stock Token: a per-share price cannot be converted
            v = Math.mulDiv(v, mult, WAD); // Pyth prices one share
        }
        if (v > MAX_P) return 0;
    }

    /// @dev Optional L2 sequencer uptime feed (none exists on 4663): down, unreadable or inside the grace period halts.
    function _sequencerDown() private view returns (bool) {
        address feed = sequencerFeed;
        if (feed == address(0)) return false;
        (bool ok, bytes memory data) =
            feed.staticcall{gas: EXTERNAL_READ_GAS}(abi.encodeWithSignature("latestRoundData()"));
        if (!ok || data.length < 160) return true;
        int256 answer;
        uint256 startedAt;
        assembly ("memory-safe") {
            answer := mload(add(data, 64))
            startedAt := mload(add(data, 96))
        }
        if (answer != 0 || startedAt == 0 || startedAt > block.timestamp) return true;
        return block.timestamp - startedAt < SEQUENCER_GRACE;
    }

    function _staticWord(address target, bytes memory callData) private view returns (bool ok, uint256 value) {
        if (target.code.length == 0) return (false, 0);
        bytes memory data;
        (ok, data) = target.staticcall{gas: EXTERNAL_READ_GAS}(callData);
        if (!ok || data.length < 32) return (false, 0);
        assembly ("memory-safe") {
            value := mload(add(data, 32))
        }
    }
}

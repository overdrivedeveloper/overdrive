// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Session} from "../interfaces/ODTypes.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";
import {IODMarketHours, SessionWindow, Holiday} from "../interfaces/IODMarketHours.sol";
import {ODCalendar} from "./ODCalendar.sol";

/// @title ODMarketHours
/// @notice Keeper-pushed US equity sessions with kinds (OPEN or EXTENDED), plus an admin-enabled on-chain fallback
/// calendar. The oracle guard asks it which session a timestamp is in; it never reports HALTED.
/// @dev When the pushed calendar covers a timestamp ([first open, last close)) it is authoritative: inside a session
/// its kind, in a gap CLOSED. Outside that range the fallback calendar answers when enabled, else UNKNOWN. The stock
/// feeds print 24/5, so the keeper pushes one OPEN or EXTENDED window per trading week (Sunday 20:00 ET to Friday
/// 20:00 ET, split where it wants); each window must be shorter than 7 days and may not cover calendar-CLOSED time
/// (L-9). Constructor-initialised, no proxy.
contract ODMarketHours is AccessControl, IODMarketHours {
    uint256 public constant MAX_SESSIONS = 64;
    uint256 public constant MAX_SESSION_LENGTH = 7 days - 1;
    uint256 public constant MAX_HORIZON = 30 days;
    /// I4-5: the longest CLOSED stretch the keeper can write between two pushed windows (a long weekend is under 4 days).
    uint256 public constant MAX_SESSION_GAP = 5 days;
    /// @notice Most boundaries `nextLongClose` walks (about four per day, so well over a month).
    uint256 public constant MAX_SCAN_STEPS = 256;
    /// @notice How far ahead `nextLongClose` looks.
    uint256 public constant SCAN_HORIZON = 45 days;

    SessionWindow[] private _sessions;
    Session[] private _kinds;
    Holiday[] private _holidays;
    bool private _fallbackEnabled;

    constructor(address admin, address keeper) {
        if (admin == address(0) || keeper == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ODRoles.KEEPER_ROLE, keeper);
    }

    /// @inheritdoc IODMarketHours
    function setSessionsWithKinds(SessionWindow[] calldata s, Session[] calldata kinds)
        external
        onlyRole(ODRoles.KEEPER_ROLE)
    {
        uint256 count = s.length;
        if (kinds.length != count) revert SessionKindsLength(count, kinds.length);
        if (count > MAX_SESSIONS) revert TooManySessions(count);
        for (uint256 i; i < count; ++i) {
            if (kinds[i] != Session.OPEN && kinds[i] != Session.EXTENDED) revert InvalidSessionKind(i);
            SessionWindow calldata w = s[i];
            if (w.close <= w.open) revert InvalidSession(i);
            if (uint256(w.close) - uint256(w.open) > MAX_SESSION_LENGTH) revert SessionTooLong(i);
            _checkCalendar(i, w.open, w.close);
            if (i != 0) {
                if (w.open < s[i - 1].open) revert SessionsUnsorted(i);
                if (w.open < s[i - 1].close) revert SessionsOverlap(i);
                if (uint256(w.open) - uint256(s[i - 1].close) > MAX_SESSION_GAP) revert SessionGapTooLong(i);
            }
        }
        if (count != 0 && uint256(s[count - 1].close) > block.timestamp + MAX_HORIZON) revert SessionTooFar(count - 1);

        delete _sessions;
        delete _kinds;
        for (uint256 i; i < count; ++i) {
            _sessions.push(s[i]);
            _kinds.push(kinds[i]);
        }
        emit SessionsUpdated(count, count == 0 ? 0 : s[0].open, count == 0 ? 0 : s[count - 1].close);
    }

    /// @inheritdoc IODMarketHours
    /// @dev Strictly ascending by Eastern day, at most 64 entries, an early close strictly inside the regular session.
    function setHolidays(Holiday[] calldata h) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 count = h.length;
        if (count > ODCalendar.MAX_HOLIDAYS) revert TooManyHolidays(count);
        for (uint256 i; i < count; ++i) {
            uint256 close = h[i].closeMinute;
            if (close != 0 && (close <= ODCalendar.REGULAR_OPEN || close >= ODCalendar.REGULAR_CLOSE)) {
                revert InvalidHoliday(i);
            }
            if (i != 0 && h[i].day <= h[i - 1].day) revert HolidaysUnsorted(i);
        }
        delete _holidays;
        for (uint256 i; i < count; ++i) {
            _holidays.push(h[i]);
        }
        emit HolidaysUpdated(count);
    }

    /// @inheritdoc IODMarketHours
    function setFallbackEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _fallbackEnabled = enabled;
        emit FallbackEnabledSet(enabled);
    }

    /// @inheritdoc IODMarketHours
    function kindAt(uint256 ts) public view returns (Session) {
        uint256 count = _sessions.length;
        if (count != 0 && ts >= _sessions[0].open && ts < _sessions[count - 1].close) {
            uint256 i = _lastOpenAtOrBefore(ts); // >= 1 because ts >= first open
            if (ts < _sessions[i - 1].close) return _kinds[i - 1];
            return Session.CLOSED;
        }
        if (_fallbackEnabled) return ODCalendar.kindAt(ts, _holidays);
        return Session.UNKNOWN;
    }

    /// @inheritdoc IODMarketHours
    /// @dev Walks session boundaries forward from `ts` and returns the first CLOSED stretch of at least
    /// `minClosedSeconds`. When `ts` is already inside a closed stretch, `closeAt` is `ts`. (0, 0) when none is found
    /// within SCAN_HORIZON, or the walk reaches UNKNOWN time (no calendar) first.
    function nextLongClose(uint256 ts, uint256 minClosedSeconds)
        external
        view
        returns (uint64 closeAt, uint64 reopenAt)
    {
        uint256 limit = ts + SCAN_HORIZON;
        Session k = kindAt(ts);
        if (k == Session.UNKNOWN) return (0, 0);
        bool inClosed = k == Session.CLOSED;
        uint256 start = ts;
        uint256 t = ts;
        for (uint256 step; step < MAX_SCAN_STEPS; ++step) {
            uint256 b = _nextBoundary(t);
            if (b == 0 || b > limit) break;
            k = kindAt(b);
            if (k == Session.UNKNOWN) break;
            if (k == Session.CLOSED) {
                if (!inClosed) {
                    inClosed = true;
                    start = b;
                }
            } else if (inClosed) {
                if (b - start >= minClosedSeconds) return (uint64(start), uint64(b));
                inClosed = false;
            }
            t = b;
        }
        return (0, 0);
    }

    /// @inheritdoc IODMarketHours
    /// @dev Walks the boundaries from `from` to `to`. Inside the pushed range the pushed windows answer. Outside it
    /// (the keeper drops past windows at every push) the built-in calendar answers whether or not the fallback is
    /// enabled, so last weekend is still a weekend after the keeper has dropped it and a quiet mid-week stretch
    /// before the first pushed window is not mistaken for a close. Time neither calendar knows counts as out of
    /// session. Fails closed (true) when the walk needs more than MAX_SCAN_STEPS boundaries.
    function closedBetween(uint256 from, uint256 to, uint256 minClosedSeconds) external view returns (bool) {
        if (to <= from) return false;
        uint256 t = from;
        uint256 start = from;
        bool out = _outAt(from);
        for (uint256 step; step < MAX_SCAN_STEPS; ++step) {
            uint256 b = _edgeAfter(t);
            if (b == 0 || b > to) b = to;
            if (out && b - start >= minClosedSeconds) return true;
            if (b == to) return false;
            bool o = _outAt(b);
            if (o && !out) start = b;
            out = o;
            t = b;
        }
        return true;
    }

    /// @dev Out of session at `ts` for closedBetween: the pushed windows inside their range, else the built-in
    /// calendar (always, unlike kindAt).
    function _outAt(uint256 ts) private view returns (bool) {
        uint256 count = _sessions.length;
        Session k = count != 0 && ts >= _sessions[0].open && ts < _sessions[count - 1].close
            ? kindAt(ts)
            : ODCalendar.kindAt(ts, _holidays);
        return k != Session.OPEN && k != Session.EXTENDED;
    }

    /// @dev First instant after `t` where `_outAt` may change: a pushed open or close inside the pushed range, else
    /// the earlier of the first pushed open and the built-in calendar's next boundary. 0 = none.
    function _edgeAfter(uint256 t) private view returns (uint256 next) {
        uint256 count = _sessions.length;
        if (count != 0 && t < _sessions[count - 1].close) {
            uint256 i = _lastOpenAtOrBefore(t);
            if (i != 0 && t < _sessions[i - 1].close) return _sessions[i - 1].close;
            next = _sessions[i].open;
            if (i != 0) return next;
        }
        uint256 fb = ODCalendar.nextBoundary(t, _holidays);
        if (fb != 0 && (next == 0 || fb < next)) next = fb;
    }

    /// @inheritdoc IODMarketHours
    function sessions() external view returns (SessionWindow[] memory) {
        return _sessions;
    }

    /// @inheritdoc IODMarketHours
    function sessionKinds() external view returns (Session[] memory) {
        return _kinds;
    }

    /// @inheritdoc IODMarketHours
    function holidays() external view returns (Holiday[] memory) {
        return _holidays;
    }

    /// @inheritdoc IODMarketHours
    function fallbackEnabled() external view returns (bool) {
        return _fallbackEnabled;
    }

    /// @dev L-9: a pushed window wins over the calendar, so the keeper key alone must not be able to open time the
    /// built-in calendar calls CLOSED (the weekend from Friday 20:00 to Sunday 20:00 Eastern, a listed full holiday).
    /// Walks the calendar's own boundaries across [open, close); its kind is constant between two boundaries. Time
    /// outside the supported years is UNKNOWN to the calendar and stays the keeper's call.
    function _checkCalendar(uint256 i, uint256 open, uint256 close) private view {
        uint256 t = open;
        while (t < close) {
            if (ODCalendar.kindAt(t, _holidays) == Session.CLOSED) revert SessionCoversClosed(i, t);
            uint256 next = ODCalendar.nextBoundary(t, _holidays);
            if (next == 0) return;
            t = next;
        }
    }

    /// @dev Number of sessions whose open is <= ts (binary search; sessions are sorted and disjoint).
    function _lastOpenAtOrBefore(uint256 ts) private view returns (uint256 low) {
        uint256 high = _sessions.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (_sessions[mid].open <= ts) low = mid + 1;
            else high = mid;
        }
    }

    /// @dev First instant after t where kindAt may change: the next pushed open or close, else a fallback boundary.
    function _nextBoundary(uint256 t) private view returns (uint256 next) {
        uint256 count = _sessions.length;
        if (count != 0 && t < _sessions[count - 1].close) {
            uint256 i = _lastOpenAtOrBefore(t);
            if (i != 0 && t < _sessions[i - 1].close) return _sessions[i - 1].close;
            next = _sessions[i].open; // i < count: t is before the last close and not inside session i-1
            if (i == 0 && _fallbackEnabled) {
                // Before the pushed range the fallback answers, so its own boundaries count too.
                uint256 fb = ODCalendar.nextBoundary(t, _holidays);
                if (fb != 0 && fb < next) next = fb;
            }
            return next;
        }
        if (_fallbackEnabled) return ODCalendar.nextBoundary(t, _holidays);
        return 0;
    }
}

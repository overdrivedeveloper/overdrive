// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Session} from "../interfaces/ODTypes.sol";
import {Holiday} from "../interfaces/IODMarketHours.sol";

/// @title ODCalendar
/// @notice On-chain fallback calendar for US equity sessions, used only when no keeper-pushed calendar covers a time.
/// @dev Eastern time uses the US daylight-saving rules for 2026 to 2028 as fixed transition instants; any timestamp
/// outside [SUPPORTED_FROM, SUPPORTED_TO) is UNKNOWN. Holidays come from the admin-set list (closeMinute 0 = closed
/// all day, otherwise an early close at that Eastern minute, 780 = 13:00).
///
/// The Robinhood Chain stock feeds print overnight (24/5, verified 2026-11-13), so on a trading day D (Mon-Fri and
/// not a full holiday), in Eastern time:
///   overnight  20:00 on D-1 to 04:00 on D          -> EXTENDED
///   pre-market 04:00 to 09:30                      -> EXTENDED
///   regular    09:30 to 16:00 (or the early close) -> OPEN
///   post       16:00 (or the early close) to 20:00 -> EXTENDED
/// Everything else is CLOSED. The overnight window belongs to the trading day it leads into, so the week runs from
/// Sunday 20:00 to Friday 20:00 and the evening before a full holiday is CLOSED.
library ODCalendar {
    uint256 internal constant SUPPORTED_FROM = 1_767_225_600; // 2026-01-01T00:00:00Z
    uint256 internal constant SUPPORTED_TO = 1_861_920_000; // 2029-01-01T00:00:00Z

    // DST start (second Sunday of March, 02:00 EST = 07:00Z) and end (first Sunday of November, 02:00 EDT = 06:00Z).
    uint256 internal constant DST_START_2026 = 1_772_953_200; // 2026-03-08T07:00:00Z
    uint256 internal constant DST_END_2026 = 1_793_512_800; // 2026-11-01T06:00:00Z
    uint256 internal constant DST_START_2027 = 1_805_007_600; // 2027-03-14T07:00:00Z
    uint256 internal constant DST_END_2027 = 1_825_567_200; // 2027-11-07T06:00:00Z
    uint256 internal constant DST_START_2028 = 1_836_457_200; // 2028-03-12T07:00:00Z
    uint256 internal constant DST_END_2028 = 1_857_016_800; // 2028-11-05T06:00:00Z

    uint256 internal constant EST_OFFSET = 5 hours;
    uint256 internal constant EDT_OFFSET = 4 hours;

    uint256 internal constant OVERNIGHT_END = 4 * 60; // 04:00
    uint256 internal constant REGULAR_OPEN = 9 * 60 + 30; // 09:30
    uint256 internal constant REGULAR_CLOSE = 16 * 60; // 16:00
    uint256 internal constant EXTENDED_END = 20 * 60; // 20:00

    uint256 internal constant MAX_HOLIDAYS = 64;

    /// @notice True when the timestamp falls inside the years the fallback calendar knows.
    function supported(uint256 ts) internal pure returns (bool) {
        return ts >= SUPPORTED_FROM && ts < SUPPORTED_TO;
    }

    /// @notice Seconds to subtract from UTC to get US Eastern local time. Caller must check `supported(ts)`.
    function etOffset(uint256 ts) internal pure returns (uint256) {
        if (
            (ts >= DST_START_2026 && ts < DST_END_2026) || (ts >= DST_START_2027 && ts < DST_END_2027)
                || (ts >= DST_START_2028 && ts < DST_END_2028)
        ) return EDT_OFFSET;
        return EST_OFFSET;
    }

    /// @notice Eastern local day number (days since 1970-01-01) and minute of that day. Caller must check support.
    function localDayMinute(uint256 ts) internal pure returns (uint256 day, uint256 minute) {
        uint256 local = ts - etOffset(ts);
        day = local / 1 days;
        minute = (local % 1 days) / 1 minutes;
    }

    /// @notice 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday.
    function dayOfWeek(uint256 day) internal pure returns (uint256) {
        return (day + 4) % 7;
    }

    /// @notice Regular-session close minute for `day`, or 0 when the market is closed all day (weekend or holiday).
    /// @dev R8-2: a binary search over the sorted list (at most 7 reads for MAX_HOLIDAYS entries), so the cost of a
    /// calendar walk does not grow with the number of past holidays listed.
    function closeMinuteOf(uint256 day, Holiday[] storage holidays) internal view returns (uint256) {
        uint256 dow = dayOfWeek(day);
        if (dow == 0 || dow == 6) return 0;
        uint256 low;
        uint256 high = holidays.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            Holiday storage h = holidays[mid];
            uint256 d = h.day;
            if (d == day) return h.closeMinute; // 0 = full holiday
            if (d < day) low = mid + 1;
            else high = mid;
        }
        return REGULAR_CLOSE;
    }

    /// @notice Session kind at `ts` from the fallback calendar. UNKNOWN outside the supported years.
    function kindAt(uint256 ts, Holiday[] storage holidays) internal view returns (Session) {
        if (!supported(ts)) return Session.UNKNOWN;
        (uint256 day, uint256 minute) = localDayMinute(ts);

        if (minute >= EXTENDED_END) {
            // Overnight window leading into the next day.
            return closeMinuteOf(day + 1, holidays) == 0 ? Session.CLOSED : Session.EXTENDED;
        }
        uint256 close = closeMinuteOf(day, holidays);
        if (close == 0) return Session.CLOSED;
        if (minute < REGULAR_OPEN) return Session.EXTENDED; // overnight tail (00:00-04:00) and pre-market
        if (minute < close) return Session.OPEN;
        return Session.EXTENDED; // post-market until 20:00
    }

    /// @notice The first instant after `ts` at which the fallback kind may change (0 = none: past SUPPORTED_TO).
    /// @dev Candidates are the local 09:30, the day's close, 20:00 and midnight, every DST switch and the supported
    /// range edges. A candidate computed with the pre-switch offset is never past the switch itself, so the next call
    /// (after the switch) uses the right offset.
    function nextBoundary(uint256 ts, Holiday[] storage holidays) internal view returns (uint256 next) {
        if (ts < SUPPORTED_FROM) return SUPPORTED_FROM;
        if (ts >= SUPPORTED_TO) return 0;
        uint256 off = etOffset(ts);
        (uint256 day, uint256 minute) = localDayMinute(ts);
        uint256 close = closeMinuteOf(day, holidays);
        uint256 m = 1 days / 1 minutes; // midnight of the next local day
        if (minute < REGULAR_OPEN) m = REGULAR_OPEN;
        else if (close != 0 && minute < close) m = close;
        else if (minute < EXTENDED_END) m = EXTENDED_END;
        next = day * 1 days + m * 1 minutes + off;
        uint256[7] memory edges =
            [DST_START_2026, DST_END_2026, DST_START_2027, DST_END_2027, DST_START_2028, DST_END_2028, SUPPORTED_TO];
        for (uint256 i; i < 7; ++i) {
            if (edges[i] > ts && edges[i] < next) next = edges[i];
        }
    }
}

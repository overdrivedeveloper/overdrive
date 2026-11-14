// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./ODTypes.sol";

struct SessionWindow {
    uint64 open;
    uint64 close;
}

struct Holiday {
    uint32 day; // closeMinute 0 = closed all day (port of the calendar's struct)
    uint16 closeMinute;
}

interface IODMarketHours {
    /// @notice Emitted when the session schedule is replaced.
    /// @param count The number of entries.
    /// @param firstOpen Timestamp of the first open.
    /// @param lastClose Timestamp of the last close.
    event SessionsUpdated(uint256 count, uint64 firstOpen, uint64 lastClose);
    /// @notice Emitted when the holiday list is replaced.
    /// @param count The number of entries.
    event HolidaysUpdated(uint256 count);
    /// @notice Emitted when the fallback schedule is enabled or disabled.
    /// @param enabled True to enable, false to disable.
    event FallbackEnabledSet(bool enabled);
    /// @notice Reverts when more sessions are supplied than allowed.
    /// @param count The number of entries.
    error TooManySessions(uint256 count);
    /// @notice Reverts when a session window is malformed.
    /// @param index Index into the list.
    error InvalidSession(uint256 index);
    /// @notice Reverts when sessions are not sorted by time.
    /// @param index Index into the list.
    error SessionsUnsorted(uint256 index);
    /// @notice Reverts when sessions overlap.
    /// @param index Index into the list.
    error SessionsOverlap(uint256 index);
    /// @notice Reverts when the number of kinds differs from the number of sessions.
    /// @param sessions Number of sessions.
    /// @param kinds Session kinds, one per window.
    error SessionKindsLength(uint256 sessions, uint256 kinds);
    /// @notice Reverts when more holidays are supplied than allowed.
    /// @param count The number of entries.
    error TooManyHolidays(uint256 count);
    /// @notice Reverts when holidays are not sorted by day.
    /// @param index Index into the list.
    error HolidaysUnsorted(uint256 index);
    /// @notice Reverts when a session is longer than allowed.
    /// @param index Index into the list.
    error SessionTooLong(uint256 index);
    /// @notice Reverts when a session starts too far ahead.
    /// @param index Index into the list.
    error SessionTooFar(uint256 index);
    /// @notice Reverts when a session kind is not allowed.
    /// @param index Index into the list.
    error InvalidSessionKind(uint256 index);
    /// @notice Reverts when a session window covers time the built-in calendar calls CLOSED (a weekend or a listed
    /// full holiday), L-9.
    /// @param index Index into the list.
    /// @param closedAt First calendar-closed instant inside the window.
    error SessionCoversClosed(uint256 index, uint256 closedAt);
    /// @notice Reverts when a holiday entry is invalid.
    /// @param index Index into the list.
    error InvalidHoliday(uint256 index);
    /// @notice Reverts when an address argument is zero.
    error ZeroAddress();
    /// @notice Replaces the session schedule and the kind of each session.
    /// @dev Keeper only. Reverts on malformed, unsorted, overlapping, too long, too distant or mismatched input, and on a
    /// window that covers time the built-in calendar calls CLOSED (L-9).
    /// @param s Session windows, sorted and non-overlapping.
    /// @param kinds Session kinds, one per window.
    function setSessionsWithKinds(SessionWindow[] calldata s, Session[] calldata kinds) external; // KEEPER
    /// @notice Replaces the holiday list.
    /// @dev Admin only. Reverts with TooManyHolidays, HolidaysUnsorted or InvalidHoliday.
    /// @param h Holiday entries, sorted by day.
    function setHolidays(Holiday[] calldata h) external; // admin
    /// @notice Enables or disables the fallback schedule.
    /// @dev Admin only.
    /// @param enabled True to enable, false to disable.
    function setFallbackEnabled(bool enabled) external; // admin
    /// @notice Returns the session kind at a timestamp.
    /// @param ts Unix timestamp in seconds.
    /// @return  OPEN, EXTENDED, CLOSED or UNKNOWN; never HALTED.
    function kindAt(uint256 ts) external view returns (Session); // OPEN/EXTENDED/CLOSED/UNKNOWN, never HALTED
    /// @notice Returns the next close lasting at least `minClosedSeconds` and when it ends.
    /// @param ts Unix timestamp in seconds.
    /// @param minClosedSeconds Minimum closed duration, in seconds, that qualifies as a long close.
    /// @return closeAt  Timestamp of the close.
    /// @return reopenAt  Timestamp of the reopening.
    function nextLongClose(uint256 ts, uint256 minClosedSeconds) external view returns (uint64 closeAt, uint64 reopenAt);
    /// @notice Returns the stored session windows.
    /// @return  The session windows.
    function sessions() external view returns (SessionWindow[] memory);
    /// @notice Returns the stored session kinds.
    /// @return  The session kinds.
    function sessionKinds() external view returns (Session[] memory);
    /// @notice Returns the stored holidays.
    /// @return  The holidays.
    function holidays() external view returns (Holiday[] memory);
    /// @notice Returns whether the fallback schedule is on.
    /// @return  True when enabled.
    function fallbackEnabled() external view returns (bool);
}

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
    event SessionsUpdated(uint256 count, uint64 firstOpen, uint64 lastClose);
    event HolidaysUpdated(uint256 count);
    event FallbackEnabledSet(bool enabled);
    error TooManySessions(uint256 count);
    error InvalidSession(uint256 index);
    error SessionsUnsorted(uint256 index);
    error SessionsOverlap(uint256 index);
    error SessionKindsLength(uint256 sessions, uint256 kinds);
    error TooManyHolidays(uint256 count);
    error HolidaysUnsorted(uint256 index);
    function setSessionsWithKinds(SessionWindow[] calldata s, Session[] calldata kinds) external; // KEEPER
    function setHolidays(Holiday[] calldata h) external; // admin
    function setFallbackEnabled(bool enabled) external; // admin
    function kindAt(uint256 ts) external view returns (Session); // OPEN/EXTENDED/CLOSED/UNKNOWN, never HALTED
    function nextLongClose(uint256 ts, uint256 minClosedSeconds) external view returns (uint64 closeAt, uint64 reopenAt);
    function sessions() external view returns (SessionWindow[] memory);
}

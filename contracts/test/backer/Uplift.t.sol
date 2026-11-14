// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackerFixture} from "./BackerFixture.sol";
import {ODBacker} from "overdrive/backer/ODBacker.sol";
import {ODMarketHours} from "overdrive/oracle/ODMarketHours.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODMarketHours, SessionWindow} from "overdrive/interfaces/IODMarketHours.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {Session} from "overdrive/interfaces/ODTypes.sol";

/// R5 weekend uplift on the real exchange calendar (T0 is a Friday, 08:00 UTC).
contract BackerUpliftTest is BackerFixture {
    ODMarketHours internal cal2;
    ODBacker internal b2; // views only: the uplift read of a backer on the real calendar
    address internal keeper = makeAddr("keeper");

    function setUp() public override {
        super.setUp();
        cal2 = new ODMarketHours(admin, keeper);
        b2 = new ODBacker(
            IERC20(address(usdg)),
            admin,
            guardian,
            IODGearRegistry(address(reg)),
            IODMinter(address(minter)),
            IODGovernor(address(gov)),
            IODOracleGuard(address(guard)),
            IODMarketHours(address(cal2)),
            IODInsurance(address(ins)),
            address(fees)
        );
    }

    /// 12 h sessions starting at T0 + dayOffset[i] days.
    function _sessions(int256[] memory dayOffsets) internal {
        SessionWindow[] memory s = new SessionWindow[](dayOffsets.length);
        Session[] memory k = new Session[](dayOffsets.length);
        for (uint256 i; i < s.length; ++i) {
            uint64 open = uint64(uint256(int256(T0) + dayOffsets[i] * 1 days));
            s[i] = SessionWindow(open, open + 12 hours);
            k[i] = Session.OPEN;
        }
        vm.prank(keeper);
        cal2.setSessionsWithKinds(s, k);
    }

    function _on(bytes32 m) internal view returns (bool a) {
        (a,) = b2.upliftActive(m);
    }

    function _at(uint256 t) internal {
        vm.warp(t);
    }

    function test_FridayBeforeCloseActive() public {
        int256[] memory d = new int256[](4);
        (d[0], d[1], d[2], d[3]) = (-1, 0, 3, 4); // Thu, Fri, Mon, Tue
        _sessions(d);
        _at(T0 + 9 hours); // 3 h before Friday's close
        assertFalse(_on(TSLA));
        _at(T0 + 10 hours); // the lead (2 h) starts
        (bool a, uint16 bps) = b2.upliftActive(TSLA);
        assertTrue(a);
        assertEq(bps, 5000);
        _at(T0 + 40 hours); // Saturday
        assertTrue(_on(TSLA));
        _at(T0 + 62 hours); // Sunday, 10 h before the reopen
        assertTrue(_on(TSLA));
        _at(T0 + 72 hours); // Monday open
        assertFalse(_on(TSLA));
        _at(T0 + 3 days + 14 hours); // a weeknight close (12 h) is not a long close
        assertFalse(_on(TSLA));
    }

    function test_HolidayWeekendActive() public {
        int256[] memory d = new int256[](3);
        (d[0], d[1], d[2]) = (-1, 4, 5); // Thu, (Fri holiday), Tue, Wed
        _sessions(d);
        _at(T0 - 15 hours); // Thursday, 3 h before its close
        assertFalse(_on(TSLA));
        _at(T0 - 13 hours);
        assertTrue(_on(TSLA));
        _at(T0 + 8 hours); // Friday holiday
        assertTrue(_on(TSLA));
        _at(T0 + 4 days - 1); // Monday night, a second before Tuesday's open
        assertTrue(_on(TSLA));
        _at(T0 + 4 days);
        assertFalse(_on(TSLA));
    }

    function test_CryptoNeverUplift() public {
        int256[] memory d = new int256[](2);
        (d[0], d[1]) = (0, 3);
        _sessions(d);
        _at(T0 + 40 hours);
        assertTrue(_on(TSLA));
        assertFalse(_on(ETH));
        (bool a, uint16 bps) = b2.upliftActive(ETH);
        assertFalse(a);
        assertEq(bps, 0);
    }

    function test_UnknownCalendarFailsClosed() public {
        // no sessions and no fallback: unknown time counts as active for stocks, never for 24/7 markets
        assertTrue(_on(TSLA));
        assertFalse(_on(ETH));
    }

    function test_PairUsesEarlierClose() public {
        // One exchange calendar serves every stock leg, so a stock/stock pair is uplifted from the (shared, earlier)
        // close; a pair with one 24/7 leg follows its stock leg.
        uint256 p = _open(alice, pair, 1_000e6);
        uint256 e = _open(alice, ethSport, 1_000e6);
        _uplift(true);
        (,,, uint256 req, uint256 maint) = backer.health(p);
        assertEq(req, 25_000);
        assertEq(maint, 20_000);
        (,,, req,) = backer.health(e);
        assertEq(req, 20_000);
        assertTrue(_onMain(NVDA));
        assertTrue(_onMain(TSLA));
        assertFalse(_onMain(ETH));
        _uplift(false);
        (,,, req,) = backer.health(p);
        assertEq(req, 20_000);
    }

    function _onMain(bytes32 m) internal view returns (bool a) {
        (a,) = backer.upliftActive(m);
    }
}

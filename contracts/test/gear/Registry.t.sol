// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {MockGearGuard} from "./GearMocks.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODGear} from "overdrive/gear/ODGear.sol";
import {ODVolOracle} from "overdrive/oracle/ODVolOracle.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODVolOracle} from "overdrive/interfaces/IODVolOracle.sol";
import {Gear, GearStatus, GearConfig} from "overdrive/interfaces/ODTypes.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract RegistryTest is ODTest {
    MockGearGuard internal guard;
    ODVolOracle internal vol;
    ODGearRegistry internal reg;

    address internal admin = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal minter = makeAddr("minter");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant TSLA = "TSLA";
    bytes32 internal constant NVDA = "NVDA";
    bytes32 internal constant AMD = "AMD";
    bytes32 internal constant SPY = "SPY";
    bytes32 internal constant NONE = bytes32(0);

    function setUp() public {
        vm.warp(1_800_000_000);
        guard = new MockGearGuard();
        vol = new ODVolOracle(admin, guardian, makeAddr("volSigner"));
        reg = new ODGearRegistry(admin, guardian, IODOracleGuard(address(guard)), IODVolOracle(address(vol)));
        vm.prank(admin);
        reg.setMinter(minter);
        guard.setMarket(TSLA, 250e18, true, false, true);
        guard.setMarket(NVDA, 180e18, true, false, true);
        guard.setMarket(AMD, 120e18, true, false, true);
        guard.setMarket(SPY, 600e18, true, false, true);
    }

    function _list(bytes32 a, bytes32 b, Gear g, string memory sym) internal returns (bytes32) {
        vm.prank(admin);
        return reg.listGear(a, b, g, 1e18, 1_000_000e18, 30, sym);
    }

    // ------------------------------------------------------------------------------------------------ R6 listing

    function test_ListSetsP0FromGuard() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
        GearConfig memory g = reg.gear(id);
        assertEq(g.p0, 250e18);
        assertEq(g.marketA, TSLA);
        assertEq(g.marketB, NONE);
        assertEq(uint8(g.gear), uint8(Gear.SPORT));
        assertEq(uint8(g.status), uint8(GearStatus.LISTED));
        assertEq(g.unitWad, 1e18);
        assertEq(g.capUsdWad, 1_000_000e18);
        assertEq(g.spreadBps, 30);
        assertEq(g.listedAt, block.timestamp);
        assertEq(g.token, reg.predictToken(id));
        ODGear t = ODGear(g.token);
        assertEq(t.name(), "Overdrive TSLA Sport");
        assertEq(t.symbol(), "TSLA-SPORT");
        assertEq(t.minter(), minter);
        assertEq(t.gearId(), id);
        assertEq(reg.gearCount(), 1);
        assertEq(reg.gearIdAt(0), id);
        // Pair p0 is the guard's ratio.
        bytes32 pid = _list(NVDA, AMD, Gear.SPORT, "NVDA/AMD-SPORT");
        assertEq(reg.gear(pid).p0, uint256(180e18) * 1e18 / 120e18);
        assertEq(ODGear(reg.gear(pid).token).name(), "Overdrive NVDA/AMD Sport");
    }

    function test_ListEmits() public {
        bytes32 id = reg.idOf(TSLA, NONE, Gear.CRUISE);
        vm.expectEmit(address(reg));
        emit IODGearRegistry.GearListed(id, TSLA, NONE, Gear.CRUISE, reg.predictToken(id), 250e18, 1e18);
        _list(TSLA, NONE, Gear.CRUISE, "TSLA-CRUISE");
    }

    function test_ListRefusesStaleMarket() public {
        guard.setMarket(TSLA, 250e18, false, false, true); // stale
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.MarketNotReady.selector, TSLA));
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 30, "TSLA-SPORT");

        guard.setMarket(TSLA, 250e18, true, true, true); // buys paused
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.MarketNotReady.selector, TSLA));
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 30, "TSLA-SPORT");

        guard.setMarket(TSLA, 250e18, true, false, false); // not enabled
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.MarketNotReady.selector, TSLA));
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 30, "TSLA-SPORT");

        guard.setMarket(TSLA, 0, true, false, true); // no price
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.MarketNotReady.selector, TSLA));
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 30, "TSLA-SPORT");

        guard.setMarket(AMD, 120e18, false, false, true); // stale pair leg
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.MarketNotReady.selector, AMD));
        reg.listGear(NVDA, AMD, Gear.SPORT, 1e18, 1e24, 30, "NVDA/AMD-SPORT");
        assertEq(reg.gearCount(), 0);
    }

    function test_PairOnlySport() public {
        Gear[4] memory others = [Gear.CRUISE, Gear.RACE, Gear.ECO, Gear.REVERSE];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(admin);
            vm.expectRevert(IODGearRegistry.NotAllowed.selector);
            reg.listGear(NVDA, AMD, others[i], 1e18, 1e24, 30, "NVDA/AMD-SPORT");
        }
        _list(NVDA, AMD, Gear.SPORT, "NVDA/AMD-SPORT");
        // A market can not be paired with itself.
        vm.prank(admin);
        vm.expectRevert(IODGearRegistry.InvalidParams.selector);
        reg.listGear(NVDA, NVDA, Gear.SPORT, 1e18, 1e24, 30, "NVDA/NVDA-SPORT");
    }

    function test_MaxGearsPerMarket() public {
        _list(TSLA, NONE, Gear.CRUISE, "TSLA-CRUISE");
        _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
        _list(TSLA, NONE, Gear.ECO, "TSLA-ECO");
        _list(TSLA, NONE, Gear.REVERSE, "TSLA-REV");
        // 8 more as pairs, TSLA on either side, against fresh markets.
        for (uint256 i; i < 8; ++i) {
            bytes32 m = bytes32(uint256(0x1000 + i));
            guard.setMarket(m, 10e18, true, false, true);
            vm.prank(admin);
            if (i % 2 == 0) reg.listGear(TSLA, m, Gear.SPORT, 1e18, 1e24, 30, "TSLA/X-SPORT");
            else reg.listGear(m, TSLA, Gear.SPORT, 1e18, 1e24, 30, "X/TSLA-SPORT");
        }
        assertEq(reg.gearsOfMarket(TSLA).length, reg.MAX_GEARS_PER_MARKET());
        bytes32 extra = bytes32(uint256(0x2000));
        guard.setMarket(extra, 10e18, true, false, true);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.TooManyGears.selector, TSLA));
        reg.listGear(extra, TSLA, Gear.SPORT, 1e18, 1e24, 30, "X/TSLA-SPORT");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.TooManyGears.selector, TSLA));
        reg.listGear(TSLA, extra, Gear.SPORT, 1e18, 1e24, 30, "TSLA/X-SPORT");
    }

    /// L-1 (audit): the Governor's book walks every listed gear, so the total is capped at MAX_GEARS (32).
    function test_L1_TotalGearCap() public {
        uint256 cap = reg.MAX_GEARS();
        assertEq(cap, 32);
        Gear[4] memory gs = [Gear.CRUISE, Gear.SPORT, Gear.ECO, Gear.REVERSE];
        string[4] memory sfx = ["X-CRUISE", "X-SPORT", "X-ECO", "X-REV"];
        uint256 listed;
        for (uint256 m; listed < cap; ++m) {
            bytes32 mk = bytes32(uint256(0x3000 + m));
            guard.setMarket(mk, 10e18, true, false, true);
            for (uint256 k; k < 4 && listed < cap; ++k) {
                vm.prank(admin);
                reg.listGear(mk, NONE, gs[k], 1e18, 1e24, 30, sfx[k]);
                ++listed;
            }
        }
        assertEq(reg.gearCount(), cap);
        // a fresh market with room for 12 still refuses the 33rd gear
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.GearCapReached.selector, cap));
        reg.listGear(SPY, NONE, Gear.SPORT, 1e18, 1e24, 30, "SPY-SPORT");
    }

    function test_CollateralByGear() public {
        vm.prank(admin);
        vol.setBounds(SPY, 500, 4000);
        bytes32 race = _list(SPY, NONE, Gear.RACE, "SPY-RACE");
        bytes32 sport = _list(SPY, NONE, Gear.SPORT, "SPY-SPORT");
        assertEq(reg.gear(race).collateralBps, 25000);
        assertEq(reg.gear(race).maintenanceBps, 20000);
        assertEq(reg.gear(sport).collateralBps, 20000);
        assertEq(reg.gear(sport).maintenanceBps, 15000);
    }

    function test_ListParamBounds() public {
        vm.startPrank(admin);
        vm.expectRevert(IODGearRegistry.InvalidParams.selector);
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18 - 1, 1e24, 30, "TSLA-SPORT");
        vm.expectRevert(IODGearRegistry.InvalidParams.selector);
        reg.listGear(TSLA, NONE, Gear.SPORT, 1000e18 + 1, 1e24, 30, "TSLA-SPORT");
        vm.expectRevert(IODGearRegistry.InvalidParams.selector);
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 0, 30, "TSLA-SPORT");
        vm.expectRevert(IODGearRegistry.InvalidParams.selector);
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 9, "TSLA-SPORT");
        vm.expectRevert(IODGearRegistry.InvalidParams.selector);
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 501, "TSLA-SPORT");
        vm.expectRevert(IODGearRegistry.InvalidParams.selector);
        reg.listGear(NONE, NONE, Gear.SPORT, 1e18, 1e24, 30, "TSLA-SPORT");
        reg.listGear(TSLA, NONE, Gear.SPORT, 1000e18, 1e24, 500, "TSLA-SPORT");
        reg.listGear(TSLA, NONE, Gear.ECO, 1e18, 1e24, 10, "TSLA-ECO");
        vm.stopPrank();
    }

    function test_GearExists() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IODGearRegistry.GearExists.selector, id));
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 30, "TSLA-SPORT");
    }

    function test_SymbolChecked() public {
        string[7] memory bad =
            ["TSLA-RACE", "TSLA-sport", "-SPORT", "tsla-SPORT", "TS LA-SPORT", "TSLA/NVDA-SPORT", "SPORT"];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(admin);
            vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.SymbolInvalid.selector, bad[i]));
            reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 30, bad[i]);
        }
        string[3] memory badPair = ["NVDAAMD-SPORT", "/AMD-SPORT", "NVDA/A/MD-SPORT"];
        for (uint256 i; i < badPair.length; ++i) {
            vm.prank(admin);
            vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.SymbolInvalid.selector, badPair[i]));
            reg.listGear(NVDA, AMD, Gear.SPORT, 1e18, 1e24, 30, badPair[i]);
        }
        bytes32 rev = _list(TSLA, NONE, Gear.REVERSE, "TSLA-REV");
        assertEq(ODGear(reg.gear(rev).token).name(), "Overdrive TSLA Reverse");
        bytes32 brk = _list(SPY, NONE, Gear.ECO, "BRK.B-ECO");
        assertEq(ODGear(reg.gear(brk).token).name(), "Overdrive BRK.B Eco");
    }

    function test_OnlyAdminLists() public {
        bytes32 adminRole = reg.DEFAULT_ADMIN_ROLE();
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole)
        );
        reg.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 30, "TSLA-SPORT");
    }

    function test_SetMinterOnce() public {
        ODGearRegistry r2 =
            new ODGearRegistry(admin, guardian, IODOracleGuard(address(guard)), IODVolOracle(address(vol)));
        vm.prank(admin);
        vm.expectRevert(ODGearRegistry.MinterNotSet.selector);
        r2.listGear(TSLA, NONE, Gear.SPORT, 1e18, 1e24, 30, "TSLA-SPORT");
        vm.prank(stranger);
        vm.expectRevert();
        r2.setMinter(minter);
        vm.prank(admin);
        vm.expectRevert(ODGearRegistry.ZeroAddress.selector);
        r2.setMinter(address(0));
        vm.prank(admin);
        r2.setMinter(minter);
        assertEq(r2.minter(), minter);
        vm.prank(admin);
        vm.expectRevert(ODGearRegistry.MinterAlreadySet.selector);
        r2.setMinter(stranger);
    }

    function test_ConstructorRejectsZero() public {
        IODOracleGuard g = IODOracleGuard(address(guard));
        IODVolOracle v = IODVolOracle(address(vol));
        vm.expectRevert(ODGearRegistry.ZeroAddress.selector);
        new ODGearRegistry(address(0), guardian, g, v);
        vm.expectRevert(ODGearRegistry.ZeroAddress.selector);
        new ODGearRegistry(admin, address(0), g, v);
        vm.expectRevert(ODGearRegistry.ZeroAddress.selector);
        new ODGearRegistry(admin, guardian, IODOracleGuard(address(0)), v);
        vm.expectRevert(ODGearRegistry.ZeroAddress.selector);
        new ODGearRegistry(admin, guardian, g, IODVolOracle(address(0)));
    }

    // -------------------------------------------------------------------------------------------------- R7 RACE

    function test_RaceNeedsCalmMarket() public {
        // Bounds unset: the vol oracle reports its hard ceiling (300%), far above 40%.
        vm.prank(admin);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.listGear(TSLA, NONE, Gear.RACE, 1e18, 1e24, 30, "TSLA-RACE");
        vm.prank(admin);
        vol.setBounds(TSLA, 500, 4001);
        vm.prank(admin);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.listGear(TSLA, NONE, Gear.RACE, 1e18, 1e24, 30, "TSLA-RACE");
        vm.prank(admin);
        vol.setBounds(SPY, 500, 4000);
        bytes32 id = _list(SPY, NONE, Gear.RACE, "SPY-RACE");
        assertEq(uint8(reg.gear(id).gear), uint8(Gear.RACE));
        // Other gears ignore the vol ceiling.
        _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
    }

    // ------------------------------------------------------------------------------------------ R8 status, params

    function test_GuardianOnlyLowersRisk() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
        vm.startPrank(guardian);
        reg.setStatus(id, GearStatus.BUYS_PAUSED);
        reg.setStatus(id, GearStatus.SELL_ONLY);
        assertEq(uint8(reg.gear(id).status), uint8(GearStatus.SELL_ONLY));
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.setStatus(id, GearStatus.SETTLED);
        vm.expectRevert(IODGearRegistry.InvalidParams.selector);
        reg.setStatus(id, GearStatus.NONE);
        // Params: lower cap and wider spread are fine; anything raising risk is not.
        reg.setParams(id, 500_000e18, 40);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.setParams(id, 500_000e18 + 1, 40);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.setParams(id, 500_000e18, 39);
        vm.expectRevert(IODGearRegistry.InvalidParams.selector);
        reg.setParams(id, 0, 501);
        reg.setParams(id, 0, 40);
        vm.stopPrank();
        assertEq(reg.gear(id).capUsdWad, 0);
        assertEq(reg.gear(id).spreadBps, 40);
        // Strangers can do neither.
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, reg.GUARDIAN_ROLE()
            )
        );
        reg.setStatus(id, GearStatus.SELL_ONLY);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, reg.GUARDIAN_ROLE()
            )
        );
        reg.setParams(id, 0, 50);
        vm.stopPrank();
    }

    function test_GuardianCannotUnpause() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
        vm.startPrank(guardian);
        reg.setStatus(id, GearStatus.SELL_ONLY);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.setStatus(id, GearStatus.BUYS_PAUSED);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.setStatus(id, GearStatus.LISTED);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.setStatus(id, GearStatus.SELL_ONLY); // no-op moves are not risk-reducing
        vm.stopPrank();
    }

    function test_AdminUnpauses() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
        vm.prank(guardian);
        reg.setStatus(id, GearStatus.BUYS_PAUSED);
        vm.expectEmit(address(reg));
        emit IODGearRegistry.GearStatusSet(id, GearStatus.LISTED);
        vm.prank(admin);
        reg.setStatus(id, GearStatus.LISTED);
        assertEq(uint8(reg.gear(id).status), uint8(GearStatus.LISTED));
        // Admin raises the cap and narrows the spread.
        vm.prank(admin);
        reg.setParams(id, 5_000_000e18, 10);
        assertEq(reg.gear(id).capUsdWad, 5_000_000e18);
        assertEq(reg.gear(id).spreadBps, 10);
    }

    function test_SettledTerminal() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
        vm.startPrank(admin);
        reg.setStatus(id, GearStatus.SETTLED);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.setStatus(id, GearStatus.LISTED);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.setStatus(id, GearStatus.SETTLED);
        vm.stopPrank();
        vm.prank(guardian);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.setStatus(id, GearStatus.SELL_ONLY);
    }

    function test_UnknownGear() public {
        bytes32 id = reg.idOf(TSLA, NONE, Gear.SPORT);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IODGearRegistry.GearUnknown.selector, id));
        reg.setStatus(id, GearStatus.SELL_ONLY);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IODGearRegistry.GearUnknown.selector, id));
        reg.setParams(id, 1, 30);
        assertEq(uint8(reg.gear(id).status), uint8(GearStatus.NONE));
    }

    // --------------------------------------------------------------------------------------------- R9, R10 views

    function test_GearsOfMarketIncludesPairs() public {
        bytes32 tsla = _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
        bytes32 nvda = _list(NVDA, NONE, Gear.SPORT, "NVDA-SPORT");
        bytes32 nvdaAmd = _list(NVDA, AMD, Gear.SPORT, "NVDA/AMD-SPORT");
        bytes32 amdTsla = _list(AMD, TSLA, Gear.SPORT, "AMD/TSLA-SPORT");
        bytes32[] memory n = reg.gearsOfMarket(NVDA);
        assertEq(n.length, 2);
        assertEq(n[0], nvda);
        assertEq(n[1], nvdaAmd);
        bytes32[] memory a = reg.gearsOfMarket(AMD);
        assertEq(a.length, 2);
        assertEq(a[0], nvdaAmd);
        assertEq(a[1], amdTsla);
        bytes32[] memory t = reg.gearsOfMarket(TSLA);
        assertEq(t.length, 2);
        assertEq(t[0], tsla);
        assertEq(t[1], amdTsla);
        assertEq(reg.gearsOfMarket(SPY).length, 0);
    }

    function testFuzz_IdOf(bytes32 a, bytes32 b, uint8 gRaw) public {
        Gear g = Gear(bound(gRaw, 0, 4));
        assertEq(reg.idOf(a, b, g), keccak256(abi.encode(a, b, g)));
        // Listed id equals the stored one.
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, "TSLA-SPORT");
        assertEq(id, reg.idOf(TSLA, NONE, Gear.SPORT));
        assertEq(reg.gearIdAt(0), id);
        if (a != TSLA || b != NONE || g != Gear.SPORT) assertTrue(reg.idOf(a, b, g) != id);
    }

    function test_StatusEnumOrder() public pure {
        assertEq(uint8(GearStatus.NONE), 0);
        assertEq(uint8(GearStatus.LISTED), 1);
        assertLt(uint8(GearStatus.LISTED), uint8(GearStatus.BUYS_PAUSED));
        assertLt(uint8(GearStatus.BUYS_PAUSED), uint8(GearStatus.SELL_ONLY));
        assertLt(uint8(GearStatus.SELL_ONLY), uint8(GearStatus.SETTLED));
    }

    function test_PowerWad() public view {
        assertEq(reg.powerWad(Gear.CRUISE), 1.5e18);
        assertEq(reg.powerWad(Gear.SPORT), 2e18);
        assertEq(reg.powerWad(Gear.RACE), 3e18);
        assertEq(reg.powerWad(Gear.ECO), 0.5e18);
        assertEq(reg.powerWad(Gear.REVERSE), -1e18);
    }
}

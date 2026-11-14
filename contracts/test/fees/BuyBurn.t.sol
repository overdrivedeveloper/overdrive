// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODBuyBurn} from "overdrive/fees/ODBuyBurn.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockOvrd, MockPriceSource, MockSwapAdapter} from "../mocks/MockOvrd.sol";

contract BuyBurnTest is ODTest {
    MockUSDG internal usdg;
    MockOvrd internal ovrd;
    MockPriceSource internal src;
    MockSwapAdapter internal adapter;
    ODBuyBurn internal bb;

    address internal admin = makeAddr("timelock");
    address internal keeper = makeAddr("keeper");
    address internal dead = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        usdg = new MockUSDG();
        ovrd = new MockOvrd();
        src = new MockPriceSource();
        src.set(0.5e18, 0.5e18); // $0.50 per OVRD
        adapter = new MockSwapAdapter(address(usdg), 0.5e18);
        bb = new ODBuyBurn(IERC20(address(usdg)), admin);
        vm.startPrank(admin);
        bb.setRoute(address(ovrd), address(adapter), 3000, 300);
        bb.setPriceSource(address(src));
        bb.grantRole(ODRoles.KEEPER_ROLE, keeper);
        vm.stopPrank();
        usdg.mint(address(bb), 5_000e6);
    }

    function test_KeeperOnly() public {
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, makeAddr("anyone"), ODRoles.KEEPER_ROLE
            )
        );
        bb.execute(100e6, 0);
        vm.prank(keeper);
        assertEq(bb.execute(100e6, 0), 200e18);
    }

    function test_BurnAddress() public {
        vm.prank(keeper);
        uint256 burned = bb.execute(1_000e6, 1_900e18);
        assertEq(burned, 2_000e18);
        assertEq(ovrd.balanceOf(dead), 2_000e18);
        assertEq(ovrd.balanceOf(address(bb)), 0);
        assertEq(usdg.balanceOf(address(bb)), 4_000e6);
        assertEq(bb.totalBurned(), 2_000e18);
    }

    function test_TwapUnavailableRefuses() public {
        src.setMode(1);
        vm.prank(keeper);
        vm.expectRevert(ODBuyBurn.TwapUnavailable.selector);
        bb.execute(100e6, 0);
        src.setMode(2); // short return also reads as unavailable
        vm.prank(keeper);
        vm.expectRevert(ODBuyBurn.TwapUnavailable.selector);
        bb.execute(100e6, 0);
        src.setMode(0);
        vm.prank(admin);
        bb.setPriceSource(address(0));
        vm.prank(keeper);
        vm.expectRevert(ODBuyBurn.TwapUnavailable.selector);
        bb.execute(100e6, 0);
        assertEq(usdg.balanceOf(address(bb)), 5_000e6, "nothing spent");
    }

    function test_TwapFloorAndSpotBand() public {
        // route pays 5% under the TWAP: below the 3% slippage floor
        adapter.setHaircut(500);
        vm.prank(keeper);
        vm.expectRevert();
        bb.execute(100e6, 0);
        adapter.setHaircut(0);
        // spot pushed 1% off the TWAP: refused
        src.set(0.5e18, 0.505e18);
        vm.prank(keeper);
        vm.expectRevert(ODBuyBurn.SpotOffTwap.selector);
        bb.execute(100e6, 0);
        // caller's minimum above what the route gives
        src.set(0.5e18, 0.5e18);
        vm.prank(keeper);
        vm.expectRevert();
        bb.execute(100e6, 201e18);
    }

    function test_PerCallCapAndRouteBounds() public {
        vm.prank(keeper);
        vm.expectRevert(ODBuyBurn.InvalidParams.selector);
        bb.execute(1_001e6, 0);
        vm.startPrank(admin);
        vm.expectRevert(ODBuyBurn.InvalidParams.selector);
        bb.setRoute(address(ovrd), address(adapter), 3000, 2_001);
        vm.expectRevert(ODBuyBurn.InvalidParams.selector);
        bb.setRoute(address(usdg), address(adapter), 3000, 300);
        bb.setRoute(address(ovrd), address(0), 0, 300);
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(ODBuyBurn.NoRoute.selector);
        bb.execute(100e6, 0);
    }
}

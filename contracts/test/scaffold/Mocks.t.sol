// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockPyth} from "../mocks/MockPyth.sol";
import {MockV3Pool} from "../mocks/MockV3Pool.sol";

contract MocksTest is ODTest {
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function test_MockUSDG_sixDecimalsAndMint() public {
        MockUSDG u = new MockUSDG();
        assertEq(u.decimals(), 6);
        u.mint(alice, 5e6);
        assertEq(u.balanceOf(alice), 5e6);
    }

    function test_MockUSDG_pauseBlocksTransfers() public {
        MockUSDG u = new MockUSDG();
        u.mint(alice, 5e6);
        u.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(MockUSDG.TokenPaused.selector);
        u.transfer(bob, 1e6);
        u.setPaused(false);
        vm.prank(alice);
        u.transfer(bob, 1e6);
        assertEq(u.balanceOf(bob), 1e6);
    }

    function test_MockUSDG_blocklistSimulatesPayoutFailure() public {
        MockUSDG u = new MockUSDG();
        u.mint(alice, 5e6);
        u.setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUSDG.AccountBlocked.selector, bob));
        u.transfer(bob, 1e6);
        u.setBlocked(bob, false);
        vm.prank(alice);
        u.transfer(bob, 1e6);
        assertEq(u.balanceOf(bob), 1e6);
    }

    function test_MockStockToken_multipliersAndFlags() public {
        MockStockToken s = new MockStockToken();
        assertEq(s.uiMultiplier(), 1e18);
        s.setMultipliers(1e18, 2e18, 123);
        assertEq(s.newUIMultiplier(), 2e18);
        assertEq(s.effectiveAt(), 123);
        s.setOraclePaused(true);
        s.setPaused(true);
        assertTrue(s.oraclePaused());
        assertTrue(s.paused());
        s.mint(alice, 7);
        assertEq(s.balanceOf(alice), 7);
    }

    function test_MockAggregator_roundAndAggregatorShape() public {
        MockAggregator a = new MockAggregator(8, 250e8);
        (, int256 ans,, uint256 upd,) = a.latestRoundData();
        assertEq(ans, 250e8);
        assertEq(upd, block.timestamp);
        assertEq(a.aggregator(), address(a));
        vm.warp(block.timestamp + 100);
        a.setRound(251e8, block.timestamp - 50);
        (, ans,, upd,) = a.latestRoundData();
        assertEq(ans, 251e8);
        assertEq(upd, block.timestamp - 50);
    }

    function test_MockAggregator_canRevertOrReturnGarbage() public {
        MockAggregator a = new MockAggregator(8, 1e8);
        a.setRevert(true);
        vm.expectRevert();
        a.latestRoundData();
        a.setRevert(false);
        a.setGarbage(true);
        (bool ok, bytes memory ret) = address(a).staticcall(abi.encodeCall(MockAggregator.latestRoundData, ()));
        assertTrue(ok);
        assertEq(ret.length, 32); // a full round is 160 bytes
    }

    function test_MockPyth_priceAndStaleness() public {
        MockPyth p = new MockPyth();
        bytes32 id = keccak256("TSLA");
        vm.warp(10_000);
        p.setPrice(id, 25_000_000, 1000, -5, 9_990);
        assertEq(p.getPriceUnsafe(id).price, 25_000_000);
        assertEq(p.getPriceNoOlderThan(id, 60).expo, -5);
        vm.warp(10_100);
        vm.expectRevert(MockPyth.StalePrice.selector);
        p.getPriceNoOlderThan(id, 60);
        p.setPublishTime(id, 10_090);
        p.setExpo(id, -8);
        assertEq(p.getPriceNoOlderThan(id, 60).expo, -8);
        vm.expectRevert(MockPyth.PriceFeedNotFound.selector);
        p.getPriceUnsafe(bytes32(uint256(1)));
    }

    function test_MockV3Pool_observeSlot0AndRevert() public {
        MockV3Pool pool = new MockV3Pool(address(1), address(2), 1000);
        vm.warp(10_000);
        uint32[] memory ago = new uint32[](2);
        ago[0] = 600;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        assertEq(int256(cum[1] - cum[0]) / 600, 1000); // time-weighted mean tick
        (, int24 t,,,,,) = pool.slot0();
        assertEq(t, 1000);
        pool.setRevert(true);
        vm.expectRevert();
        pool.observe(ago);
        vm.expectRevert();
        pool.slot0();
    }
}

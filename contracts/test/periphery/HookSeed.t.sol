// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {ODHookSeed} from "overdrive/periphery/ODHookSeed.sol";
import {HookSeedBatch} from "../../script/HookSeed.s.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

contract HookSeedTest is Test {
    PoolManager pm;
    ODHookSeed helper;
    MockUSDG usdg;
    MockUSDG gear; // any plain ERC-20 stands in for a gear token
    HookSeedBatch batch;
    address safe = makeAddr("ownerSafe");
    address stranger = makeAddr("stranger");

    function setUp() public {
        pm = new PoolManager(address(this));
        helper = new ODHookSeed(IPoolManager(address(pm)), safe);
        usdg = new MockUSDG();
        gear = new MockUSDG();
        batch = new HookSeedBatch();
        usdg.mint(safe, 10_000e6);
        gear.mint(safe, 10e18);
        // other users' funds in the PoolManager must be untouched by the seed and its removal
        usdg.mint(address(pm), 777e6);
    }

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](2);
        t[0] = address(usdg);
        t[1] = address(gear);
    }

    function _amts(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        x[0] = a;
        x[1] = b;
    }

    /// Executes a Safe batch as the Safe would (one call per transaction, from the Safe).
    function _exec(HookSeedBatch.Txs memory t) internal {
        for (uint256 i; i < t.to.length; ++i) {
            vm.prank(safe);
            (bool ok, bytes memory ret) = t.to[i].call(t.data[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }

    function _seed(uint256 a, uint256 b) internal {
        _exec(batch.seedTxs(address(helper), _tokens(), _amts(a, b)));
    }

    function _assertHelperEmpty() internal view {
        assertEq(usdg.balanceOf(address(helper)), 0);
        assertEq(gear.balanceOf(address(helper)), 0);
        assertEq(pm.balanceOf(address(helper), uint160(address(usdg))), 0);
        assertEq(pm.balanceOf(address(helper), uint160(address(gear))), 0);
        assertEq(address(helper).balance, 0);
    }

    function test_seedMintsClaimsToSafe() public {
        _seed(500e6, 1e18);
        assertEq(pm.balanceOf(safe, uint160(address(usdg))), 500e6);
        assertEq(pm.balanceOf(safe, uint160(address(gear))), 1e18);
        assertEq(usdg.balanceOf(safe), 9500e6);
        assertEq(gear.balanceOf(safe), 9e18);
        assertEq(usdg.balanceOf(address(pm)), 777e6 + 500e6);
        assertEq(usdg.allowance(safe, address(helper)), 0, "ERC-20 approval consumed");
        _assertHelperEmpty();
    }

    /// The owner approved a tiny seed with 0 USDG (mainnet.json hookSeed.usdgPerGear "0"): the batch still runs, the
    /// Safe gets only its gear claim, and the remove batch skips the empty USDG claim.
    function test_zeroUsdgSeed() public {
        _seed(0, 1e18);
        assertEq(pm.balanceOf(safe, uint160(address(usdg))), 0);
        assertEq(pm.balanceOf(safe, uint160(address(gear))), 1e18);
        assertEq(usdg.balanceOf(safe), 10_000e6, "no USDG moved");
        assertEq(usdg.balanceOf(address(pm)), 777e6);
        _assertHelperEmpty();
        (address[] memory held, uint256[] memory claims) = batch.claimsOf(address(pm), safe, _tokens());
        assertEq(held.length, 1, "only the gear claim");
        assertEq(held[0], address(gear));
        _exec(batch.removeTxs(address(pm), address(helper), held, claims));
        assertEq(gear.balanceOf(safe), 10e18);
        _assertHelperEmpty();
    }

    function test_removeReturnsEverythingToSafe() public {
        _seed(500e6, 1e18);
        (address[] memory held, uint256[] memory claims) = batch.claimsOf(address(pm), safe, _tokens());
        assertEq(held.length, 2);
        _exec(batch.removeTxs(address(pm), address(helper), held, claims));
        assertEq(usdg.balanceOf(safe), 10_000e6);
        assertEq(gear.balanceOf(safe), 10e18);
        assertEq(pm.balanceOf(safe, uint160(address(usdg))), 0);
        assertEq(pm.balanceOf(safe, uint160(address(gear))), 0);
        assertEq(pm.allowance(safe, address(helper), uint160(address(usdg))), 0, "6909 approval consumed");
        assertEq(usdg.balanceOf(address(pm)), 777e6, "other funds in the PoolManager untouched");
        _assertHelperEmpty();
        (held,) = batch.claimsOf(address(pm), safe, _tokens());
        assertEq(held.length, 0);
    }

    function testFuzz_roundTrip(uint256 a, uint256 b) public {
        a = bound(a, 1, 10_000e6);
        b = bound(b, 1, 10e18);
        _seed(a, b);
        _exec(batch.removeTxs(address(pm), address(helper), _tokens(), _amts(a, b)));
        assertEq(usdg.balanceOf(safe), 10_000e6);
        assertEq(gear.balanceOf(safe), 10e18);
        _assertHelperEmpty();
    }

    function test_partialRemove() public {
        _seed(500e6, 1e18);
        _exec(batch.removeTxs(address(pm), address(helper), _tokens(), _amts(200e6, 1e17)));
        assertEq(pm.balanceOf(safe, uint160(address(usdg))), 300e6);
        assertEq(usdg.balanceOf(safe), 9700e6);
        _assertHelperEmpty();
    }

    function test_onlyOwnerCanSeedOrRemove() public {
        _seed(500e6, 1e18);
        vm.startPrank(stranger);
        vm.expectRevert(ODHookSeed.NotOwner.selector);
        helper.seed(_tokens(), _amts(1, 1));
        vm.expectRevert(ODHookSeed.NotOwner.selector);
        helper.remove(_tokens(), _amts(500e6, 1e18));
        vm.stopPrank();
        assertEq(pm.balanceOf(safe, uint160(address(usdg))), 500e6);
    }

    function test_strangerCannotCallTheCallback() public {
        _seed(500e6, 1e18);
        bytes memory data = abi.encode(uint8(2), _tokens(), _amts(500e6, 1e18));
        vm.prank(stranger);
        vm.expectRevert(ODHookSeed.NotPoolManager.selector);
        helper.unlockCallback(data);
        // outside an unlock even the PoolManager address gets nothing: burn/take need the lock
        vm.prank(address(pm));
        vm.expectRevert(IPoolManager.ManagerLocked.selector);
        helper.unlockCallback(data);
    }

    function test_removeNeedsTheSafesClaimApproval() public {
        _seed(500e6, 1e18);
        vm.prank(safe);
        vm.expectRevert(); // allowance underflow in ERC6909Claims._burnFrom
        helper.remove(_tokens(), _amts(500e6, 1e18));
    }

    function test_seedNeedsTheSafesTokenApproval() public {
        vm.prank(safe);
        vm.expectRevert();
        helper.seed(_tokens(), _amts(1, 1));
    }

    function test_cannotRemoveMoreThanTheClaim() public {
        _seed(500e6, 1e18);
        _exec(batch.removeTxs(address(pm), address(helper), _tokens(), _amts(500e6, 1e18)));
        vm.prank(safe);
        pm.approve(address(helper), uint160(address(usdg)), 1);
        address[] memory one = new address[](1);
        one[0] = address(usdg);
        uint256[] memory amt = new uint256[](1);
        amt[0] = 1;
        vm.prank(safe);
        vm.expectRevert(); // claim balance underflow: other users' USDG in the PoolManager stays put
        helper.remove(one, amt);
        assertEq(usdg.balanceOf(address(pm)), 777e6);
    }

    function test_inputChecks() public {
        vm.startPrank(safe);
        vm.expectRevert(ODHookSeed.LengthMismatch.selector);
        helper.seed(_tokens(), new uint256[](1));
        address[] memory native = new address[](1);
        vm.expectRevert(ODHookSeed.NativeNotSupported.selector);
        helper.remove(native, new uint256[](1));
        vm.stopPrank();
        vm.expectRevert(ODHookSeed.ZeroAddress.selector);
        new ODHookSeed(IPoolManager(address(0)), safe);
        vm.expectRevert(ODHookSeed.ZeroAddress.selector);
        new ODHookSeed(IPoolManager(address(pm)), address(0));
    }
}

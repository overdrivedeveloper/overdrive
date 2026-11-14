// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {Quote} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

contract HookStandIn {
    address public poolManager;
    IODMinter public minter;

    constructor(address pm, IODMinter m) {
        poolManager = pm;
        minter = m;
    }

    function swap(bytes32 id, bool isBuy, bool exactIn, uint256 amount, address sink)
        external
        returns (uint256, uint256)
    {
        return minter.hookSwap(id, isBuy, exactIn, amount, sink);
    }
}

/// R13: the hook path uses the same pricing and never pulls tokens itself.
contract HookTest is SystemFixture {
    address internal pm = makeAddr("poolManager");
    HookStandIn internal hook;

    function setUp() public override {
        super.setUp();
        hook = new HookStandIn(pm, minter);
        vm.prank(admin);
        minter.setHook(address(hook));
    }

    function test_OnlyHook() public {
        vm.prank(stranger);
        vm.expectRevert(IODMinter.NotHook.selector);
        minter.hookSwap(sport, true, true, 1_000e6, stranger);
        vm.prank(admin);
        vm.expectRevert(IODMinter.AlreadySet.selector);
        minter.setHook(stranger);
    }

    function test_HookPathSamePricing() public {
        Quote memory q = minter.quote(sport, true, true, 1_000e6);
        usdg.mint(address(gov), 1_000e6); // the hook has settled the USDG to the Governor first
        (uint256 inAmt, uint256 out) = hook.swap(sport, true, true, 1_000e6, pm);
        assertEq(inAmt, 1_000e6);
        assertEq(out, q.amountOut, "same tokens as the quote");
        assertEq(IERC20(reg.gear(sport).token).balanceOf(pm), out, "minted to the PoolManager");
        // without the USDG the Governor refuses
        vm.expectRevert();
        hook.swap(sport, true, true, 1_000e6, pm);
        // sell: tokens sit with the hook, USDG goes to the PoolManager
        IERC20 tok = IERC20(reg.gear(sport).token);
        vm.prank(pm);
        tok.transfer(address(hook), out);
        Quote memory qs = minter.quote(sport, false, true, out);
        (uint256 tin, uint256 paid) = hook.swap(sport, false, true, out, address(hook));
        assertEq(tin, out);
        assertEq(paid, qs.amountOut, "same USDG as the quote");
        assertEq(usdg.balanceOf(pm), paid);
    }
}

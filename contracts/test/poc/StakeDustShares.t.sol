// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockOvrd, MockPriceSource, MockSwapAdapter} from "../mocks/MockOvrd.sol";
import {StakeHandler} from "../stake/StakeInvariant.t.sol";

/// Found by `stake/StakeInvariant.t.sol : invariant_SharesAddUp` on a random seed (invariant lane 2). After a slash that
/// leaves only dust, assetsOf rounds with the +1 virtual offset (shares * (A + 1) / (S + 1)), so an exit of just over
/// half the shares takes every remaining unit: the other shares stay with totalAssets = 0. Dust scale only (the
/// remaining shares were worth at most one unit), but `invariant_SharesAddUp` asserts totalAssets > 0 whenever shares
/// exist and fails on this sequence. This test replays the shrunk sequence and asserts the state IS reached.
contract StakeDustSharesTest is ODTest {
    function test_Repro_DustSlashLeavesSharesWithNoAssets() public {
        MockUSDG usdg = new MockUSDG();
        MockOvrd ovrd = new MockOvrd();
        MockPriceSource src = new MockPriceSource();
        src.set(0.5e18, 0.5e18);
        MockSwapAdapter adapter = new MockSwapAdapter(address(usdg), 0.5e18);
        address admin = makeAddr("timelock");
        address governor = makeAddr("governor");
        address fees = makeAddr("fees");
        ODStake stk = new ODStake(IERC20(address(ovrd)), IERC20(address(usdg)), admin, governor, makeAddr("backer"));
        vm.startPrank(admin);
        stk.setSlashRoute(address(src), address(adapter), 3000, 300);
        stk.grantRole(stk.FEES_ROLE(), fees);
        vm.stopPrank();
        StakeHandler h = new StakeHandler(stk, ovrd, usdg, adapter, governor, fees);

        h.stake(3515, 12265);
        h.slash(22300745198530623141535718272648361505980414, 101);
        h.requestUnstake(
            3349862669567204944143294862009334018364878905256929073363297349209294,
            115792089237316195423570985008687907853269984665640564039457584007913129639934
        );
        h.unstake(1115);

        assertGt(stk.totalShares(), 0, "shares remain");
        assertEq(stk.totalAssets(), 0, "bug present: shares exist with no assets behind them");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {MarketConfig} from "overdrive/interfaces/ODTypes.sol";

/// Rescore 5, finding I4-3 (Low), regression. Before the fix `repayWithUsdg` and `withdraw` priced a vault on the
/// feed alone when the reference was missing (`if (r.refP == 0) return v;`), on a round as old as the in-session age
/// limit, and `setMarket` took any in-session age. Now both need a reference, or a live round at most MAX_ROUND_AGE
/// old; exits that use no price (repay with tokens, withdraw with no debt) stay open; the in-session age is capped.
contract Rescore5FeedOnlyTest is BackerFixture {
    bytes4 internal CLOSED = IODBacker.MintingClosed.selector;

    /// A vault with debt sold to the Governor, a 20 h old round (inside the 26 h limit) and no reference.
    function _feedOnlyVault() internal returns (uint256 v) {
        v = _open(alice, sport, 2_000e6);
        _mint(alice, v, 400e18, true);
        vm.warp(vm.getBlockTimestamp() + 20 hours);
        _dropRef(TSLA);
        assertTrue(_reading(sport).fresh, "the 20 h old round still reads live");
        assertEq(_reading(sport).refP, 0, "no reference");
    }

    function test_I4_3_RepayWithUsdgRefusedOnAnOldFeedOnlyPrice() public {
        uint256 v = _feedOnlyVault();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CLOSED, bytes32("REF_UNAVAILABLE")));
        backer.repayWithUsdg(v, 100e18, type(uint256).max);
    }

    function test_I4_3_WithdrawWithDebtRefusedOnAnOldFeedOnlyPrice() public {
        uint256 v = _feedOnlyVault();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CLOSED, bytes32("REF_UNAVAILABLE")));
        backer.withdraw(v, 100e6, alice);
    }

    /// The bounded-age side: with no reference, a round at most MAX_ROUND_AGE old is enough; one second older is not.
    function test_I4_3_RecentRoundIsEnoughWithoutAReference() public {
        uint256 v = _feedOnlyVault();
        feedOf[TSLA].push(int256(_p(TSLA) / 1e10)); // a new round, still no reference
        vm.warp(vm.getBlockTimestamp() + backer.MAX_ROUND_AGE());
        assertEq(_reading(sport).refP, 0);
        vm.startPrank(alice);
        backer.withdraw(v, 100e6, alice);
        assertGt(backer.repayWithUsdg(v, 100e18, type(uint256).max), 0);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(abi.encodeWithSelector(CLOSED, bytes32("REF_UNAVAILABLE")));
        backer.withdraw(v, 100e6, alice);
        vm.expectRevert(abi.encodeWithSelector(CLOSED, bytes32("REF_UNAVAILABLE")));
        backer.repayWithUsdg(v, 100e18, type(uint256).max);
        vm.stopPrank();
    }

    /// With a reference the age of the feed round does not matter (the guard's own limits apply), as before.
    function test_I4_3_ReferenceIsEnoughOnAnOldRound() public {
        uint256 v = _feedOnlyVault();
        _ref(TSLA, _p(TSLA));
        vm.startPrank(alice);
        backer.withdraw(v, 100e6, alice);
        assertGt(backer.repayWithUsdg(v, 100e18, type(uint256).max), 0);
        vm.stopPrank();
    }

    /// No exit of the owner's own funds is stranded by a missing reference: repay with tokens and take every USDG
    /// of collateral out, on an old round with no reference, and also with the market closed.
    function test_I4_3_PureExitsStayOpenWithoutAReference() public {
        uint256 v = _open(bob, sport, 2_000e6);
        _mint(bob, v, 400e18, false); // tokens in bob's wallet
        vm.warp(vm.getBlockTimestamp() + 20 hours);
        _dropRef(TSLA);
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(CLOSED, bytes32("REF_UNAVAILABLE")));
        backer.withdraw(v, 1e6, bob); // collateral out with debt open: needs a price
        backer.repay(v, 400e18);
        uint256 coll = _coll(v);
        backer.withdraw(v, coll, bob);
        vm.stopPrank();
        assertEq(_coll(v), 0);
        assertEq(_debt(v), 0);
        assertGe(usdg.balanceOf(bob) * 10_000, 2_000e6 * 9_990, "bob has his collateral back");
    }

    function test_I4_3_InSessionAgeIsCapped() public {
        MarketConfig memory c = guard.config(TSLA);
        assertEq(guard.MAX_MAX_AGE_OPEN(), 3 days);
        vm.startPrank(admin);
        c.maxAgeOpen = 3 days + 1;
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        guard.setMarket(TSLA, c);
        c.maxAgeOpen = 3 days;
        c.maxAgeExtended = 3 days + 1;
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        guard.setMarket(TSLA, c);
        c.maxAgeExtended = 3 days;
        guard.setMarket(TSLA, c);
        vm.stopPrank();
    }

    /// Every committed deploy config stays inside the cap (the deploy script would revert otherwise).
    function test_I4_3_CommittedConfigsRespectTheCap() public view {
        string[4] memory files = ["anvil", "fork", "mainnet", "testnet"];
        uint256 mainnetMarkets;
        for (uint256 i; i < files.length; ++i) {
            string memory j = vm.readFile(string.concat("script/config/", files[i], ".json"));
            for (uint256 k; k < 64; ++k) {
                string memory key = string.concat(".markets[", vm.toString(k), "].maxAgeInSession");
                if (!vm.keyExistsJson(j, key)) break;
                assertLe(vm.parseJsonUint(j, key), guard.MAX_MAX_AGE_OPEN(), files[i]);
                if (i == 2) ++mainnetMarkets;
            }
        }
        assertEq(mainnetMarkets, 5, "every mainnet market was read");
    }
}

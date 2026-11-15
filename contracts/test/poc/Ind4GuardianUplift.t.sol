// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";

/// Regression for independent check 4, finding I4-2 (fix round 7). The guardian could raise the maintenance uplift to
/// 20,000 bps with a 3 day lead at once, which made every stock vault under 350% sealable: a vault at the initial
/// ratio lost its position and a 5% bonus to an executor. The uplift is now set by the admin (timelock) alone, so a
/// raise is public for 48 hours before it can make any vault sealable.
contract Ind4GuardianUpliftTest is BackerFixture {
    function _prepare() internal returns (uint256 v) {
        v = _sportVault(bob); // 1000 USDG, 500 tokens: 200%, the initial ratio; maintenance is 150%
        _uplift(true); // a long close starts in 1 hour
    }

    function _sealRefused(uint256 v) internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = v;
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("NONE_UNHEALTHY")));
        backer.sealBatch(sport, ids);
    }

    /// The guardian cannot move the uplift in any direction, so its key alone never makes a healthy vault sealable.
    function test_I4_2_GuardianCannotMoveTheUplift() public {
        uint256 v = _prepare();
        uint256 coll0 = _coll(v);
        (uint16 bps0, uint32 lead0) = backer.uplift();
        uint16[4] memory bps = [uint16(20_000), bps0 + 1, bps0, 0];
        uint32[4] memory leads = [uint32(3 days), lead0, lead0 + 1, 0];
        for (uint256 i; i < bps.length; ++i) {
            vm.prank(guardian);
            vm.expectRevert(abi.encodeWithSignature("NotAllowed()"));
            backer.setUplift(bps[i], leads[i]);
        }
        (uint16 bps1, uint32 lead1) = backer.uplift();
        assertEq(bps1, bps0);
        assertEq(lead1, lead0);
        vm.prank(carol);
        _sealRefused(v);
        assertEq(_coll(v), coll0, "collateral untouched");
        assertEq(_debt(v), 500e18, "debt untouched");
    }

    /// What the guardian keeps on the backer: the mint pause. It moves no funds and leaves every vault as healthy as
    /// it was; repay and deposit stay open.
    function test_I4_2_GuardianKeepsTheMintPause() public {
        uint256 v = _prepare();
        vm.prank(guardian);
        backer.setMintPaused(true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("PAUSED")));
        backer.mint(v, 1e18, true, 0);
        vm.prank(carol);
        _sealRefused(v);
        vm.prank(bob);
        backer.repay(v, 100e18);
        assertEq(_debt(v), 400e18);
    }

    /// The admin (the timelock in production) still sets the uplift, inside the same bounds.
    function test_I4_2_AdminSetsTheUplift() public {
        vm.prank(admin);
        backer.setUplift(6000, 3 hours);
        (uint16 bps, uint32 lead) = backer.uplift();
        assertEq(bps, 6000);
        assertEq(lead, 3 hours);
    }
}

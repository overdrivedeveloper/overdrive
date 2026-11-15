// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BackerFixture} from "./BackerFixture.sol";
import {GearStatus} from "overdrive/interfaces/ODTypes.sol";
import {ODBacker} from "overdrive/backer/ODBacker.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/// MockUSDG that keeps 1 unit of every transfer into one chosen account (a fee-on-transfer dollar). The target
/// sits in a hashed slot so the code can be etched over a live MockUSDG without touching its storage layout.
contract ShortUSDG is MockUSDG {
    bytes32 private constant TARGET_SLOT = keccak256("mutation.short-usdg.target");

    function setShortTarget(address t) external {
        bytes32 s = TARGET_SLOT;
        assembly {
            sstore(s, t)
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        bytes32 s = TARGET_SLOT;
        address t;
        assembly {
            t := sload(s)
        }
        if (from != address(0) && to == t && value != 0) {
            super._update(from, address(0xdead), 1);
            value -= 1;
        }
        super._update(from, to, value);
    }
}

/// Tests added from mutation testing (docs/reviews/mutation-2026-11-15.md): each pins a behaviour that a surviving
/// mutant showed no test checked.
contract BackerMutationKillsTest is BackerFixture {
    /// Kills m0492 (ODBacker repayWithUsdg: the settled-gear cost line commented out, so the buy-back was free).
    /// A settled gear repays at its settled value with no spread, Ceil, paid from collateral.
    function test_RepayWithUsdgSettledGearPaysSettledValue() public {
        uint256 id = _open(alice, sport, 1_000e6);
        uint256 proceeds = _mint(alice, id, 400e18, true);
        stockOf[TSLA].setOraclePaused(true);
        guard.poke(TSLA);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(admin);
        minter.settleGear(sport);
        vm.prank(admin);
        reg.setStatus(sport, GearStatus.SETTLED);
        uint256 settled = minter.settledValue(sport);
        assertGt(settled, 0);
        backer.repay(id, 0); // charges the toll due so far, so the repay below moves collateral by the cost only
        uint256 coll0 = _coll(id);
        assertLe(coll0, 1_000e6 + proceeds);
        uint256 expected = Math.mulDiv(100e18, settled, 1e30, Math.Rounding.Ceil);
        assertGt(expected, 0);
        vm.prank(alice);
        uint256 cost = backer.repayWithUsdg(id, 100e18, type(uint256).max);
        assertEq(cost, expected, "settled value, no spread, Ceil");
        assertEq(_coll(id), coll0 - cost);
        assertEq(_debt(id), 300e18);
    }

    /// Kills m2319 (ODBacker _pull: `got != amount` relaxed to `got > amount`, so a short receipt was credited in
    /// full). A dollar that delivers less than asked must revert the deposit, not credit the missing unit.
    function test_DepositRevertsWhenUsdgArrivesShort() public {
        uint256 id = _open(alice, sport, 1_000e6);
        vm.etch(address(usdg), address(new ShortUSDG()).code);
        ShortUSDG(address(usdg)).setShortTarget(address(backer));
        usdg.mint(alice, 100e6);
        vm.startPrank(alice);
        usdg.approve(address(backer), 100e6);
        vm.expectRevert(abi.encodeWithSelector(ODBacker.UsdgNotReceived.selector, 100e6, 100e6 - 1));
        backer.deposit(id, 100e6);
        vm.stopPrank();
    }
}

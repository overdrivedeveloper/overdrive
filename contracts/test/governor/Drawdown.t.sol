// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GovernorFixture} from "./GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// R12, VAULT-1: drawdown on the vault's own share price; a plain transfer to the empty vault never reads as a loss.
contract DrawdownTest is GovernorFixture {
    uint256 internal constant SENT = 200_010_814; // the incident amount, sent by plain transfer to the empty vault

    function _tripped() internal view returns (bool t) {
        (,, t) = gov.drawdown();
    }

    function test_DonationThenTinyDepositsNeverTrips() public {
        usdg.mint(address(gov), SENT);
        address a = makeAddr("a");
        address b = makeAddr("b");
        address c = makeAddr("c");
        uint256 sa = _deposit(a, 4e6);
        assertFalse(_tripped());
        uint256 sb = _deposit(b, 2e6);
        assertFalse(_tripped());
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        uint256 sc = _deposit(c, 5_000e6);
        assertFalse(_tripped());
        (bool paused, bytes32 why) = gov.buysPaused();
        assertFalse(paused, string(abi.encodePacked(why)));
        // Fair shares: the same price per USDG for every depositor; the sent USDG went to nobody.
        assertEq(sa * 2, sb * 4);
        assertEq(sc, sa * 1250);
        assertApproxEqAbs(gov.sharePriceWad(), 1e18, 1e12);
        assertEq(gov.totalAssets(), 5_006e6);
        (uint256 peak, uint256 nowWad,) = gov.drawdown();
        assertEq(peak, nowWad);
    }

    function _lossSetup() internal returns (bytes32 id) {
        _deposit(lp, 100_000e6);
        id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 20_000e18, 20_000e6);
        _poke();
        // TSLA up 41.42%: SPORT value doubles, liability +20,000 = -20% of equity.
        guard.set(TSLA, 353.5533905932737622e18, 353.5533905932737622e18);
        _poke();
    }

    function test_RealLossTrips() public {
        bytes32 id = _lossSetup();
        uint256 supply = gov.totalSupply();
        (uint256 peak, uint256 nowWad, bool t) = gov.drawdown();
        assertTrue(t);
        assertApproxEqRel(nowWad, peak * 8 / 10, 1e14);
        assertEq(gov.totalSupply(), supply);
        (bool paused, bytes32 why) = gov.buysPaused();
        assertTrue(paused);
        assertEq(why, bytes32("DRAWDOWN"));
        usdg.mint(alice, 10e6);
        vm.prank(alice);
        usdg.approve(address(minter), 10e6);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.BuysPaused.selector, bytes32("DRAWDOWN")));
        minter.buy(id, alice, alice, 1e18, 10e6, 0);
        // Sells are paid.
        uint256 before = usdg.balanceOf(alice);
        assertTrue(_sell(id, 1_000e18, 2_000e6));
        assertEq(usdg.balanceOf(alice) - before, 2_000e6);
    }

    function test_RecoveryResumes() public {
        bytes32 id = _lossSetup();
        assertTrue(_tripped());
        guard.set(TSLA, 250e18, 250e18);
        _poke();
        assertFalse(_tripped());
        (bool paused,) = gov.buysPaused();
        assertFalse(paused);
        _buy(id, 1e18, 1e6);
    }

    function test_NoPeakReset() public {
        _lossSetup();
        // No admin action moves the peak: parameter writes, pauses, unpauses, skims, pokes.
        vm.startPrank(admin);
        gov.setParams(gov.getParams());
        gov.setBuysPaused(true);
        gov.setBuysPaused(false);
        gov.skim();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _poke();
        assertTrue(_tripped());
        vm.warp(vm.getBlockTimestamp() + 20 days);
        _poke();
        assertTrue(_tripped(), "inside 30 days the old peak still counts");
        // The window is 30 days, after which the old peak ages out by design.
        vm.warp(vm.getBlockTimestamp() + 10 days);
        _poke();
        assertFalse(_tripped());
    }

    /// The same incident on a fork of Robinhood Chain with the real USDG. Skips without RHC_RPC_URL.
    function testFork_DonationBeforeFirstDeposit() public {
        forkOrSkip();
        IERC20 real = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
        setUp(); // mocks for everything but USDG are rebuilt on the fork
        // Swap in the real USDG: a fresh Governor on the fork's USDG.
        _forkRun(real);
    }

    function _forkRun(IERC20 real) internal {
        IODGovernor g = IODGovernor(
            address(
                new ODGovernor(
                    real,
                    admin,
                    guardian,
                    IODGearRegistry(address(reg)),
                    IODOracleGuard(address(guard)),
                    IODInsurance(address(ins)),
                    address(fees)
                )
            )
        );
        vm.prank(admin);
        g.setDepositor(lp, true);
        deal(address(real), address(g), SENT); // the plain transfer
        deal(address(real), lp, 5_006e6);
        vm.startPrank(lp);
        real.approve(address(g), type(uint256).max);
        uint256 s1 = g.deposit(4e6, lp);
        g.deposit(2e6, lp);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        uint256 s3 = g.deposit(5_000e6, lp);
        vm.stopPrank();
        (,, bool t) = g.drawdown();
        assertFalse(t);
        assertEq(s3, s1 * 1250);
        assertEq(g.totalAssets(), 5_006e6);
    }
}

import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {ODInsurance} from "overdrive/governor/ODInsurance.sol";

/// R16: ODInsurance.
contract InsuranceTest is GovernorFixture {
    function _fund(uint256 a) internal {
        usdg.mint(address(this), a);
        usdg.approve(address(ins), a);
        ins.fund(a);
    }

    function test_CoverOnlyCallers() public {
        _fund(100e6);
        vm.prank(stranger);
        vm.expectRevert(IODInsurance.NotCoverer.selector);
        ins.cover(1);
        vm.prank(backerC);
        assertEq(ins.cover(10e6), 10e6);
        vm.prank(address(gov));
        assertEq(ins.cover(10e6), 10e6);
        assertEq(usdg.balanceOf(address(gov)), 10e6);
        // Coverers are set once.
        vm.prank(admin);
        vm.expectRevert(ODInsurance.InvalidParams.selector);
        ins.setCoverers(stranger, address(0));
    }

    function test_CoverMinOfBalance() public {
        _fund(7e6);
        vm.prank(backerC);
        assertEq(ins.cover(100e6), 7e6);
        vm.prank(backerC);
        assertEq(ins.cover(100e6), 0, "empty: 0, no revert");
        assertEq(ins.balance(), 0);
    }
}

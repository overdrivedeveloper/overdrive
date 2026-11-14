// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";
import {Session} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

contract DiscountStake {
    uint16 public d;

    constructor(uint16 d_) {
        d = d_;
    }

    function feeDiscountOf(address) external view returns (uint16) {
        return d;
    }
}

contract RevertingStake {
    function feeDiscountOf(address) external pure returns (uint16) {
        revert("down");
    }
}

contract GasBurnStake {
    function feeDiscountOf(address) external pure returns (uint16) {
        uint256 i;
        while (true) {
            ++i;
        }
        return 1;
    }
}

/// R5: spread = base (x1.5 EXTENDED) + skew (only when |net| grows) - stake discount, capped.
contract SpreadTest is SystemFixture {
    function test_SkewOnlyWhenGrowing() public {
        assertEq(_quote(sport, true, true, 100e6).spreadBps, 30, "small: base only");
        uint16 big = _quote(sport, true, true, 100_000e6).spreadBps;
        assertGt(big, 30, "growing |net|: skew");
        uint256 t = _buy(alice, sport, 100_000e6);
        assertEq(_quote(sport, false, true, t).spreadBps, 30, "shrinking |net|: no skew");
        assertGt(_quote(sport, true, true, 100_000e6).spreadBps, big, "skew rises with net");
    }

    function test_ExtendedWider() public {
        _session(Session.EXTENDED);
        _price(TSLA, _p(TSLA));
        assertEq(_quote(sport, true, true, 100e6).spreadBps, 45);
        uint256 t = _buy(alice, sport, 1_000e6);
        assertEq(_quote(sport, false, true, t).spreadBps, 45);
    }

    function test_CapApplies() public {
        IODMinter.TradeParams memory p = minter.tradeParams();
        p.maxTotalSpreadBps = 35;
        _setTradeParams(p);
        assertEq(_quote(sport, true, true, 150_000e6).spreadBps, 35);
        // skew is capped at maxSkewBps too
        p.maxTotalSpreadBps = 1000;
        p.inventorySlopeBps = 10_000;
        _setTradeParams(p);
        assertEq(_quote(sport, true, true, 150_000e6).spreadBps, 30 + p.maxSkewBps);
    }

    function test_StakeDiscountApplies() public {
        address stDiscountStake2 = address(new DiscountStake(10));
        vm.prank(admin);
        minter.setStake(stDiscountStake2);
        vm.prank(alice);
        assertEq(minter.quote(sport, true, true, 100e6).spreadBps, 20);
        address stDiscountStake4 = address(new DiscountStake(9000));
        vm.prank(admin);
        minter.setStake(stDiscountStake4);
        vm.prank(alice);
        assertEq(minter.quote(sport, true, true, 100e6).spreadBps, 0, "never below zero");
    }

    function test_StakeReadFailureIsZero() public {
        address stRevertingStake0 = address(new RevertingStake());
        vm.prank(admin);
        minter.setStake(stRevertingStake0);
        vm.prank(alice);
        assertEq(minter.quote(sport, true, true, 100e6).spreadBps, 30);
        assertGt(_buy(alice, sport, 1_000e6), 0);
        address stGasBurnStake0 = address(new GasBurnStake());
        vm.prank(admin);
        minter.setStake(stGasBurnStake0);
        vm.prank(alice);
        assertEq(minter.quote(sport, true, true, 100e6).spreadBps, 30);
        assertGt(_buy(alice, sport, 1_000e6), 0, "a gas-burning stake cannot block buys");
    }

    function test_TradeParamsBounds() public {
        IODMinter.TradeParams memory p = minter.tradeParams();
        p.usageMaxWad = 0.21e18;
        vm.prank(admin);
        vm.expectRevert(IODMinter.InvalidParams.selector);
        minter.setTradeParams(p);
        IODMinter.TradeParams memory ok = minter.tradeParams();
        vm.prank(stranger);
        vm.expectRevert();
        minter.setTradeParams(ok);
    }
}

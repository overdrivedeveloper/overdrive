// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GovernorFixture} from "./GovernorFixture.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";
import {ODIndex} from "overdrive/math/ODIndex.sol";

/// R11: exact power shocks per market, hedge credit only while fresh, no diversification credit.
contract StressTest is GovernorFixture {
    function setUp() public override {
        super.setUp();
        _deposit(lp, 1_000_000e6);
    }

    function _loss(bytes32 m) internal view returns (uint256 l) {
        (l,) = gov.cachedStress(m);
    }

    function test_ExactPowerShock() public {
        bytes32 s = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(s, 10_000e18, 10_000e6);
        assertEq(_loss(TSLA), 5_625e18);
        bytes32 r = _list(NVDA, NONE, Gear.REVERSE, 1_000_000e18);
        _buy(r, 3_000e18, 3_000e6);
        // REVERSE short loses on the down shock: 3,000 x (1/0.75 - 1) = 1,000 (index rounded up)
        assertEq(_loss(NVDA), 3_000e18 * (ODIndex.shockFactor(Gear.REVERSE, -0.25e18, Math.Rounding.Ceil) - 1e18) / 1e18);
        assertApproxEqAbs(_loss(NVDA), 1_000e18, 1e6);
        bytes32 c = _list(SPY, NONE, Gear.CRUISE, 1_000_000e18); // ETF group: 15%
        _buy(c, 4_000e18, 4_000e6);
        assertEq(_loss(SPY), 4_000e18 * (ODIndex.shockFactor(Gear.CRUISE, 0.15e18, Math.Rounding.Ceil) - 1e18) / 1e18);
        (uint256 total,) = gov.stressLoss();
        assertEq(total, _loss(TSLA) + _loss(NVDA) + _loss(SPY));
    }

    function test_StaleHedgeCountsZero() public {
        bytes32 s = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(s, 10_000e18, 10_000e6);
        vm.prank(hedger);
        gov.postHedge(TSLA, 20_000e18, 0, uint64(vm.getBlockTimestamp()));
        _poke();
        // with the hedge: max(5,625 - 5,000, -4,375 + 5,000, ...) = 625
        assertEq(_loss(TSLA), 625e18);
        vm.warp(vm.getBlockTimestamp() + 2 hours + 1);
        _poke();
        assertEq(_loss(TSLA), 5_625e18);
    }

    function test_NoDiversificationCredit() public {
        bytes32 a = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        bytes32 b = _list(NVDA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(a, 10_000e18, 10_000e6);
        _buy(b, 10_000e18, 10_000e6);
        // A short hedge on NVDA does not lower TSLA's loss; each market counts its own worst case.
        vm.prank(hedger);
        gov.postHedge(NVDA, -100_000e18, 0, uint64(vm.getBlockTimestamp()));
        _poke();
        (uint256 total,) = gov.stressLoss();
        assertEq(_loss(TSLA), 5_625e18);
        assertEq(total, _loss(TSLA) + _loss(NVDA));
        assertGt(_loss(NVDA), 5_625e18, "a wrong-way hedge adds loss");
        // A pair is stressed on the ratio, once, under its numerator, and adds to the singles.
        bytes32 p = _list(TSLA, NVDA, Gear.SPORT, 1_000_000e18);
        _buy(p, 10_000e18, 10_000e6);
        assertEq(_loss(TSLA), 5_625e18 + 4_400e18);
    }

    function testFuzz_StressMatchesBruteForce(uint256 ts, uint256 te, uint256 tr, int256 hedge, uint256 price)
        public
    {
        ts = bound(ts, 0, 50_000e18);
        te = bound(te, 0, 50_000e18);
        tr = bound(tr, 0, 50_000e18);
        hedge = bound(hedge, -200_000e18, 200_000e18);
        price = bound(price, 150e18, 400e18);
        bytes32[3] memory ids =
            [_list(TSLA, NONE, Gear.SPORT, 1e30), _list(TSLA, NONE, Gear.ECO, 1e30), _list(TSLA, NONE, Gear.REVERSE, 1e30)];
        uint256[3] memory amt = [ts, te, tr];
        for (uint256 i; i < 3; ++i) {
            if (amt[i] != 0) minterMint(ids[i], amt[i]);
        }
        guard.set(TSLA, price, price);
        vm.prank(hedger);
        gov.postHedge(TSLA, hedge, 0, uint64(vm.getBlockTimestamp()));
        _poke();
        // brute force: every shock, every gear, from the definitions
        Gear[3] memory gs = [Gear.SPORT, Gear.ECO, Gear.REVERSE];
        int256 worst;
        int256[4] memory shocks = [int256(-0.25e18), -0.125e18, 0.125e18, 0.25e18];
        for (uint256 k; k < 4; ++k) {
            int256 l;
            for (uint256 i; i < 3; ++i) {
                if (amt[i] == 0) continue;
                (uint256 v,) = ODIndex.value(gs[i], price, 250e18, 1e18, 1e18, Math.Rounding.Ceil);
                int256 val = int256(Math.mulDiv(amt[i], v, 1e18, Math.Rounding.Ceil));
                int256 f = int256(ODIndex.shockFactor(gs[i], shocks[k], Math.Rounding.Ceil)) - 1e18;
                l += val * f / 1e18;
            }
            l -= hedge * shocks[k] / 1e18;
            if (l > worst) worst = l;
        }
        assertEq(_loss(TSLA), uint256(worst));
    }

    /// Mints holder supply directly (stress view only; caps not involved).
    function minterMint(bytes32 id, uint256 amount) internal {
        address t = reg.gear(id).token;
        vm.prank(address(minter));
        (bool ok,) = t.call(abi.encodeWithSignature("mint(address,uint256)", alice, amount));
        require(ok);
    }
}

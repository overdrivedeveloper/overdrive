// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ForkSystem} from "./ForkSystem.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// Gas of one hook buy (NVDA SPORT, 1,000 USDG, exact in, real PoolManager, every touched account cold) and of the
/// keeper's `pokeRisk` as the listed gear count grows 1, 5, 10, 20, 40, every gear holding supply (worst case for the
/// loops). The buy path loops the gears of ITS market only (registry cap MAX_GEARS_PER_MARKET = 12): NVDA reaches 12 at
/// gear 12 (4 single names + 8 NVDA/x pairs), the rest list on other markets. `pokeRisk` loops every listed gear.
contract GearCountGasForkTest is ForkSystem {
    struct G {
        bytes32 a;
        bytes32 b;
        Gear g;
    }

    G[] internal order;

    function _listLaunchSet() internal override {}

    function _o(bytes32 a, bytes32 b, Gear g) internal {
        order.push(G(a, b, g));
    }

    function _plan() internal {
        _o(NVDA, NONE, Gear.SPORT);
        _o(NVDA, NONE, Gear.CRUISE);
        _o(NVDA, NONE, Gear.ECO);
        _o(NVDA, NONE, Gear.REVERSE);
        bytes32[8] memory bs = [AMD, TSLA, SPY, QQQ, MSTR, AAPL, MSFT, META];
        for (uint256 i; i < 8; ++i) {
            _o(NVDA, bs[i], Gear.SPORT);
        }
        Gear[4] memory four = [Gear.CRUISE, Gear.SPORT, Gear.ECO, Gear.REVERSE];
        bytes32[6] memory singles = [TSLA, ETH, BTC, AAPL, MSFT, AMZN];
        for (uint256 i; i < 6; ++i) {
            for (uint256 j; j < 4; ++j) {
                _o(singles[i], NONE, four[j]);
            }
        }
        for (uint256 g; g < 5; ++g) {
            _o(SPY, NONE, Gear(g));
        }
    }

    function _coolAll() internal {
        address[9] memory core = [
            address(gov),
            address(minter),
            address(reg),
            address(guard),
            address(hook),
            address(vol),
            RHC_POOL_MANAGER,
            USDG,
            PYTH_CORE
        ];
        for (uint256 i; i < core.length; ++i) {
            vm.cool(core[i]);
        }
        vm.cool(address(mh));
        vm.cool(address(fees));
        vm.cool(address(ins));
        vm.cool(address(router));
        for (uint256 i; i < allMarkets.length; ++i) {
            vm.cool(mk[allMarkets[i]].feed);
            if (mk[allMarkets[i]].token != address(0)) vm.cool(mk[allMarkets[i]].token);
        }
        for (uint256 i; i < allGears.length; ++i) {
            vm.cool(address(_token(allGears[i])));
        }
    }

    function test_GasPerBuyVsGearCount() public {
        _plan();
        uint256[5] memory marks = [uint256(1), 5, 10, 20, 40];
        uint256[5] memory buyGas;
        uint256[5] memory pokeGas;
        uint256[5] memory onMarket;
        uint256 k;
        bytes32 target;
        for (uint256 i; i < 40; ++i) {
            G memory x = order[i];
            if (x.b != NONE && sigmaOf[vol.pairKey(x.a, x.b)] == 0) postVol(vol.pairKey(x.a, x.b), 3500);
            bytes32 id = _listOne(x.a, x.b, x.g);
            if (i == 0) target = id;
            _buy(carol, id, 200e6); // every gear holds supply
            if (i + 1 == marks[k]) {
                _warpFresh(60);
                _fundUsdg(alice, 1_000e6);
                (PoolKey memory key, IPoolManager.SwapParams memory p) = _keyParams(target, true, 1_000e6);
                vm.prank(alice);
                usdg.approve(address(router), 1_000e6);
                _coolAll();
                vm.prank(alice);
                uint256 g0 = gasleft();
                router.swapExactIn(key, p);
                buyGas[k] = g0 - gasleft();
                _coolAll();
                g0 = gasleft();
                gov.pokeRisk(riskMarkets);
                pokeGas[k] = g0 - gasleft();
                onMarket[k] = reg.gearsOfMarket(NVDA).length;
                console2.log("gears listed / on NVDA", marks[k], onMarket[k]);
                console2.log("  hook buy gas, pokeRisk gas", buyGas[k], pokeGas[k]);
                ++k;
                if (k == 5) break;
            }
        }
        assertEq(onMarket[4], 12, "NVDA at the per-market cap");
        assertLt(buyGas[4], 30_000_000, "buy fits a block");
        // the buy path is bounded by the per-market cap: 20 to 40 gears adds no per-market work
        assertLt(buyGas[4], buyGas[3] * 115 / 100, "buy gas bounded past the per-market cap");
    }
}

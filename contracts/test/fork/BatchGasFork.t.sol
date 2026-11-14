// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {ForkSystem} from "./ForkSystem.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// Backer batch gas on the real chain fixture. Robinhood Chain (Arbitrum Orbit) caps one transaction at 32M gas, so a
/// full MAX_BATCH seal and execute must fit with headroom: both are asserted under 24M. Every vault is a deep crash
/// (ETH SPORT, ETH up 60%: debt value about 1,150 USDG on 1,000 USDG collateral), so each one asks insurance for the
/// shortfall: the most expensive vault there is. Gas is measured cold (vm.cool on every touched contract), and the
/// lowest gas limit that executes is found by bisection (M-6: the MIN_VAULT_GAS floor before each vault).
contract BatchGasForkTest is ForkSystem {
    uint256 internal constant LIMIT = 24_000_000;
    bytes32 internal gid;
    uint256[] internal ids;

    function _openDeep(uint256 count) internal {
        gid = gearOf[ETH][Gear.SPORT];
        _fundUsdg(address(this), 1_000_000e6);
        usdg.approve(address(ins), 1_000_000e6);
        ins.fund(1_000_000e6);
        (uint256 v,) = minter.valuePerToken(gid);
        uint256 tokens = 450e18 * 1e18 / v;
        _fundUsdg(carol, count * 1_000e6);
        vm.startPrank(carol);
        usdg.approve(address(backer), type(uint256).max);
        for (uint256 i; i < count; ++i) {
            uint256 id = backer.openVault(gid, 1_000e6);
            backer.mint(id, tokens, false, 0);
            ids.push(id);
        }
        vm.stopPrank();
        walkPrice(ETH, 6000);
        _refresh();
    }

    function _first(uint256 n) internal view returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = ids[i];
        }
    }

    function _cool() internal {
        vm.cool(address(backer));
        vm.cool(address(gov));
        vm.cool(address(minter));
        vm.cool(address(reg));
        vm.cool(address(guard));
        vm.cool(address(ins));
        vm.cool(address(fees));
        vm.cool(address(vol));
        vm.cool(address(mh));
        vm.cool(USDG);
        vm.cool(PYTH_CORE);
        vm.cool(mk[ETH].feed);
        vm.cool(address(_token(gid)));
    }

    /// Seals the first `n` vaults, waits SEAL_DELAY with fresh inputs; returns (batchId, seal gas).
    function _seal(uint256 n) internal returns (uint256 b, uint256 sealGas) {
        uint256[] memory sel = _first(n);
        _cool();
        uint256 g0 = gasleft();
        b = backer.sealBatch(gid, sel);
        sealGas = g0 - gasleft();
        assertEq(backer.batch(b).vaultIds.length, n, "every vault sealed");
        _warpFresh(backer.SEAL_DELAY());
    }

    function _execAt(uint256 b, uint256 limit) internal returns (bool ok, uint256 used) {
        _cool();
        vm.prank(alice);
        uint256 g0 = gasleft();
        (ok,) = address(backer).call{gas: limit}(abi.encodeCall(backer.executeBatch, (b)));
        used = g0 - gasleft();
        ok = ok && backer.batch(b).done;
    }

    /// Lowest gas limit (to 10k) at which executing `b` succeeds and closes the batch.
    function _minLimit(uint256 b) internal returns (uint256 hi) {
        uint256 lo = 100_000;
        hi = 60_000_000;
        while (hi - lo > 10_000) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = _execAt(b, mid);
            vm.revertToState(snap);
            _remock();
            if (ok) hi = mid;
            else lo = mid;
        }
    }

    function test_ExecuteGasPerVaultCount() public {
        uint256 max = backer.MAX_BATCH();
        _openDeep(max);
        uint256[5] memory counts = [uint256(1), 10, 20, 30, max];
        uint256 insBefore = ins.balance();
        for (uint256 k; k < counts.length; ++k) {
            uint256 n = counts[k];
            uint256 snap = vm.snapshotState();
            (uint256 b, uint256 sealGas) = _seal(n);
            uint256 minLim = _minLimit(b);
            (bool ok, uint256 used) = _execAt(b, 30_000_000);
            assertTrue(ok, "executes");
            assertLt(ins.balance(), insBefore, "deep crash draws insurance");
            console2.log("vaults", n);
            console2.log("  seal gas, execute gas used", sealGas, used);
            console2.log("  lowest execute gas limit, per vault", minLim, minLim / n);
            vm.revertToState(snap);
            _remock();
        }
    }

    /// A full MAX_BATCH of deep-crash vaults seals and executes inside 24M each (chain cap 32M).
    function test_MaxBatchFitsUnder24M() public {
        uint256 max = backer.MAX_BATCH();
        _openDeep(max);
        uint256[] memory sel = _first(max);
        _cool();
        (bool sealOk, bytes memory ret) = address(backer).call{gas: LIMIT}(abi.encodeCall(backer.sealBatch, (gid, sel)));
        assertTrue(sealOk, "full batch seals under 24M");
        uint256 b = abi.decode(ret, (uint256));
        _warpFresh(backer.SEAL_DELAY());
        (bool ok,) = _execAt(b, LIMIT);
        assertTrue(ok, "full batch executes under 24M");
        for (uint256 i; i < max; ++i) {
            (,, uint256 debt,,) = _vaultOf(ids[i]);
            assertEq(debt, 0, "liquidated");
        }
    }

    function _vaultOf(uint256 id) internal view returns (address, bytes32, uint256, uint256, uint256) {
        (address o, bytes32 g, uint256 c, uint256 d, uint256 bid) = backer.vault(id);
        return (o, g, d, c, bid);
    }
}

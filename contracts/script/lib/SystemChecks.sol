// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {DeploymentFile} from "./DeploymentFile.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";
import {ODTwapReader} from "overdrive/oracle/ODTwapReader.sol";
import {ODOracleGuard} from "overdrive/oracle/ODOracleGuard.sol";
import {ODVolOracle} from "overdrive/oracle/ODVolOracle.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {ODInsurance} from "overdrive/governor/ODInsurance.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {ODBacker} from "overdrive/backer/ODBacker.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";
import {ODPaymaster} from "overdrive/agent/ODPaymaster.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";
import {GearConfig, MarketConfig} from "overdrive/interfaces/ODTypes.sol";

/// @title SystemChecks
/// @notice The read-only live check of a deployment against its config (todo 11 rule R8). Every failure is one line
/// starting with its check tag: CHAIN CODE WIRING ROLE DELAY HOOK_FLAGS POOL FEED MARKET_CONFIG ORC-CARD CAP SEEDED
/// GEAR_CAP. An empty list is a pass.
abstract contract SystemChecks is DeploymentFile {
    using StateLibrary for IPoolManager;

    /// The backer's sealed batch was measured under the liquidator's TX_GAS_CAP (24M) at MAX_BATCH 50 (BatchGasFork).
    uint256 internal constant MAX_BATCH_UNDER_TX_GAS_CAP = 50;

    struct Acc {
        string[] f;
        uint256 n;
    }

    function _fail(Acc memory a, string memory tag, string memory what) private pure {
        if (a.n < a.f.length) a.f[a.n] = string.concat(tag, ": ", what);
        ++a.n;
    }

    function checkSystem(Config memory c, Deployed memory d, address deployer)
        public
        view
        returns (string[] memory out)
    {
        Acc memory a = Acc(new string[](256), 0);
        bool fork =
            keccak256(bytes(c.network)) == keccak256("fork") || keccak256(bytes(c.network)) == keccak256("anvil");
        if (!fork && block.chainid != c.chainId) _fail(a, "CHAIN", "RPC chain id differs from the config");
        if (_checkCode(a, d)) {
            _checkWiring(a, c, d);
            _checkRoles(a, c, d, deployer);
            _checkTimelock(a, c, d, deployer);
            _checkHookAndPools(a, c, d);
            _checkMarkets(a, c, d);
            _checkGears(a, c, d);
            _checkSeed(a, d);
        }
        uint256 n = a.n < a.f.length ? a.n : a.f.length;
        out = a.f;
        assembly {
            mstore(out, n)
        }
    }

    function _checkCode(Acc memory a, Deployed memory d) private view returns (bool ok) {
        address[18] memory all = [
            d.timelock,
            d.usdg,
            d.ovrd,
            d.poolManager,
            d.marketHours,
            d.guard,
            d.vol,
            d.registry,
            d.factory,
            d.insurance,
            d.fees,
            d.governor,
            d.minter,
            d.backer,
            d.hook,
            d.stake,
            d.agentRouter,
            d.paymaster
        ];
        ok = true;
        for (uint256 i; i < all.length; ++i) {
            if (all[i] == address(0) || all[i].code.length == 0) {
                _fail(a, "CODE", string.concat("no code at slot ", vm.toString(i), " ", vm.toString(all[i])));
                ok = false;
            }
        }
    }

    /// A pointer read that never reverts: a wrong or missing getter reads as address(0) and fails the comparison.
    function _get(address target, string memory sig) private view returns (address v) {
        (bool ok, bytes memory r) = target.staticcall(abi.encodeWithSignature(sig));
        if (ok && r.length >= 32) v = abi.decode(r, (address));
    }

    function _getB(address target, bytes memory data) private view returns (address v) {
        (bool ok, bytes memory r) = target.staticcall(data);
        if (ok && r.length >= 32) v = abi.decode(r, (address));
    }

    function _eq(Acc memory a, address target, string memory sig, address want, string memory what) private view {
        if (_get(target, sig) != want) _fail(a, "WIRING", what);
    }

    function _checkWiring(Acc memory a, Config memory c, Deployed memory d) private view {
        _eq(a, d.governor, "minter()", d.minter, "governor.minter");
        _eq(a, d.governor, "backer()", d.backer, "governor.backer");
        _eq(a, d.governor, "hedgerWallet()", c.roles.hedger, "governor.hedgerWallet");
        _eq(a, d.governor, "registry()", d.registry, "governor.registry");
        _eq(a, d.governor, "guard()", d.guard, "governor.guard");
        _eq(a, d.governor, "insurance()", d.insurance, "governor.insurance");
        _eq(a, d.governor, "fees()", d.fees, "governor.fees");
        _eq(a, d.registry, "minter()", d.minter, "registry.minter");
        _eq(a, d.registry, "guard()", d.guard, "registry.guard");
        _eq(a, d.registry, "vol()", d.vol, "registry.vol");
        _eq(a, d.registry, "factory()", d.factory, "registry.factory");
        _eq(a, d.minter, "hook()", d.hook, "minter.hook");
        _eq(a, d.minter, "poolManager()", d.poolManager, "minter.poolManager");
        _eq(a, d.minter, "stake()", d.stake, "minter.stake");
        _eq(a, d.minter, "governor()", d.governor, "minter.governor");
        _eq(a, d.minter, "registry()", d.registry, "minter.registry");
        _eq(a, d.minter, "guard()", d.guard, "minter.guard");
        _eq(a, d.minter, "vol()", d.vol, "minter.vol");
        _eq(a, d.minter, "fees()", d.fees, "minter.fees");
        _eq(a, d.backer, "stake()", d.stake, "backer.stake");
        _eq(a, d.backer, "minter()", d.minter, "backer.minter");
        _eq(a, d.backer, "governor()", d.governor, "backer.governor");
        _eq(a, d.backer, "registry()", d.registry, "backer.registry");
        _eq(a, d.backer, "guard()", d.guard, "backer.guard");
        _eq(a, d.backer, "marketHours()", d.marketHours, "backer.marketHours");
        _eq(a, d.backer, "insurance()", d.insurance, "backer.insurance");
        _eq(a, d.backer, "fees()", d.fees, "backer.fees");
        _eq(a, d.hook, "minter()", d.minter, "hook.minter");
        _eq(a, d.hook, "registry()", d.registry, "hook.registry");
        _eq(a, d.hook, "poolManager()", d.poolManager, "hook.poolManager");
        _eq(a, d.hook, "usdg()", d.usdg, "hook.usdg");
        _eq(a, d.hook, "governor()", d.governor, "hook.governor");
        _eq(a, d.insurance, "governor()", d.governor, "insurance.governor");
        _eq(a, d.insurance, "backer()", d.backer, "insurance.backer");
        _eq(a, d.stake, "governor()", d.governor, "stake.governor");
        _eq(a, d.stake, "backer()", d.backer, "stake.backer");
        _eq(a, d.stake, "ovrd()", d.ovrd, "stake.ovrd");
        _eq(a, d.agentRouter, "MINTER()", d.minter, "agentRouter.MINTER");
        _eq(a, d.agentRouter, "BACKER()", d.backer, "agentRouter.BACKER");
        _eq(a, d.agentRouter, "REGISTRY()", d.registry, "agentRouter.REGISTRY");
        _eq(a, d.guard, "marketHours()", d.marketHours, "guard.marketHours");
        _eq(a, d.guard, "pyth()", c.ext.pythCore, "guard.pyth");
        _eq(a, d.vol, "signer()", c.roles.volSigner, "vol.signer");
        _eq(a, d.paymaster, "ENTRY_POINT()", c.ext.entryPoint, "paymaster.ENTRY_POINT");
        ODFees f = ODFees(d.fees);
        bytes4 sel = bytes4(keccak256("recipientOf(bytes32)"));
        if (_getB(d.fees, abi.encodeWithSelector(sel, f.B_GOVERNOR())) != d.governor) {
            _fail(a, "WIRING", "fees GOVERNOR");
        }
        if (_getB(d.fees, abi.encodeWithSelector(sel, f.B_STAKERS())) != d.stake) _fail(a, "WIRING", "fees STAKERS");
        if (_getB(d.fees, abi.encodeWithSelector(sel, f.B_TREASURY())) != c.roles.treasury) {
            _fail(a, "WIRING", "fees TREASURY");
        }
        if (!IAccessControl(d.stake).hasRole(ODStake(d.stake).FEES_ROLE(), d.fees)) {
            _fail(a, "WIRING", "stake FEES_ROLE");
        }
        if (!f.isNotifier(d.governor) || !f.isNotifier(d.backer)) _fail(a, "WIRING", "fees notifiers");
    }

    function _role(Acc memory a, address core, bytes32 role, address who, bool want, string memory what) private view {
        if (IAccessControl(core).hasRole(role, who) != want) _fail(a, "ROLE", what);
    }

    function _checkRoles(Acc memory a, Config memory c, Deployed memory d, address deployer) private view {
        Roles memory r = c.roles;
        address[] memory cores = adminCores(d);
        for (uint256 i; i < cores.length; ++i) {
            string memory at = vm.toString(cores[i]);
            _role(a, cores[i], 0x00, d.timelock, true, string.concat("timelock not admin of ", at));
            _role(a, cores[i], 0x00, deployer, false, string.concat("deployer still admin of ", at));
            _role(a, cores[i], 0x00, r.ownerSafe, false, string.concat("owner Safe admin directly of ", at));
            _role(a, cores[i], 0x00, r.guardianSafe, false, string.concat("guardian admin of ", at));
            _role(a, cores[i], 0x00, r.keeper, false, string.concat("keeper admin of ", at));
            _role(a, cores[i], 0x00, r.hedger, false, string.concat("hedger admin of ", at));
            _role(a, cores[i], ODRoles.GUARDIAN_ROLE, deployer, false, string.concat("deployer guardian of ", at));
            _role(a, cores[i], ODRoles.GUARDIAN_ROLE, r.ownerSafe, false, string.concat("owner Safe guardian of ", at));
            _role(a, cores[i], ODRoles.KEEPER_ROLE, deployer, false, string.concat("deployer keeper of ", at));
            _role(a, cores[i], ODRoles.HEDGER_ROLE, deployer, false, string.concat("deployer hedger of ", at));
        }
        address[6] memory guarded = [d.guard, d.vol, d.registry, d.governor, d.minter, d.backer];
        for (uint256 i; i < guarded.length; ++i) {
            _role(a, guarded[i], ODRoles.GUARDIAN_ROLE, r.guardianSafe, true, "guardian Safe missing GUARDIAN_ROLE");
        }
        _role(a, d.stake, ODRoles.GUARDIAN_ROLE, r.guardianSafe, true, "guardian Safe missing GUARDIAN_ROLE on stake");
        _role(a, d.governor, ODRoles.HEDGER_ROLE, r.hedger, true, "hedger bot missing HEDGER_ROLE");
        _role(a, d.marketHours, ODRoles.KEEPER_ROLE, r.keeper, true, "keeper bot missing KEEPER_ROLE");
        if (r.guardianSafe == r.ownerSafe || r.guardianSafe == r.keeper || r.guardianSafe == r.hedger) {
            _fail(a, "ROLE", "guardian equals the owner Safe or a bot");
        }
        ODPaymaster p = ODPaymaster(payable(d.paymaster));
        if (p.owner() != d.timelock) _fail(a, "ROLE", "paymaster owner is not the timelock");
        if (p.pendingOwner() != address(0)) _fail(a, "ROLE", "paymaster has a pending owner");
        if (p.guardian() != r.guardianSafe) _fail(a, "ROLE", "paymaster guardian");
    }

    function _checkTimelock(Acc memory a, Config memory c, Deployed memory d, address deployer) private view {
        TimelockController t = TimelockController(payable(d.timelock));
        if (t.getMinDelay() != c.minDelay || c.minDelay != MIN_DELAY) {
            _fail(a, "DELAY", "timelock delay is not 172800");
        }
        address o = c.roles.ownerSafe;
        _role(a, d.timelock, t.PROPOSER_ROLE(), o, true, "owner Safe not proposer");
        _role(a, d.timelock, t.CANCELLER_ROLE(), o, true, "owner Safe not canceller");
        _role(a, d.timelock, t.EXECUTOR_ROLE(), o, true, "owner Safe not executor");
        _role(a, d.timelock, t.EXECUTOR_ROLE(), address(0), false, "timelock executor is open");
        _role(a, d.timelock, t.PROPOSER_ROLE(), deployer, false, "deployer is a proposer");
        _role(a, d.timelock, t.EXECUTOR_ROLE(), deployer, false, "deployer is an executor");
        _role(a, d.timelock, 0x00, deployer, false, "deployer is timelock admin");
        _role(a, d.timelock, 0x00, d.timelock, true, "timelock does not administer itself");
        _role(a, d.timelock, t.PROPOSER_ROLE(), c.roles.guardianSafe, false, "guardian is a proposer");
    }

    function _checkHookAndPools(Acc memory a, Config memory, Deployed memory d) private view {
        if (uint160(d.hook) & 0x3FFF != ODHookMiner.FLAGS) _fail(a, "HOOK_FLAGS", "hook address permission bits");
        ODGearRegistry reg = ODGearRegistry(d.registry);
        uint256 n = reg.gearCount();
        for (uint256 i; i < n; ++i) {
            bytes32 id = reg.gearIdAt(i);
            (bool okP, bytes memory rp) = d.hook.staticcall(abi.encodeCall(ODHook.poolIdOf, (id)));
            bytes32 pid = okP && rp.length >= 32 ? abi.decode(rp, (bytes32)) : bytes32(0);
            (uint160 sqrtP,,,) = IPoolManager(d.poolManager).getSlot0(PoolId.wrap(pid));
            if (pid == bytes32(0) || sqrtP == 0) {
                _fail(a, "POOL", string.concat("pool not initialised ", vm.toString(id)));
            }
        }
    }

    function _checkMarkets(Acc memory a, Config memory c, Deployed memory d) private view {
        for (uint256 i; i < c.markets.length; ++i) {
            MarketCfg memory m = c.markets[i];
            (bool ok, bytes memory r) = m.cfg.feed.staticcall(abi.encodeWithSignature("aggregator()"));
            if (!ok || r.length < 32 || abi.decode(r, (address)) == address(0)) {
                _fail(a, "FEED", string.concat(m.symbol, " feed proxy does not answer aggregator()"));
            }
            MarketConfig memory got = ODOracleGuard(d.guard).config(m.id);
            if (keccak256(abi.encode(got)) != keccak256(abi.encode(m.cfg))) {
                _fail(a, "MARKET_CONFIG", string.concat(m.symbol, " differs from the feeds.json config"));
            }
            (uint64 lo, uint64 hi) = ODVolOracle(d.vol).bounds(m.id);
            if (lo != m.volFloorBps || hi != m.volCeilingBps) {
                _fail(a, "MARKET_CONFIG", string.concat(m.symbol, " vol bounds"));
            }
            if (m.cfg.twapPool != address(0) && ODTwapReader.oldestObservationAge(m.cfg.twapPool) < m.cfg.twapWindow) {
                _fail(a, "ORC-CARD", string.concat(m.symbol, " v3 pool observations shorter than the TWAP window"));
            }
        }
    }

    function _checkGears(Acc memory a, Config memory c, Deployed memory d) private view {
        ODGearRegistry reg = ODGearRegistry(d.registry);
        uint256 n = reg.gearCount();
        if (n > MAX_GEARS || reg.MAX_GEARS() != MAX_GEARS) _fail(a, "GEAR_CAP", "gear count above MAX_GEARS 32");
        if (ODBacker(d.backer).MAX_BATCH() > MAX_BATCH_UNDER_TX_GAS_CAP) {
            _fail(a, "GEAR_CAP", "backer MAX_BATCH above the size measured under TX_GAS_CAP 24M");
        }
        for (uint256 i; i < n; ++i) {
            bytes32 id = reg.gearIdAt(i);
            GearConfig memory g = reg.gear(id);
            bool found;
            for (uint256 k; k < c.gears.length; ++k) {
                GearCfg memory w = c.gears[k];
                if (reg.idOf(w.marketA, w.marketB, w.gear) != id) continue;
                found = true;
                if (g.capUsdWad > w.capUsdWad) {
                    _fail(a, "CAP", string.concat("cap above launch config ", vm.toString(id)));
                }
                if (g.spreadBps < w.spreadBps) {
                    _fail(a, "CAP", string.concat("spread below launch config ", vm.toString(id)));
                }
            }
            if (!found) _fail(a, "CAP", string.concat("gear not in the launch config ", vm.toString(id)));
        }
    }

    function _checkSeed(Acc memory a, Deployed memory d) private view {
        ODGovernor gov = ODGovernor(d.governor);
        uint256 supply = gov.totalSupply();
        uint256 bal = IERC20(d.usdg).balanceOf(d.governor);
        if (supply == 0 && bal != 0) _fail(a, "SEEDED", "Governor holds USDG with no shares (seeded by transfer)");
        if (supply != 0 && gov.trackedCash() == 0) _fail(a, "SEEDED", "Governor shares with no deposited cash");
    }
}

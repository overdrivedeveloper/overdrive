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
import {IODMarketHours, Holiday} from "overdrive/interfaces/IODMarketHours.sol";

/// @title SystemChecks
/// @notice The read-only live check of a deployment against its config (todo 11 rule R8). Every failure is one line
/// starting with its check tag: CHAIN CODE WIRING ROLE DELAY HOOK_FLAGS POOL FEED MARKET_CONFIG ORC-CARD CAP SEEDED
/// GEAR_CAP HOLIDAYS INFRA SEQUENCER SAFE. An empty list is a pass.
abstract contract SystemChecks is DeploymentFile {
    using StateLibrary for IPoolManager;

    /// The backer's sealed batch was measured under the liquidator's TX_GAS_CAP (24M) at MAX_BATCH 50 (BatchGasFork).
    uint256 internal constant MAX_BATCH_UNDER_TX_GAS_CAP = 50;

    /// Canonical runtime codehashes on chains 4663 and 46630, read with `cast codehash` on 2026-11-16 from both public
    /// RPCs and equal to the same addresses on Ethereum mainnet (DEP-8, SAFE-1).
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a; // Safe 1.4.1
    bytes32 internal constant SAFE_SINGLETON_HASH = 0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4; // not-a-key: public codehash or storage slot
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762; // SafeL2 1.4.1
    bytes32 internal constant SAFE_L2_SINGLETON_HASH =
        0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff; // not-a-key: public codehash or storage slot
    address internal constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67; // SafeProxyFactory 1.4.1
    bytes32 internal constant SAFE_FACTORY_HASH = 0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317; // not-a-key: public codehash or storage slot
    address internal constant SAFE_FALLBACK = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99; // CompatibilityFallbackHandler 1.4.1
    bytes32 internal constant SAFE_FALLBACK_HASH = 0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9; // not-a-key: public codehash or storage slot
    /// SafeProxy 1.4.1 runtime, as deployed by the factory (both mainnet owner Safes have it).
    bytes32 internal constant SAFE_PROXY_HASH = 0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c; // not-a-key: public codehash or storage slot
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    bytes32 internal constant MULTICALL3_HASH = 0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891; // not-a-key: public codehash or storage slot
    address internal constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;
    bytes32 internal constant CREATEX_HASH = 0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f; // not-a-key: public codehash or storage slot
    /// keccak256("guard_manager.guard.address") and keccak256("fallback_manager.handler.address") (Safe 1.4.1).
    bytes32 internal constant SAFE_GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8; // not-a-key: public codehash or storage slot
    bytes32 internal constant SAFE_FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5; // not-a-key: public codehash or storage slot
    address internal constant SAFE_SENTINEL = address(0x1);

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
            _checkHolidays(a, c, d);
            _checkRoles(a, c, d, deployer);
            _checkTimelock(a, c, d, deployer);
            _checkHookAndPools(a, c, d);
            _checkMarkets(a, c, d);
            _checkGears(a, c, d);
            _checkSeed(a, d);
            _checkSequencer(a, c, d);
            _checkOwners(a, c);
        }
        if (_rhc(c)) _checkInfra(a);
        uint256 n = a.n < a.f.length ? a.n : a.f.length;
        out = a.f;
        assembly {
            mstore(out, n)
        }
    }

    function _rhc(Config memory c) private pure returns (bool) {
        return c.chainId == 4663 || c.chainId == 46630;
    }

    /// DEP-8: the shared contracts the deploy and the owner Safes rely on have their canonical code. An empty string
    /// is a pass; otherwise the first mismatch, named.
    function checkInfra() public view returns (string memory) {
        address[5] memory at = [SAFE_SINGLETON, SAFE_L2_SINGLETON, SAFE_FACTORY, MULTICALL3, CREATEX];
        bytes32[5] memory want =
            [SAFE_SINGLETON_HASH, SAFE_L2_SINGLETON_HASH, SAFE_FACTORY_HASH, MULTICALL3_HASH, CREATEX_HASH];
        string[5] memory name = ["Safe 1.4.1", "SafeL2 1.4.1", "SafeProxyFactory 1.4.1", "Multicall3", "CreateX"];
        for (uint256 i; i < at.length; ++i) {
            if (at[i].codehash != want[i]) return string.concat(name[i], " codehash differs at ", vm.toString(at[i]));
        }
        if (SAFE_FALLBACK.codehash != SAFE_FALLBACK_HASH) return "CompatibilityFallbackHandler 1.4.1 codehash differs";
        return "";
    }

    function _checkInfra(Acc memory a) private view {
        string memory why = checkInfra();
        if (bytes(why).length != 0) _fail(a, "INFRA", why);
    }

    /// SAFE-1: `who` is a real Safe: the SafeProxy 1.4.1 runtime, an official 1.4.1 singleton in slot 0, threshold at
    /// least `minThreshold`, no module, no guard, and the official fallback handler. A plain or EIP-7702 delegated
    /// account fails on the proxy codehash. An empty string is a pass.
    function checkSafe(address who, uint256 minThreshold) public view returns (string memory) {
        if (who.codehash != SAFE_PROXY_HASH) return "not a SafeProxy 1.4.1 (codehash)";
        address single = address(uint160(uint256(vm.load(who, 0))));
        if (single != SAFE_SINGLETON && single != SAFE_L2_SINGLETON) return "singleton is not Safe or SafeL2 1.4.1";
        (bool ok, bytes memory r) = who.staticcall(abi.encodeWithSignature("getThreshold()"));
        if (!ok || r.length != 32 || abi.decode(r, (uint256)) < minThreshold) return "threshold below the minimum";
        (ok, r) = who.staticcall(abi.encodeWithSignature("getModulesPaginated(address,uint256)", SAFE_SENTINEL, 10));
        if (!ok) return "getModulesPaginated reverted";
        (address[] memory mods,) = abi.decode(r, (address[], address));
        if (mods.length != 0) return "a module is enabled";
        if (vm.load(who, SAFE_GUARD_SLOT) != bytes32(0)) return "a guard is set";
        if (address(uint160(uint256(vm.load(who, SAFE_FALLBACK_SLOT)))) != SAFE_FALLBACK) {
            return "fallback handler is not CompatibilityFallbackHandler 1.4.1";
        }
        return "";
    }

    /// The owner and guardian must be real Safes on mainnet (3-of-5 and 2-of-5). Elsewhere an account without code
    /// is allowed (testnet uses plain wallets, forks use placeholders), but any account with code must pass as a Safe.
    function _checkOwners(Acc memory a, Config memory c) private view {
        bool mainnet = keccak256(bytes(c.network)) == keccak256("mainnet");
        address[2] memory who = [c.roles.ownerSafe, c.roles.guardianSafe];
        uint256[2] memory minT = [uint256(3), 2];
        string[2] memory name = ["owner Safe: ", "guardian Safe: "];
        for (uint256 i; i < 2; ++i) {
            if (!mainnet && who[i].code.length == 0) continue;
            string memory why = checkSafe(who[i], minT[i]);
            if (bytes(why).length != 0) _fail(a, "SAFE", string.concat(name[i], why));
        }
    }

    /// ORC-7: Robinhood Chain has no L2 sequencer uptime feed, so the guard is built without one (SECURITY.md accepted
    /// risks). A non-zero feed on these chains means the deploy differs from the reviewed design.
    function _checkSequencer(Acc memory a, Config memory c, Deployed memory d) private view {
        if (_rhc(c) && ODOracleGuard(d.guard).sequencerFeed() != address(0)) {
            _fail(a, "SEQUENCER", "sequencer feed set on a chain that has none");
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
        // Phase 1 (no $OVRD yet): ovrd and stake are both absent. One without the other is a broken record.
        bool noStake = d.stake == address(0) && d.ovrd == address(0);
        for (uint256 i; i < all.length; ++i) {
            if (noStake && (i == 2 || i == 15)) continue;
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

    /// R8-1: the on-chain holiday list equals the config's and still reaches past today.
    function _checkHolidays(Acc memory a, Config memory c, Deployed memory d) private view {
        Holiday[] memory h = IODMarketHours(d.marketHours).holidays();
        if (keccak256(abi.encode(h)) != keccak256(abi.encode(c.holidays))) {
            _fail(a, "HOLIDAYS", "ODMarketHours.holidays() differs from the config list");
        }
        if (h.length == 0 || uint256(h[h.length - 1].day) * 1 days <= block.timestamp) {
            _fail(a, "HOLIDAYS", "the on-chain holiday list is empty or ends in the past");
        }
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
        _eq(a, d.minter, "governor()", d.governor, "minter.governor");
        _eq(a, d.minter, "registry()", d.registry, "minter.registry");
        _eq(a, d.minter, "guard()", d.guard, "minter.guard");
        _eq(a, d.minter, "vol()", d.vol, "minter.vol");
        _eq(a, d.minter, "fees()", d.fees, "minter.fees");
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
        if (_getB(d.fees, abi.encodeWithSelector(sel, f.B_TREASURY())) != c.roles.treasury) {
            _fail(a, "WIRING", "fees TREASURY");
        }
        _checkStakeWiring(a, c, d);
        if (!f.isNotifier(d.governor) || !f.isNotifier(d.backer)) _fail(a, "WIRING", "fees notifiers");
    }

    /// Phase 1: no stake anywhere and the STAKERS share addressed to the treasury (held in ODFees). Phase 2: the stake
    /// is wired into the minter, the backer and the STAKERS bucket (after the DeployStake batch).
    function _checkStakeWiring(Acc memory a, Config memory c, Deployed memory d) private view {
        address stakersTo = _getB(d.fees, abi.encodeWithSignature("recipientOf(bytes32)", ODFees(d.fees).B_STAKERS()));
        _eq(a, d.minter, "stake()", d.stake, "minter.stake");
        _eq(a, d.backer, "stake()", d.stake, "backer.stake");
        if (d.stake == address(0)) {
            if (stakersTo != c.roles.treasury) _fail(a, "WIRING", "fees STAKERS (no stake yet: treasury)");
            return;
        }
        if (stakersTo != d.stake) _fail(a, "WIRING", "fees STAKERS");
        _checkStakeOwn(a, c, d);
    }

    /// The stake contract itself: immutables and its two operational roles.
    function _checkStakeOwn(Acc memory a, Config memory c, Deployed memory d) private view {
        _eq(a, d.stake, "governor()", d.governor, "stake.governor");
        _eq(a, d.stake, "backer()", d.backer, "stake.backer");
        _eq(a, d.stake, "ovrd()", d.ovrd, "stake.ovrd");
        _eq(a, d.stake, "usdg()", d.usdg, "stake.usdg");
        if (!IAccessControl(d.stake).hasRole(ODStake(d.stake).FEES_ROLE(), d.fees)) {
            _fail(a, "WIRING", "stake FEES_ROLE");
        }
        _role(
            a,
            d.stake,
            ODRoles.GUARDIAN_ROLE,
            c.roles.guardianSafe,
            true,
            "guardian Safe missing GUARDIAN_ROLE on stake"
        );
    }

    /// Phase 2, before the batch runs: the new stake alone (code, immutables, roles, admin with the timelock only).
    function checkStakeDeployed(Config memory c, Deployed memory d, address deployer)
        public
        view
        returns (string[] memory out)
    {
        Acc memory a = Acc(new string[](32), 0);
        if (d.stake == address(0) || d.stake.code.length == 0) {
            _fail(a, "CODE", "no code at the stake");
        } else {
            _checkStakeOwn(a, c, d);
            _role(a, d.stake, 0x00, d.timelock, true, "timelock not admin of the stake");
            _role(a, d.stake, 0x00, deployer, false, "deployer still admin of the stake");
            _role(a, d.stake, ODRoles.GUARDIAN_ROLE, deployer, false, "deployer guardian of the stake");
        }
        uint256 n = a.n < a.f.length ? a.n : a.f.length;
        out = a.f;
        assembly {
            mstore(out, n)
        }
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
            // I5-2 / I4-4: a market with no reference source can never open buys, fill a queued sell or seal a batch.
            // (Whether a configured Pyth id is being pushed is a live fact, watched by the crank, not a deploy fact.)
            if (m.cfg.twapPool == address(0) && m.cfg.pythId == bytes32(0)) {
                _fail(a, "REFERENCE", string.concat(m.symbol, " has no reference source (no v3 pool, no Pyth id)"));
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
        if (supply != 0 && gov.freeCash() == 0) _fail(a, "SEEDED", "Governor shares with no deposited cash");
    }
}

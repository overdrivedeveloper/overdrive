// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {SystemConfig} from "./SystemConfig.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";
import {ODMarketHours} from "overdrive/oracle/ODMarketHours.sol";
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
import {ODAgentRouter} from "overdrive/agent/ODAgentRouter.sol";
import {ODPaymaster} from "overdrive/agent/ODPaymaster.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODVolOracle} from "overdrive/interfaces/IODVolOracle.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODMarketHours} from "overdrive/interfaces/IODMarketHours.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";
import {PriceReading} from "overdrive/interfaces/ODTypes.sol";

/// A mintable test token, deployed only for anvil, forks and testnet (never on 4663, see SystemConfig).
contract ODDevToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// CreateX (pcaversaccio), the same address on 4663 and 46630 (chain-facts 2026-11-14).
interface ICreateX {
    function deployCreate2(bytes32 salt, bytes memory initCode) external payable returns (address);
}

/// @title SystemDeployer
/// @notice Deploys every Overdrive core with its constructor args, mines the hook salt for the real deployer and
/// deploys the hook through CreateX, wires each "once" setter exactly once, grants the bot roles, lists the gears whose
/// markets read ready (the rest go to a ListGears timelock batch), then hands every admin role to the timelock and
/// renounces the deployer's. Nothing is seeded: Governor seeding is the owner's `deposit` (D8) and the hook seeds (D26) are
/// the owner Safe's. Backers and $OVRD staking deploy closed (D10): backer minting and stake deposits start paused.
abstract contract SystemDeployer is SystemConfig {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Deployed {
        address timelock;
        address usdg;
        address ovrd;
        address poolManager;
        address marketHours;
        address guard;
        address vol;
        address registry;
        address factory;
        address insurance;
        address fees;
        address governor;
        address minter;
        address backer;
        address hook;
        address stake;
        address agentRouter;
        address paymaster;
        uint256 startBlock;
    }

    event GearDeferred(bytes32 gearId, bytes32 market);

    /// Mines a CreateX salt for `deployer`: the first 20 bytes are the deployer and byte 21 is 0x00 (permissioned, no
    /// cross-chain redeploy protection), so CreateX guards it as keccak256(deployer, salt) and nobody else can use it.
    function mineCreateXSalt(address createX, address deployer, bytes memory initCode)
        public
        view
        returns (address hook, bytes32 salt, bytes32 guarded)
    {
        bytes32 initHash = keccak256(initCode);
        for (uint256 i; i < ODHookMiner.MAX_LOOP; ++i) {
            salt = bytes32(uint256(uint160(deployer)) << 96 | i);
            guarded = keccak256(abi.encode(bytes32(uint256(uint160(deployer))), salt));
            hook = ODHookMiner.computeAddress(createX, guarded, initHash);
            if (uint160(hook) & 0x3FFF == ODHookMiner.FLAGS && hook.code.length == 0) return (hook, salt, guarded);
        }
        revert ODHookMiner.SaltNotFound();
    }

    function hookInitCode(address pm, address minter, address registry, address usdg, address admin)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(ODHook).creationCode, abi.encode(pm, minter, registry, usdg, admin));
    }

    /// The L2 block number (ArbSys 0x64 `arbBlockNumber()`): `block.number` inside an Orbit chain is L1-derived. Off
    /// an Orbit chain (plain anvil) it is `block.number`. The owner scripts pass the node's own number in OD_START_BLOCK.
    function _l2Block() internal view returns (uint256) {
        (bool ok, bytes memory r) = address(0x64).staticcall(abi.encodeWithSignature("arbBlockNumber()"));
        return ok && r.length >= 32 ? abi.decode(r, (uint256)) : block.number;
    }

    /// Run inside a broadcast (or a prank in tests) as `me`.
    function _deployAll(Config memory c, address me) internal returns (Deployed memory d) {
        d.startBlock = vm.envOr("OD_START_BLOCK", _l2Block());
        d.usdg = c.dev.usdg ? address(new ODDevToken("Test USDG", "tUSDG", 6)) : c.ext.usdg;
        d.ovrd = c.dev.ovrd ? address(new ODDevToken("Test OVRD", "tOVRD", 18)) : c.ext.ovrd;
        d.poolManager = c.dev.poolManager ? address(new PoolManager(c.roles.ownerSafe)) : c.ext.poolManager;
        {
            address[] memory owner = new address[](1);
            owner[0] = c.roles.ownerSafe;
            d.timelock = address(new TimelockController(c.minDelay, owner, owner, address(0)));
        }
        IERC20 usdg = IERC20(d.usdg);
        d.marketHours = address(new ODMarketHours(me, c.roles.keeper));
        d.guard = address(new ODOracleGuard(me, c.roles.guardianSafe, d.marketHours, c.ext.pythCore, address(0)));
        d.vol = address(new ODVolOracle(me, c.roles.guardianSafe, c.roles.volSigner));
        d.registry = address(new ODGearRegistry(me, c.roles.guardianSafe, IODOracleGuard(d.guard), IODVolOracle(d.vol)));
        d.factory = address(ODGearRegistry(d.registry).factory());
        d.insurance = address(new ODInsurance(usdg, me, address(0), address(0)));
        address govAt = vm.computeCreateAddress(me, vm.getNonce(me) + 1);
        d.fees = address(new ODFees(usdg, me, govAt));
        d.governor = address(
            new ODGovernor(
                usdg,
                me,
                c.roles.guardianSafe,
                IODGearRegistry(d.registry),
                IODOracleGuard(d.guard),
                IODInsurance(d.insurance),
                d.fees
            )
        );
        require(d.governor == govAt, "predicted governor");
        d.minter = address(
            new ODMinter(
                usdg,
                me,
                c.roles.guardianSafe,
                IODGearRegistry(d.registry),
                IODOracleGuard(d.guard),
                IODVolOracle(d.vol),
                IODGovernor(d.governor),
                d.fees
            )
        );
        d.backer = address(
            new ODBacker(
                usdg,
                me,
                c.roles.guardianSafe,
                IODGearRegistry(d.registry),
                IODMinter(d.minter),
                IODGovernor(d.governor),
                IODOracleGuard(d.guard),
                IODMarketHours(d.marketHours),
                IODInsurance(d.insurance),
                d.fees
            )
        );
        d.stake = address(new ODStake(IERC20(d.ovrd), usdg, me, d.governor, d.backer));
        d.agentRouter =
            address(new ODAgentRouter(usdg, IODMinter(d.minter), IODBacker(d.backer), IODGearRegistry(d.registry)));
        d.hook = _deployHook(c, me, d);
        {
            address[] memory targets = new address[](3);
            targets[0] = d.minter;
            targets[1] = d.backer;
            targets[2] = d.agentRouter;
            // Owner is the timelock from birth: no two-step transfer is pending at any time.
            d.paymaster = address(
                new ODPaymaster(
                    IEntryPoint(c.ext.entryPoint),
                    d.timelock,
                    c.roles.guardianSafe,
                    c.roles.paymasterSigner,
                    targets,
                    d.usdg,
                    c.paymaster.maxCostPerOp,
                    c.paymaster.accountDailyCap,
                    c.paymaster.globalDailyCap
                )
            );
        }
        _wire(c, d);
        _configureMarkets(c, d);
        _listReady(c, d);
    }

    function _deployHook(Config memory c, address me, Deployed memory d) internal returns (address hook) {
        bytes memory code = hookInitCode(d.poolManager, d.minter, d.registry, d.usdg, me);
        if (c.ext.createX != address(0) && c.ext.createX.code.length != 0) {
            (address predicted, bytes32 salt,) = mineCreateXSalt(c.ext.createX, me, code);
            hook = ICreateX(c.ext.createX).deployCreate2(salt, code);
            require(hook == predicted, "mined hook (CreateX)");
        } else {
            // Plain anvil only (no CreateX): the standard CREATE2 deployer (input = salt ++ init code).
            require(!_isRealChain(block.chainid), "CreateX required on real chains");
            (address predicted, bytes32 salt) = ODHookMiner.find(CREATE2_DEPLOYER, code);
            (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, code));
            require(ok && ret.length == 20, "CREATE2 deployer");
            hook = address(bytes20(ret));
            require(hook == predicted, "mined hook (CREATE2)");
        }
    }

    function _wire(Config memory c, Deployed memory d) internal {
        ODGearRegistry(d.registry).setMinter(d.minter);
        ODGovernor gov = ODGovernor(d.governor);
        gov.setMinter(d.minter);
        gov.setBacker(d.backer);
        gov.setHedger(c.roles.hedger);
        gov.grantRole(ODRoles.HEDGER_ROLE, c.roles.hedger);
        gov.setDepositor(c.roles.ownerSafe, true);
        ODInsurance(d.insurance).setCoverers(d.governor, d.backer);
        ODFees fees = ODFees(d.fees);
        fees.setNotifier(d.governor, true);
        fees.setNotifier(d.backer, true);
        fees.setRecipient(fees.B_STAKERS(), d.stake);
        fees.setRecipient(fees.B_TREASURY(), c.roles.treasury);
        fees.setRecipient(fees.B_KEEPERS(), c.roles.keeper);
        fees.setRecipient(fees.B_HEDGERS(), c.roles.hedger);
        ODStake st = ODStake(d.stake);
        st.grantRole(st.FEES_ROLE(), d.fees);
        st.grantRole(ODRoles.GUARDIAN_ROLE, c.roles.guardianSafe);
        st.setDepositsPaused(true);
        ODMinter(d.minter).setHook(d.hook);
        ODMinter(d.minter).setStake(d.stake);
        ODBacker(d.backer).setStake(d.stake);
        ODBacker(d.backer).setMintPaused(true);
    }

    function _configureMarkets(Config memory c, Deployed memory d) internal {
        for (uint256 i; i < c.markets.length; ++i) {
            MarketCfg memory m = c.markets[i];
            ODOracleGuard(d.guard).setMarket(m.id, m.cfg);
            ODVolOracle(d.vol).setBounds(m.id, m.volFloorBps, m.volCeilingBps);
            ODGovernor(d.governor).setMarketGroup(m.id, m.group);
        }
    }

    /// True when the registry would accept a listing on `m` now (fresh, buys open, a price).
    function marketReady(address guard, bytes32 m) public view returns (bool) {
        if (m == bytes32(0)) return true;
        try IODOracleGuard(guard).read(m) returns (PriceReading memory r) {
            return r.fresh && !r.buysPaused && r.p != 0;
        } catch {
            return false;
        }
    }

    function _listReady(Config memory c, Deployed memory d) internal {
        ODGearRegistry reg = ODGearRegistry(d.registry);
        for (uint256 i; i < c.gears.length; ++i) {
            GearCfg memory g = c.gears[i];
            bytes32 id = reg.idOf(g.marketA, g.marketB, g.gear);
            if (reg.gear(id).token != address(0)) continue;
            if (!marketReady(d.guard, g.marketA) || !marketReady(d.guard, g.marketB)) {
                emit GearDeferred(id, g.marketA);
                continue;
            }
            string memory sym = g.marketB == bytes32(0)
                ? string.concat(symbolOf(g.marketA), reg.suffixOf(g.gear))
                : string.concat(symbolOf(g.marketA), "/", symbolOf(g.marketB), reg.suffixOf(g.gear));
            reg.listGear(g.marketA, g.marketB, g.gear, g.unitWad, g.capUsdWad, g.spreadBps, sym);
            ODHook(d.hook).initializeGearPool(id);
        }
    }

    /// Every AccessControl core whose DEFAULT_ADMIN_ROLE goes to the timelock.
    function adminCores(Deployed memory d) public pure returns (address[] memory a) {
        a = new address[](11);
        a[0] = d.marketHours;
        a[1] = d.guard;
        a[2] = d.vol;
        a[3] = d.registry;
        a[4] = d.insurance;
        a[5] = d.fees;
        a[6] = d.governor;
        a[7] = d.minter;
        a[8] = d.backer;
        a[9] = d.hook;
        a[10] = d.stake;
    }

    /// Idempotent: grants the timelock admin where missing and renounces `me` where held. Returns the steps taken.
    function _handoff(Deployed memory d, address me) internal returns (uint256 steps) {
        address[] memory cores = adminCores(d);
        bytes32 admin = 0x00;
        for (uint256 i; i < cores.length; ++i) {
            IAccessControl ac = IAccessControl(cores[i]);
            if (!ac.hasRole(admin, d.timelock)) {
                ac.grantRole(admin, d.timelock);
                ++steps;
            }
            if (ac.hasRole(admin, me)) {
                ac.renounceRole(admin, me);
                ++steps;
            }
        }
    }
}

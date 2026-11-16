// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {DeploySystem} from "../../script/DeploySystem.s.sol";

/// DEP-8 and SAFE-1: the post-deploy check pins the codehash of the Safe singletons, factory, fallback handler,
/// Multicall3 and CreateX, and proves an owner Safe is a real Safe (proxy codehash, singleton, threshold, no module,
/// no guard, official fallback handler). Local tests prove the failures; fork tests (RHC_RPC_URL on chain 4663)
/// prove the live values pass and that each tampered field is caught.
contract OwnerSafeCheckTest is ODTest {
    address internal constant OWNER_SAFE = 0x176F3d70fB5f10A90f0Ed822A6BB7910485f8A27; // mainnet owner Safe 3-of-5
    address internal constant GUARDIAN_SAFE = 0x1818B7DA01e1F36E54FdFdA15Ac6212762cAb483; // mainnet guardian 2-of-5
    address internal constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    bytes32 internal constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8; // not-a-key: public codehash or storage slot
    bytes32 internal constant FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5; // not-a-key: public codehash or storage slot

    DeploySystem internal ds;

    function setUp() public {
        ds = new DeploySystem();
    }

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(url).length == 0) return false;
        vm.createSelectFork(url);
        if (block.chainid != 4663) return false;
        ds = new DeploySystem();
        return true;
    }

    function test_InfraFailsWithoutCanonicalCode() public view {
        assertGt(bytes(ds.checkInfra()).length, 0, "no canonical code on a bare chain");
    }

    function test_InfraFailsOnWrongCode() public {
        vm.etch(0xcA11bde05977b3631167028862bE2a173976CA11, hex"00");
        assertGt(bytes(ds.checkInfra()).length, 0);
    }

    function test_SafeRejectsPlainAnd7702Accounts() public {
        address eoa = makeAddr("eoa");
        assertEq(ds.checkSafe(eoa, 3), "not a SafeProxy 1.4.1 (codehash)");
        // An EIP-7702 delegated EOA has code (0xef0100 || target) and passes a code-size check, not this one.
        vm.etch(eoa, abi.encodePacked(hex"ef0100", SAFE_L2));
        assertEq(ds.checkSafe(eoa, 3), "not a SafeProxy 1.4.1 (codehash)");
    }

    function test_Fork_InfraAndMainnetSafesPass() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        assertEq(ds.checkInfra(), "");
        assertEq(ds.checkSafe(OWNER_SAFE, 3), "");
        assertEq(ds.checkSafe(GUARDIAN_SAFE, 2), "");
    }

    function test_Fork_ThresholdBelowMinimum() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        assertEq(ds.checkSafe(GUARDIAN_SAFE, 3), "threshold below the minimum");
    }

    function test_Fork_WrongSingleton() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        vm.store(OWNER_SAFE, bytes32(0), bytes32(uint256(uint160(makeAddr("fake singleton")))));
        assertEq(ds.checkSafe(OWNER_SAFE, 3), "singleton is not Safe or SafeL2 1.4.1");
    }

    function test_Fork_ModuleCaught() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        address m = makeAddr("module");
        // ModuleManager.modules is the mapping at slot 1: sentinel -> m -> sentinel enables one module.
        vm.store(OWNER_SAFE, keccak256(abi.encode(address(1), uint256(1))), bytes32(uint256(uint160(m))));
        vm.store(OWNER_SAFE, keccak256(abi.encode(m, uint256(1))), bytes32(uint256(1)));
        assertEq(ds.checkSafe(OWNER_SAFE, 3), "a module is enabled");
    }

    function test_Fork_GuardCaught() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        vm.store(OWNER_SAFE, GUARD_SLOT, bytes32(uint256(uint160(makeAddr("guard")))));
        assertEq(ds.checkSafe(OWNER_SAFE, 3), "a guard is set");
    }

    function test_Fork_FallbackHandlerCaught() public {
        if (!_fork()) {
            vm.skip(true);
            return;
        }
        vm.store(GUARDIAN_SAFE, FALLBACK_SLOT, bytes32(uint256(uint160(makeAddr("handler")))));
        assertEq(ds.checkSafe(GUARDIAN_SAFE, 2), "fallback handler is not CompatibilityFallbackHandler 1.4.1");
    }
}

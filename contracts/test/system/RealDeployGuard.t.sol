// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ODScript} from "../../script/lib/ODScript.sol";

contract GuardHarness is ODScript {
    string internal flagEnv;
    string internal fileEnv;

    constructor(string memory tag) {
        flagEnv = string.concat("OD_GUARD_TEST_FLAG_", tag);
        fileEnv = string.concat("OD_GUARD_TEST_FILE_", tag);
    }

    function check() external {
        _guardRealBroadcast();
    }

    function names() external view returns (string memory, string memory) {
        return (flagEnv, fileEnv);
    }

    function _armFlagEnv() internal view override returns (string memory) {
        return flagEnv;
    }

    function _armFileEnv() internal view override returns (string memory) {
        return fileEnv;
    }
}

contract RealNames is ODScript {
    function names() external view returns (string memory, string memory) {
        return (_armFlagEnv(), _armFileEnv());
    }
}

/// Rule R1: the armed-flag guard. A broadcast on 4663/46630 needs OVERDRIVE_ALLOW_REAL_DEPLOY == "1" AND the file
/// named by OVERDRIVE_ALLOW_FILE; anvil and forks stay free; every broadcasting script calls the guard first.
contract RealDeployGuardTest is Test {
    GuardHarness internal g;
    string internal armFile;

    function _use(string memory tag) internal {
        g = new GuardHarness(tag);
        armFile = string.concat(vm.projectRoot(), "/out/od-arm-test-", tag, ".flag");
    }

    function _arm(string memory flag, bool withFile) internal {
        (string memory flagEnv, string memory fileEnv) = g.names();
        vm.setEnv(flagEnv, flag);
        if (withFile) {
            vm.writeFile(armFile, "armed\n");
            vm.setEnv(fileEnv, armFile);
        } else {
            vm.setEnv(fileEnv, string.concat(armFile, ".absent"));
        }
    }

    function test_GuardReadsTheRealVariableNames() public {
        (string memory a, string memory b) = new RealNames().names();
        assertEq(a, "OVERDRIVE_ALLOW_REAL_DEPLOY");
        assertEq(b, "OVERDRIVE_ALLOW_FILE");
    }

    function _refused(uint256 chainId) internal {
        vm.chainId(chainId);
        vm.expectRevert();
        g.check();
    }

    function test_MainnetRefusedWhenNothingSet() public {
        _use("MainnetRefusedWhenNothingSet");
        _refused(4663);
    }

    function test_TestnetRefused() public {
        _use("TestnetRefused");
        _refused(46630);
    }

    function test_FlagWithoutFileRefused() public {
        _use("FlagWithoutFileRefused");
        _arm("1", false);
        _refused(4663);
    }

    function test_FileWithoutFlagRefused() public {
        _use("FileWithoutFlagRefused");
        _arm("", true);
        _refused(4663);
        _refused(46630);
    }

    function test_FlagOtherThanOneRefused() public {
        _use("FlagOtherThanOneRefused");
        _arm("true", true);
        _refused(4663);
        _arm("yes", true);
        _refused(46630);
        _arm("11", true);
        _refused(4663);
    }

    function test_ArmedAllowsRealChains() public {
        _use("ArmedAllowsRealChains");
        _arm("1", true);
        vm.chainId(4663);
        g.check();
        vm.chainId(46630);
        g.check();
    }

    function test_ForksAndAnvilFree() public {
        _use("ForksAndAnvilFree");
        vm.chainId(31337);
        g.check();
        vm.chainId(1);
        g.check();
    }

    /// Scans every script/*.s.sol: a file that broadcasts must call `_guardRealBroadcast()` before its first broadcast.
    function test_EveryBroadcastingScriptCallsGuard() public view {
        string memory dir = string.concat(vm.projectRoot(), "/script");
        Vm.DirEntry[] memory es = vm.readDir(dir);
        uint256 scanned;
        uint256 broadcasting;
        for (uint256 i; i < es.length; ++i) {
            string memory p = es[i].path;
            if (es[i].isDir || !_endsWith(p, ".s.sol")) continue;
            ++scanned;
            bytes memory src = bytes(vm.readFile(p));
            uint256 b1 = _find(src, "vm.startBroadcast");
            uint256 b2 = _find(src, "vm.broadcast");
            uint256 first = b1 < b2 ? b1 : b2;
            if (first == type(uint256).max) continue;
            ++broadcasting;
            uint256 guardAt = _find(src, "_guardRealBroadcast();");
            assertTrue(guardAt < first, string.concat("broadcast before the guard in ", p));
        }
        assertGe(scanned, 4, "scripts scanned");
        assertGe(broadcasting, 2, "DeploySystem and TimelockHandoff broadcast");
    }

    function _endsWith(string memory s, string memory suf) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suf);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }

    function _find(bytes memory h, string memory needle) internal pure returns (uint256) {
        bytes memory n = bytes(needle);
        if (h.length < n.length) return type(uint256).max;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool ok = true;
            for (uint256 k; k < n.length; ++k) {
                if (h[i + k] != n[k]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        return type(uint256).max;
    }
}

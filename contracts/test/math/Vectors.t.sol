// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {console2} from "forge-std/console2.sol";
import {ODTest} from "../utils/ODTest.sol";
import {Gear} from "../../src/interfaces/ODTypes.sol";
import {ODIndex} from "../../src/math/ODIndex.sol";
import {ODNorm} from "../../src/math/ODNorm.sol";
import {ODToll} from "../../src/math/ODToll.sol";

/// R13: the TypeScript twin (app/src/pricing) and these libraries agree exactly to the wei on the vector files
/// written by app/scripts/gen-vectors.ts.
contract VectorsTest is ODTest {
    // Fields in alphabetical order, the order forge decodes JSON objects in.
    struct IndexCase {
        uint8 gear;
        bool inDomain;
        uint256 nf;
        uint256 p;
        uint256 p0;
        uint8 rnd;
        uint256 unit;
        uint256 value;
    }

    struct NormCase {
        uint256 cap;
        uint256 dt;
        uint8 gear;
        uint256 nf;
        uint256 nfNew;
        uint256 open;
        int256 perSec;
        uint64 sigmaBps;
        uint256 tokens;
        int256 tollPerYear;
        int256 tollValue;
        uint256 usageMax;
        uint256 usageWad;
        uint256 vBefore;
    }

    function _read(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/", name));
    }

    function test_IndexVectors() public view {
        IndexCase[] memory c = abi.decode(
            vm.parseJsonTypeArray(
                _read("index-vectors.json"),
                ".cases",
                "IndexCase(uint8 gear,bool inDomain,uint256 nf,uint256 p,uint256 p0,uint8 rnd,uint256 unit,uint256 value)"
            ),
            (IndexCase[])
        );
        assertEq(c.length, 500, "500 index vectors");
        uint256 outOfDomain;
        for (uint256 i; i < c.length; ++i) {
            (uint256 v, bool ok) =
                ODIndex.value(Gear(c[i].gear), c[i].p, c[i].p0, c[i].nf, c[i].unit, Math.Rounding(c[i].rnd));
            if (v != c[i].value) console2.log("index case", i);
            assertEq(v, c[i].value, "value to the wei");
            assertEq(ok, c[i].inDomain, "inDomain");
            if (!ok) ++outOfDomain;
        }
        assertGt(outOfDomain, 0, "some cases exercise the clamp");
    }

    function test_NormVectors() public view {
        NormCase[] memory c = abi.decode(
            vm.parseJsonTypeArray(
                _read("norm-vectors.json"),
                ".cases",
                "NormCase(uint256 cap,uint256 dt,uint8 gear,uint256 nf,uint256 nfNew,uint256 open,int256 perSec,uint64 sigmaBps,uint256 tokens,int256 tollPerYear,int256 tollValue,uint256 usageMax,uint256 usageWad,uint256 vBefore)"
            ),
            (NormCase[])
        );
        assertEq(c.length, 500, "500 norm vectors");
        for (uint256 i; i < c.length; ++i) {
            NormCase memory k = c[i];
            uint256 u = ODToll.usage(k.open, k.cap, k.usageMax);
            assertEq(u, k.usageWad, "usage");
            int256 y = ODToll.tollPerYear(Gear(k.gear), k.sigmaBps, u);
            assertEq(y, k.tollPerYear, "tollPerYear");
            int256 s = ODToll.perSecond(y);
            assertEq(s, k.perSec, "perSecond");
            uint256 nfNew = ODNorm.step(k.nf, s, k.dt);
            if (nfNew != k.nfNew) console2.log("norm case", i);
            assertEq(nfNew, k.nfNew, "step to the wei");
            assertEq(ODNorm.tollValue(k.tokens, k.vBefore, k.nf, nfNew), k.tollValue, "tollValue");
        }
    }
}

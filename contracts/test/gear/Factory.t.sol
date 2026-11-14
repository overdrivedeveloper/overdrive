// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {ODGear} from "overdrive/gear/ODGear.sol";
import {ODGearFactory} from "overdrive/gear/ODGearFactory.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract FactoryTest is ODTest {
    ODGearFactory internal factory;
    address internal minter = makeAddr("minter");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant ID = keccak256(abi.encode(bytes32("TSLA"), bytes32(0), uint8(1)));

    function setUp() public {
        factory = new ODGearFactory();
    }

    // R5
    function test_OnlyOwnerDeploys() public {
        assertEq(factory.owner(), address(this));
        vm.prank(stranger);
        vm.expectRevert(ODGearFactory.NotOwner.selector);
        factory.deploy(ID, minter, "Overdrive TSLA Sport", "TSLA-SPORT");
        address t = factory.deploy(ID, minter, "Overdrive TSLA Sport", "TSLA-SPORT");
        assertGt(t.code.length, 0);
    }

    function test_PredictMatches() public {
        address p = factory.predict(ID);
        assertEq(p.code.length, 0);
        address t = factory.deploy(ID, minter, "Overdrive TSLA Sport", "TSLA-SPORT");
        assertEq(t, p);
        assertEq(ODGear(t).gearId(), ID);
    }

    function testFuzz_PredictMatches(bytes32 id) public {
        assertEq(factory.deploy(id, minter, "n", "s"), factory.predict(id));
    }

    function test_SameIdTwiceReverts() public {
        factory.deploy(ID, minter, "n", "s");
        vm.expectRevert();
        factory.deploy(ID, minter, "n", "s");
    }

    /// A stranger who clones the same implementation with the same salt from their own address lands elsewhere; and
    /// the stranger cannot deploy through the factory at all, so the gear's address stays free for the registry.
    function test_StrangerCannotFrontRunAddress() public {
        address predicted = factory.predict(ID);
        Squatter sq = new Squatter();
        address squat = sq.squat(factory.implementation(), ID);
        assertTrue(squat != predicted);
        // Their clone is a dead implementation copy they cannot use as our gear, and ours is still deployable.
        vm.prank(stranger);
        vm.expectRevert(ODGearFactory.NotOwner.selector);
        factory.deploy(ID, stranger, "n", "s");
        address t = factory.deploy(ID, minter, "Overdrive TSLA Sport", "TSLA-SPORT");
        assertEq(t, predicted);
        assertEq(ODGear(t).minter(), minter);
    }
}

contract Squatter {
    function squat(address impl, bytes32 salt) external returns (address) {
        return Clones.cloneDeterministic(impl, salt);
    }
}

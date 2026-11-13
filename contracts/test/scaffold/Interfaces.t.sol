// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import "overdrive/interfaces/ODTypes.sol";
import {ODPowers} from "overdrive/interfaces/ODPowers.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";
import {IODMarketHours} from "overdrive/interfaces/IODMarketHours.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODVolOracle} from "overdrive/interfaces/IODVolOracle.sol";
import {IODGear} from "overdrive/interfaces/IODGear.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODHook} from "overdrive/interfaces/IODHook.sol";
import {IODFees} from "overdrive/interfaces/IODFees.sol";
import {IODStake} from "overdrive/interfaces/IODStake.sol";
import {IODAgentRouter} from "overdrive/interfaces/IODAgentRouter.sol";
import {IODPaymaster} from "overdrive/interfaces/IODPaymaster.sol";

contract InterfacesTest is ODTest {
    function test_AllInterfacesCompile() public pure {
        // Referencing each interface type id forces it into this compilation unit.
        bytes4[14] memory ids = [
            type(IODMarketHours).interfaceId,
            type(IODOracleGuard).interfaceId,
            type(IODVolOracle).interfaceId,
            type(IODGear).interfaceId,
            type(IODGearRegistry).interfaceId,
            type(IODMinter).interfaceId,
            type(IODGovernor).interfaceId,
            type(IODInsurance).interfaceId,
            type(IODBacker).interfaceId,
            type(IODHook).interfaceId,
            type(IODFees).interfaceId,
            type(IODStake).interfaceId,
            type(IODAgentRouter).interfaceId,
            type(IODPaymaster).interfaceId
        ];
        for (uint256 i; i < ids.length; ++i) {
            assertTrue(ids[i] != bytes4(0));
        }
    }

    function test_GearPowers() public pure {
        assertEq(ODPowers.powerWad(Gear.CRUISE), 1.5e18);
        assertEq(ODPowers.powerWad(Gear.SPORT), 2e18);
        assertEq(ODPowers.powerWad(Gear.RACE), 3e18);
        assertEq(ODPowers.powerWad(Gear.ECO), 0.5e18);
        assertEq(ODPowers.powerWad(Gear.REVERSE), -1e18);
    }

    function test_RolesAreDistinct() public pure {
        assertTrue(ODRoles.KEEPER_ROLE != ODRoles.GUARDIAN_ROLE);
        assertTrue(ODRoles.HEDGER_ROLE != ODRoles.LIQUIDATOR_ROLE);
        assertEq(ODRoles.KEEPER_ROLE, keccak256("KEEPER_ROLE"));
    }
}

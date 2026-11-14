// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {HookFixture} from "./HookFixture.sol";
import {MineHookSalt} from "../../script/MineHookSalt.s.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";

/// R4: the salt script finds a CREATE2 salt with exactly ODHook's flag bits, bound to the deployer it was mined for.
contract MineHookSaltTest is HookFixture {
    MineHookSalt internal miner;
    address internal pm2;

    function setUp() public override {
        super.setUp();
        miner = new MineHookSalt();
        pm2 = makeAddr("anotherPoolManager"); // a fresh constructor-arg set, so the mined address has no code yet
    }

    function _deploy(bytes32 salt) internal returns (ODHook) {
        return new ODHook{salt: salt}(
            IPoolManager(pm2), IODMinter(address(minter)), IODGearRegistry(address(reg)), usdg, admin
        );
    }

    function test_SaltGivesFlags() public {
        (address predicted, bytes32 salt) =
            miner.mine(address(this), pm2, address(minter), address(reg), address(usdg), admin);
        assertEq(uint160(predicted) & Hooks.ALL_HOOK_MASK, ODHookMiner.FLAGS, "exactly the flag bits");
        ODHook h = _deploy(salt);
        assertEq(address(h), predicted, "deploys where the script said");
    }

    function test_SaltBoundToDeployer() public {
        address other = makeAddr("otherDeployer");
        (address forOther, bytes32 salt) = miner.mine(other, pm2, address(minter), address(reg), address(usdg), admin);
        assertEq(uint160(forOther) & Hooks.ALL_HOOK_MASK, ODHookMiner.FLAGS);
        address here = ODHookMiner.computeAddress(
            address(this), salt, keccak256(miner.creationCode(pm2, address(minter), address(reg), address(usdg), admin))
        );
        assertTrue(here != forOther, "same salt, other deployer, other address");
        if (uint160(here) & Hooks.ALL_HOOK_MASK != ODHookMiner.FLAGS) {
            vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, here));
            _deploy(salt);
        }
    }
}

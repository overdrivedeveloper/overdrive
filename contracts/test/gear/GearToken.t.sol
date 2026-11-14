// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {ODGear} from "overdrive/gear/ODGear.sol";
import {ODGearFactory} from "overdrive/gear/ODGearFactory.sol";
import {IODGear} from "overdrive/interfaces/IODGear.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract GearTokenTest is ODTest {
    ODGearFactory internal factory;
    ODGear internal token;
    address internal minter = makeAddr("minter");
    address internal alice;
    uint256 internal aliceKey;
    address internal bob = makeAddr("bob");
    bytes32 internal constant ID = keccak256("TSLA-SPORT");

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public {
        (alice, aliceKey) = makeAddrAndKey("alice");
        factory = new ODGearFactory();
        token = ODGear(factory.deploy(ID, minter, "Overdrive TSLA Sport", "TSLA-SPORT"));
    }

    function test_Metadata() public view {
        assertEq(token.name(), "Overdrive TSLA Sport");
        assertEq(token.symbol(), "TSLA-SPORT");
        assertEq(token.decimals(), 18);
        assertEq(token.minter(), minter);
        assertEq(token.gearId(), ID);
    }

    // R1
    function test_OnlyMinterMints() public {
        vm.prank(alice);
        vm.expectRevert(IODGear.NotMinter.selector);
        token.mint(alice, 1e18);
        vm.prank(minter);
        token.mint(alice, 1e18);
        assertEq(token.balanceOf(alice), 1e18);
        assertEq(token.totalSupply(), 1e18);
    }

    function test_OnlyMinterBurns() public {
        vm.prank(minter);
        token.mint(alice, 2e18);
        vm.prank(alice);
        vm.expectRevert(IODGear.NotMinter.selector);
        token.burn(alice, 1e18);
        vm.prank(minter);
        token.burn(alice, 1e18);
        assertEq(token.balanceOf(alice), 1e18);
        assertEq(token.totalSupply(), 1e18);
    }

    // R2: no hook, no external call on transfer, balances only move by the amount sent.
    function test_TransferIsPlain() public {
        vm.prank(minter);
        token.mint(alice, 5e18);
        vm.warp(block.timestamp + 365 days); // time passing (the toll) never touches balances
        assertEq(token.balanceOf(alice), 5e18);
        vm.expectCall(minter, "", 0); // a transfer makes no call to the minter
        vm.prank(alice);
        token.transfer(bob, 2e18);
        assertEq(token.balanceOf(alice), 3e18);
        assertEq(token.balanceOf(bob), 2e18);
        // The minter is never called: a transfer works even when the minter has no code at all.
        assertEq(minter.code.length, 0);
        vm.prank(alice);
        token.approve(bob, 1e18);
        vm.prank(bob);
        token.transferFrom(alice, bob, 1e18);
        assertEq(token.balanceOf(bob), 3e18);
        assertEq(token.totalSupply(), 5e18);
    }

    function testFuzz_BalancesConserved(uint128 mintA, uint128 mintB, uint128 send, uint64 dt) public {
        vm.startPrank(minter);
        token.mint(alice, mintA);
        token.mint(bob, mintB);
        vm.stopPrank();
        uint256 supply = uint256(mintA) + mintB;
        vm.warp(block.timestamp + dt);
        uint256 amt = mintA == 0 ? 0 : uint256(send) % (uint256(mintA) + 1);
        vm.prank(alice);
        token.transfer(bob, amt);
        assertEq(token.balanceOf(alice), mintA - amt);
        assertEq(token.balanceOf(bob), uint256(mintB) + amt);
        assertEq(token.balanceOf(alice) + token.balanceOf(bob), supply);
        assertEq(token.totalSupply(), supply);
    }

    // R3
    function test_Permit() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Overdrive TSLA Sport")),
                keccak256(bytes("1")),
                block.chainid,
                address(token)
            )
        );
        assertEq(token.DOMAIN_SEPARATOR(), domain);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, alice, bob, 7e18, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        token.permit(alice, bob, 7e18, deadline, v, r, s);
        assertEq(token.allowance(alice, bob), 7e18);
        assertEq(token.nonces(alice), 1);
        // Replay fails.
        vm.expectRevert();
        token.permit(alice, bob, 7e18, deadline, v, r, s);
    }

    function test_PermitDomainIsPerClone() public {
        ODGear other = ODGear(factory.deploy(keccak256("x"), minter, "Overdrive TSLA Sport", "TSLA-SPORT"));
        assertTrue(other.DOMAIN_SEPARATOR() != token.DOMAIN_SEPARATOR());
    }

    // R4
    function test_ImplementationLocked() public {
        ODGear impl = ODGear(factory.implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(minter, ID, "x", "y");
        assertEq(impl.minter(), address(0));
    }

    function test_InitOnce() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        token.initialize(alice, ID, "x", "y");
        assertEq(token.minter(), minter);
    }

    function test_InitRejectsZeroMinter() public {
        vm.prank(address(this));
        vm.expectRevert(ODGear.InvalidMinter.selector);
        factory.deploy(keccak256("zero"), address(0), "n", "s");
    }
}

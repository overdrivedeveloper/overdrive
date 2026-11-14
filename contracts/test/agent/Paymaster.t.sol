// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {PackedUserOperation, IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ODPaymaster} from "overdrive/agent/ODPaymaster.sol";
import {IODPaymaster} from "overdrive/interfaces/IODPaymaster.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {
    MockPaymasterEntryPoint,
    MockKernelAccount,
    MockPaymasterTarget,
    MockPaymasterOther,
    MockKernelFactory,
    EvilExecuteAccount
} from "../mocks/PaymasterMocks.sol";

contract PaymasterTest is ODTest {
    using stdJson for string;

    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant MAX_COST = 0.002 ether;
    uint256 internal constant PER_OP = 0.01 ether;
    uint256 internal constant ACCOUNT_CAP = 0.01 ether;
    uint256 internal constant GLOBAL_CAP = 0.03 ether;

    address internal owner = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    uint256 internal signerKey = 0xA11CE; // test-key
    address internal signer;

    MockPaymasterEntryPoint internal ep;
    ODPaymaster internal pm;
    MockUSDG internal usdg;
    MockPaymasterTarget internal minter;
    MockPaymasterTarget internal backer;
    MockPaymasterTarget internal router;
    MockKernelAccount internal acct;
    MockKernelAccount internal acct2;
    MockPaymasterOther internal other;

    function setUp() public {
        vm.warp(T0);
        signer = vm.addr(signerKey);
        ep = new MockPaymasterEntryPoint();
        usdg = new MockUSDG();
        minter = new MockPaymasterTarget(IERC20(address(usdg)));
        backer = new MockPaymasterTarget(IERC20(address(usdg)));
        router = new MockPaymasterTarget(IERC20(address(usdg)));
        other = new MockPaymasterOther();
        acct = new MockKernelAccount();
        acct2 = new MockKernelAccount();
        pm = _deploy(signer);
        vm.deal(address(this), 100 ether);
        pm.deposit{value: 1 ether}();
        address[] memory known = new address[](2);
        known[0] = address(acct);
        known[1] = address(acct2);
        vm.prank(owner);
        pm.setKernelAccounts(known, true); // the stubs stand in for factory-built Kernel accounts
        usdg.mint(address(acct), 1_000_000e6);
        usdg.mint(address(acct2), 1_000_000e6);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _targets() internal view returns (address[] memory t) {
        t = new address[](3);
        t[0] = address(minter);
        t[1] = address(backer);
        t[2] = address(router);
    }

    function _deploy(address signer_) internal returns (ODPaymaster) {
        return new ODPaymaster(
            IEntryPoint(address(ep)),
            owner,
            guardian,
            signer_,
            _targets(),
            address(usdg),
            PER_OP,
            ACCOUNT_CAP,
            GLOBAL_CAP
        );
    }

    function _single(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(bytes4(0xe9ae5c53), bytes32(0), abi.encodePacked(target, value, data));
    }

    function _batch(address[] memory targets, bytes[] memory datas) internal pure returns (bytes memory) {
        MockKernelAccount.Execution[] memory calls = new MockKernelAccount.Execution[](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            calls[i] = MockKernelAccount.Execution(targets[i], 0, datas[i]);
        }
        return abi.encodeWithSelector(bytes4(0xe9ae5c53), bytes32(bytes1(0x01)), abi.encode(calls));
    }

    function _approveBuy(address spender, uint256 amount) internal view returns (bytes memory) {
        address[] memory t = new address[](2);
        bytes[] memory d = new bytes[](2);
        t[0] = address(usdg);
        d[0] = abi.encodeCall(usdg.approve, (spender, amount));
        t[1] = spender;
        d[1] = abi.encodeCall(MockPaymasterTarget.buy, (bytes32(uint256(1)), amount, address(0xBEEF)));
        return _batch(t, d);
    }

    function _op(address sender, uint256 nonce, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = nonce;
        op.callData = callData;
        op.accountGasLimits = bytes32(abi.encodePacked(uint128(500_000), uint128(800_000)));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32(abi.encodePacked(uint128(1 gwei), uint128(2 gwei)));
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(150_000), uint128(60_000), new bytes(77));
        op.signature = hex"";
    }

    function _sign(PackedUserOperation memory op, uint48 validUntil, uint48 validAfter, uint256 key)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(pm.getHash(op, validUntil, validAfter));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        op.paymasterAndData =
            abi.encodePacked(address(pm), uint128(150_000), uint128(60_000), validUntil, validAfter, r, s, v);
        return op;
    }

    function _signed(address sender, uint256 nonce, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return
            _sign(_op(sender, nonce, callData), uint48(block.timestamp + 300), uint48(block.timestamp - 10), signerKey);
    }

    function _validate(PackedUserOperation memory op) internal returns (uint256 vd) {
        (, vd) = ep.validateOnly(address(pm), op, MAX_COST);
    }

    // ------------------------------------------------------------------------------------------------ R7

    function test_SponsorsApproveAndBuyBatch() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(address(minter), 250e6));
        uint256 before = ep.balanceOf(address(pm));
        assertTrue(ep.handleOp(address(pm), op, MAX_COST, 0.0005 ether));
        assertEq(minter.bought(address(0xBEEF)), 250e6);
        assertEq(ep.balanceOf(address(pm)), before - 0.0005 ether);
    }

    function test_OnlyProtocolTargets() public {
        address[] memory t = _targets();
        for (uint256 i; i < t.length; ++i) {
            PackedUserOperation memory ok =
                _signed(address(acct), 0, _single(t[i], 0, abi.encodeCall(MockPaymasterTarget.ping, ())));
            assertEq(_validate(ok) & 1, 0);
        }
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(other), 0, abi.encodeCall(other.poke, ())));
        vm.expectRevert(abi.encodeWithSelector(ODPaymaster.TargetNotAllowed.selector, address(other)));
        _validate(op);
        // One bad call poisons a batch.
        address[] memory bt = new address[](2);
        bytes[] memory bd = new bytes[](2);
        bt[0] = address(minter);
        bd[0] = abi.encodeCall(MockPaymasterTarget.ping, ());
        bt[1] = address(other);
        bd[1] = abi.encodeCall(other.poke, ());
        op = _signed(address(acct), 0, _batch(bt, bd));
        vm.expectRevert(abi.encodeWithSelector(ODPaymaster.TargetNotAllowed.selector, address(other)));
        _validate(op);
        // More than MAX_CALLS, an empty batch, delegatecall mode and a non-execute selector are refused.
        address[] memory many = new address[](5);
        bytes[] memory md = new bytes[](5);
        for (uint256 i; i < 5; ++i) {
            many[i] = address(minter);
            md[i] = abi.encodeCall(MockPaymasterTarget.ping, ());
        }
        op = _signed(address(acct), 0, _batch(many, md));
        vm.expectRevert(ODPaymaster.TooManyCalls.selector);
        _validate(op);
        op = _signed(address(acct), 0, _batch(new address[](0), new bytes[](0)));
        vm.expectRevert(ODPaymaster.TooManyCalls.selector);
        _validate(op);
        op = _signed(
            address(acct),
            0,
            abi.encodeWithSelector(
                bytes4(0xe9ae5c53), bytes32(bytes1(0xff)), abi.encodePacked(address(minter), hex"11223344")
            )
        );
        vm.expectRevert(ODPaymaster.UnsupportedCallData.selector);
        _validate(op);
        op = _signed(address(acct), 0, abi.encodeWithSelector(bytes4(0x12345678), bytes32(0), new bytes(64)));
        vm.expectRevert(ODPaymaster.UnsupportedCallData.selector);
        _validate(op);
    }

    function test_ApproveOnlyProtocolSpenders() public {
        address[] memory t = _targets();
        for (uint256 i; i < t.length; ++i) {
            PackedUserOperation memory ok =
                _signed(address(acct), 0, _single(address(usdg), 0, abi.encodeCall(usdg.approve, (t[i], 1e6))));
            assertEq(_validate(ok) & 1, 0);
        }
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(usdg), 0, abi.encodeCall(usdg.approve, (stranger, 1e6))));
        vm.expectRevert(abi.encodeWithSelector(ODPaymaster.ApproveNotAllowed.selector, stranger));
        _validate(op);
        op = _signed(address(acct), 0, _single(address(usdg), 0, abi.encodeCall(usdg.transfer, (address(minter), 1e6))));
        vm.expectRevert(abi.encodeWithSelector(ODPaymaster.TargetNotAllowed.selector, address(usdg)));
        _validate(op);
        op = _signed(
            address(acct),
            0,
            _single(address(usdg), 0, abi.encodePacked(abi.encodeCall(usdg.approve, (address(minter), 1e6)), uint8(1)))
        );
        vm.expectRevert(ODPaymaster.UnsupportedCallData.selector);
        _validate(op);
    }

    function test_NoValue() public {
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(minter), 1, abi.encodeCall(MockPaymasterTarget.ping, ())));
        vm.expectRevert(ODPaymaster.ValueNotAllowed.selector);
        _validate(op);
    }

    function test_SignatureDomain() public {
        bytes memory cd = _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ()));
        // Wrong signer: validation returns the signature-failed flag.
        PackedUserOperation memory op =
            _sign(_op(address(acct), 0, cd), uint48(block.timestamp + 300), uint48(block.timestamp - 10), 0xB0B);
        assertEq(_validate(op) & 1, 1);
        // Every covered field changes the hash.
        PackedUserOperation memory base = _op(address(acct), 0, cd);
        bytes32 h = pm.getHash(base, 100, 50);
        PackedUserOperation memory m = _op(address(acct2), 0, cd);
        assertTrue(pm.getHash(m, 100, 50) != h, "sender");
        m = _op(address(acct), 1, cd);
        assertTrue(pm.getHash(m, 100, 50) != h, "nonce");
        m = _op(address(acct), 0, cd);
        m.initCode = hex"01";
        assertTrue(pm.getHash(m, 100, 50) != h, "initCode");
        m = _op(address(acct), 0, abi.encodePacked(cd, uint8(0)));
        assertTrue(pm.getHash(m, 100, 50) != h, "callData");
        m = _op(address(acct), 0, cd);
        m.accountGasLimits = bytes32(uint256(1));
        assertTrue(pm.getHash(m, 100, 50) != h, "accountGasLimits");
        m = _op(address(acct), 0, cd);
        m.paymasterAndData = abi.encodePacked(address(pm), uint128(150_001), uint128(60_000), new bytes(77));
        assertTrue(pm.getHash(m, 100, 50) != h, "paymaster gas");
        m = _op(address(acct), 0, cd);
        m.preVerificationGas = 1;
        assertTrue(pm.getHash(m, 100, 50) != h, "preVerificationGas");
        m = _op(address(acct), 0, cd);
        m.gasFees = bytes32(uint256(1));
        assertTrue(pm.getHash(m, 100, 50) != h, "gasFees");
        assertTrue(pm.getHash(base, 101, 50) != h, "validUntil");
        assertTrue(pm.getHash(base, 100, 51) != h, "validAfter");
        // Domain: another chain or another paymaster gives another hash, so a signature does not travel.
        ODPaymaster pm2 = _deploy(signer);
        assertTrue(pm2.getHash(base, 100, 50) != h, "paymaster address");
        vm.chainId(46630);
        assertTrue(pm.getHash(base, 100, 50) != h, "chain id");
    }

    function test_SignatureNotReusableOnAnotherPaymaster() public {
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ())));
        ODPaymaster pm2 = _deploy(signer);
        address[] memory known = new address[](1);
        known[0] = address(acct);
        vm.prank(owner);
        pm2.setKernelAccounts(known, true);
        (, uint256 vd) = ep.validateOnly(address(pm2), op, MAX_COST);
        assertEq(vd & 1, 1);
    }

    function test_ValidityWindow() public {
        bytes memory cd = _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ()));
        uint48 nowTs = uint48(block.timestamp);
        PackedUserOperation memory op = _sign(_op(address(acct), 0, cd), nowTs + 600, nowTs + 300, signerKey);
        vm.expectRevert(MockPaymasterEntryPoint.OutsideWindow.selector);
        ep.handleOp(address(pm), op, MAX_COST, 0);
        op = _sign(_op(address(acct), 0, cd), 0, 0, signerKey);
        vm.expectRevert(ODPaymaster.BadValidityWindow.selector);
        _validate(op);
        op = _sign(_op(address(acct), 0, cd), nowTs + 2 hours, nowTs, signerKey);
        vm.expectRevert(ODPaymaster.BadValidityWindow.selector);
        _validate(op);
        op = _op(address(acct), 0, cd);
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(1), uint128(1), new bytes(76));
        vm.expectRevert(ODPaymaster.BadPaymasterData.selector);
        _validate(op);
    }

    function test_OnlyEntryPointCallsHooks() public {
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ())));
        vm.expectRevert(ODPaymaster.NotEntryPoint.selector);
        pm.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
        vm.expectRevert(ODPaymaster.NotEntryPoint.selector);
        pm.postOp(
            IODPaymaster.PostOpMode.opSucceeded, abi.encode(address(acct), uint64(1), uint256(1), uint256(0)), 0, 0
        );
    }

    function test_HashVector() public {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/paymaster-hash.json"));
        PackedUserOperation memory op;
        op.sender = j.readAddress(".sender");
        op.nonce = j.readUint(".nonce");
        op.initCode = j.readBytes(".initCode");
        op.callData = j.readBytes(".callData");
        op.accountGasLimits = j.readBytes32(".accountGasLimits");
        op.preVerificationGas = j.readUint(".preVerificationGas");
        op.gasFees = j.readBytes32(".gasFees");
        address at = j.readAddress(".paymaster");
        op.paymasterAndData = abi.encodePacked(at, j.readBytes32(".paymasterGasLimits"), new bytes(77));
        vm.etch(at, address(pm).code);
        vm.chainId(j.readUint(".chainId"));
        bytes32 got =
            ODPaymaster(payable(at)).getHash(op, uint48(j.readUint(".validUntil")), uint48(j.readUint(".validAfter")));
        assertEq(got, j.readBytes32(".hash"));
    }

    // ------------------------------------------------------------------------------------------------ Kernel accounts

    function test_UnknownAccountNotSponsored() public {
        MockKernelAccount fresh = new MockKernelAccount();
        PackedUserOperation memory op =
            _signed(address(fresh), 0, _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ())));
        vm.expectRevert(abi.encodeWithSelector(ODPaymaster.UnknownAccount.selector, address(fresh)));
        _validate(op);
        // An account that only names its function execute is not a Kernel account either.
        EvilExecuteAccount evil = new EvilExecuteAccount(address(other));
        op = _signed(address(evil), 0, _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ())));
        vm.expectRevert(abi.encodeWithSelector(ODPaymaster.UnknownAccount.selector, address(evil)));
        _validate(op);
    }

    function test_KernelFactoryDeploymentRegisters() public {
        MockKernelAccount fresh = new MockKernelAccount();
        PackedUserOperation memory op =
            _op(address(fresh), 0, _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ())));
        op.initCode = abi.encodePacked(pm.KERNEL_FACTORY(), hex"c5265d5d");
        op = _sign(op, uint48(block.timestamp + 300), uint48(block.timestamp - 10), signerKey);
        assertEq(_validate(op) & 1, 0);
        assertTrue(pm.kernelAccount(address(fresh)));
    }

    function _standardInit(address ownerKey) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            bytes4(keccak256("initialize(bytes21,address,bytes,bytes,bytes[])")),
            bytes21(abi.encodePacked(bytes1(0x01), pm.ECDSA_VALIDATOR())),
            address(1),
            abi.encodePacked(ownerKey),
            bytes(""),
            new bytes[](0)
        );
    }

    function test_RegisterKernelAccount() public {
        MockKernelFactory f = new MockKernelFactory();
        vm.etch(pm.KERNEL_FACTORY(), address(f).code);
        MockKernelAccount fresh = new MockKernelAccount();
        bytes memory init = _standardInit(makeAddr("user"));
        MockKernelFactory(pm.KERNEL_FACTORY()).setAddress(init, bytes32(uint256(3)), address(fresh));
        // A non-standard setup (another root validator) is refused.
        bytes memory bad = abi.encodeWithSelector(
            bytes4(keccak256("initialize(bytes21,address,bytes,bytes,bytes[])")),
            bytes21(abi.encodePacked(bytes1(0x01), address(0xdead))),
            address(1),
            abi.encodePacked(makeAddr("user")),
            bytes(""),
            new bytes[](0)
        );
        vm.expectRevert(ODPaymaster.NotStandardAccount.selector);
        pm.registerKernelAccount(address(fresh), bad, bytes32(uint256(3)));
        // Wrong salt: the factory derives another address.
        vm.expectRevert(abi.encodeWithSelector(ODPaymaster.UnknownAccount.selector, address(fresh)));
        pm.registerKernelAccount(address(fresh), init, bytes32(uint256(4)));
        // Anyone may register the real one.
        vm.prank(stranger);
        pm.registerKernelAccount(address(fresh), init, bytes32(uint256(3)));
        assertTrue(pm.kernelAccount(address(fresh)));
    }

    // ------------------------------------------------------------------------------------------------ R8

    function test_DailyCaps() public {
        bytes memory cd = _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ()));
        PackedUserOperation memory big = _signed(address(acct), 0, cd);
        vm.expectRevert(abi.encodeWithSelector(ODPaymaster.MaxCostPerOpExceeded.selector, PER_OP + 1, PER_OP));
        ep.validateOnly(address(pm), big, PER_OP + 1);
        // Account cap: five reservations of 0.002 fill 0.01; the sixth is refused.
        for (uint256 i; i < 5; ++i) {
            _validate(_signed(address(acct), i, cd));
        }
        PackedUserOperation memory op = _signed(address(acct), 5, cd);
        vm.expectRevert(
            abi.encodeWithSelector(
                ODPaymaster.AccountDailyCapExceeded.selector, address(acct), ACCOUNT_CAP + MAX_COST, ACCOUNT_CAP
            )
        );
        _validate(op);
        // The next day (by the signed validUntil) starts afresh.
        vm.warp(T0 + 1 days);
        _validate(_signed(address(acct), 5, cd));
        // Global cap: 0.03 over many accounts.
        vm.warp(T0 + 3 days);
        address[] memory known = new address[](20);
        for (uint256 i; i < 20; ++i) {
            known[i] = address(new MockKernelAccount());
        }
        vm.prank(owner);
        pm.setKernelAccounts(known, true);
        for (uint256 i; i < 15; ++i) {
            _validate(_signed(known[i], 0, cd));
        }
        op = _signed(known[15], 0, cd);
        vm.expectRevert(
            abi.encodeWithSelector(ODPaymaster.GlobalDailyCapExceeded.selector, GLOBAL_CAP + MAX_COST, GLOBAL_CAP)
        );
        _validate(op);
    }

    function test_PostOpRefund() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(address(minter), 10e6));
        ep.handleOp(address(pm), op, MAX_COST, 0.0005 ether);
        (, uint192 aSpent) = pm.accountUsage(address(acct));
        (, uint192 gSpent) = pm.globalUsage();
        // The mock EntryPoint passes fee 0, so only actualGasCost is booked.
        assertEq(aSpent, 0.0005 ether);
        assertEq(gSpent, 0.0005 ether);
        // With a fee, postOp gas and the 10% penalty are booked too, never more than the reservation.
        bytes memory cd = _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ()));
        (bytes memory ctx,) = ep.validateOnly(address(pm), _signed(address(acct2), 0, cd), MAX_COST);
        (, aSpent) = pm.accountUsage(address(acct2));
        assertEq(aSpent, MAX_COST, "reserved");
        uint256 extraGas = 60_000 + (800_000 + 60_000) / 10;
        vm.prank(address(ep));
        pm.postOp(IODPaymaster.PostOpMode.opSucceeded, ctx, 0.0003 ether, 1 gwei);
        (, aSpent) = pm.accountUsage(address(acct2));
        assertEq(aSpent, 0.0003 ether + extraGas * 1 gwei);
        (, gSpent) = pm.globalUsage();
        assertEq(gSpent, 0.0005 ether + 0.0003 ether + extraGas * 1 gwei);
    }

    function testFuzz_CapsNeverExceeded(uint256[8] memory costs, uint256[8] memory actuals) public {
        bytes memory cd = _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ()));
        uint256 spentReal;
        for (uint256 i; i < 8; ++i) {
            uint256 c = bound(costs[i], 1, PER_OP);
            uint256 a = bound(actuals[i], 0, c);
            PackedUserOperation memory op = _signed(address(acct), ep.nonces(address(acct)), cd);
            try ep.handleOp(address(pm), op, c, a) {
                spentReal += a;
            } catch {}
            (, uint192 aSpent) = pm.accountUsage(address(acct));
            assertLe(aSpent, ACCOUNT_CAP);
            assertEq(aSpent, spentReal);
        }
    }

    function testFuzz_JunkCallDataNeverSponsored(bytes memory junk) public {
        PackedUserOperation memory op = _signed(address(acct), 0, junk);
        vm.expectRevert();
        _validate(op);
    }

    function testFuzz_NoOtherTargetSponsored(address target, bytes memory data) public {
        vm.assume(target != address(minter) && target != address(backer) && target != address(router));
        vm.assume(target != address(usdg));
        PackedUserOperation memory op = _signed(address(acct), 0, _single(target, 0, data));
        vm.expectRevert();
        _validate(op);
    }

    // ------------------------------------------------------------------------------------------------ R9

    function test_GuardianPauses() public {
        vm.prank(stranger);
        vm.expectRevert(ODPaymaster.NotGuardianOrOwner.selector);
        pm.setPaused(true);
        vm.prank(guardian);
        pm.setPaused(true);
        assertTrue(pm.paused());
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(address(minter), 10e6));
        vm.expectRevert(ODPaymaster.PausedError.selector);
        ep.handleOp(address(pm), op, MAX_COST, 0);
        // The user's own non-sponsored transaction still works: the pause only stops sponsorship.
        vm.prank(address(0xCAFE));
        acct.execute(
            bytes32(0),
            abi.encodePacked(address(usdg), uint256(0), abi.encodeCall(usdg.approve, (address(minter), 5e6)))
        );
        vm.prank(address(acct));
        minter.buy(bytes32(uint256(1)), 5e6, address(acct));
        assertEq(minter.bought(address(acct)), 5e6);
    }

    function test_OnlyOwnerUnpauses() public {
        vm.prank(guardian);
        pm.setPaused(true);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        pm.setPaused(false);
        vm.prank(owner);
        pm.setPaused(false);
        assertFalse(pm.paused());
        // The owner may pause too.
        vm.prank(owner);
        pm.setPaused(true);
        assertTrue(pm.paused());
    }

    // ------------------------------------------------------------------------------------------------ R10

    function test_OwnerOnly() public {
        bytes memory unauth = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian);
        vm.startPrank(guardian);
        vm.expectRevert(unauth);
        pm.withdrawTo(payable(guardian), 1);
        vm.expectRevert(unauth);
        pm.addStake(1 days);
        vm.expectRevert(unauth);
        pm.unlockStake();
        vm.expectRevert(unauth);
        pm.withdrawStake(payable(guardian));
        vm.expectRevert(unauth);
        pm.setSigner(guardian);
        vm.expectRevert(unauth);
        pm.setGuardian(guardian);
        vm.expectRevert(unauth);
        pm.setLimits(1, 1, 1);
        vm.expectRevert(unauth);
        pm.setKernelAccounts(new address[](0), true);
        vm.stopPrank();
        // The owner can.
        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        pm.addStake{value: 0.5 ether}(1 days);
        assertEq(ep.stakeOf(address(pm)), 0.5 ether);
        pm.withdrawTo(payable(owner), 0.1 ether);
        assertEq(owner.balance, 0.6 ether);
        pm.setLimits(0.001 ether, 0.002 ether, 0.004 ether);
        assertEq(pm.maxCostPerOp(), 0.001 ether);
        vm.expectRevert(ODPaymaster.BadLimits.selector);
        pm.setLimits(0.06 ether, 0.1 ether, 1 ether); // above the per-op ceiling
        vm.expectRevert(ODPaymaster.BadLimits.selector);
        pm.setLimits(0.01 ether, 0.005 ether, 1 ether); // per-op above account cap
        vm.expectRevert(ODPaymaster.BadLimits.selector);
        pm.setLimits(0, 0.005 ether, 1 ether);
        address newSigner = vm.addr(0xB0B);
        pm.setSigner(newSigner);
        vm.stopPrank();
        assertEq(pm.signer(), newSigner);
        // The old signer's sponsorship no longer verifies.
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(minter), 0, abi.encodeCall(MockPaymasterTarget.ping, ())));
        assertEq(_validate(op) & 1, 1);
    }

    function test_TwoStepOwnership() public {
        address next = makeAddr("nextTimelock");
        vm.prank(owner);
        pm.transferOwnership(next);
        assertEq(pm.owner(), owner, "not yet");
        assertEq(pm.pendingOwner(), next);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pm.acceptOwnership();
        vm.prank(next);
        pm.acceptOwnership();
        assertEq(pm.owner(), next);
    }

    function test_ConstructorRejectsBadInputs() public {
        address[] memory t = _targets();
        vm.expectRevert(ODPaymaster.ZeroAddress.selector);
        new ODPaymaster(
            IEntryPoint(address(0)), owner, guardian, signer, t, address(usdg), PER_OP, ACCOUNT_CAP, GLOBAL_CAP
        );
        vm.expectRevert(ODPaymaster.ZeroAddress.selector);
        new ODPaymaster(
            IEntryPoint(address(ep)), owner, address(0), signer, t, address(usdg), PER_OP, ACCOUNT_CAP, GLOBAL_CAP
        );
        vm.expectRevert(ODPaymaster.BadTargets.selector);
        new ODPaymaster(
            IEntryPoint(address(ep)),
            owner,
            guardian,
            signer,
            new address[](0),
            address(usdg),
            PER_OP,
            ACCOUNT_CAP,
            GLOBAL_CAP
        );
        address[] memory withUsdg = new address[](1);
        withUsdg[0] = address(usdg);
        vm.expectRevert(ODPaymaster.BadTargets.selector);
        new ODPaymaster(
            IEntryPoint(address(ep)), owner, guardian, signer, withUsdg, address(usdg), PER_OP, ACCOUNT_CAP, GLOBAL_CAP
        );
        assertEq(pm.protocolTargets().length, 3);
    }
}

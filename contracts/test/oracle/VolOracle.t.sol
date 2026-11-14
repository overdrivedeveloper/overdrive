// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ODTest} from "../utils/ODTest.sol";
import {ODVolOracle} from "overdrive/oracle/ODVolOracle.sol";
import {IODVolOracle, VolPost, VolReading} from "overdrive/interfaces/IODVolOracle.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";

/// Shared setup: an oracle on a fixed clock with a signer key and helpers to sign posts.
abstract contract VolOracleBase is ODTest {
    // First well-known anvil dev key (public test material, never a real key).
    uint256 internal constant SIGNER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // test-key
    uint256 internal constant OTHER_PK = 0xB0B;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141; // not-a-key: curve order

    uint256 internal constant T0 = 1_790_000_000;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal signerAddr;
    ODVolOracle internal oracle;
    bytes32 internal constant MKT = keccak256("market:TEST");

    function setUp() public virtual {
        vm.warp(T0);
        signerAddr = vm.addr(SIGNER_PK);
        oracle = new ODVolOracle(admin, guardian, signerAddr);
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function _post(bytes32 market, uint64 sigma, uint64 nonce) internal view returns (VolPost memory p) {
        p = VolPost({
            market: market, sigmaBps: sigma, buyBlockFrom: 0, buyBlockTo: 0, validUntil: _now() + 1 hours, nonce: nonce
        });
    }

    function _sign(ODVolOracle o, VolPost memory p, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, o.hashPost(p));
        return abi.encodePacked(r, s, v);
    }

    function _submit(VolPost memory p) internal {
        oracle.post(p, _sign(oracle, p, SIGNER_PK));
    }

    /// Posts `sigma` as the next nonce after the rate-limit interval.
    function _submitNext(bytes32 market, uint64 sigma) internal {
        uint64 n = oracle.lastNonce(market) + 1;
        if (n > 1) vm.warp(vm.getBlockTimestamp() + oracle.MIN_POST_INTERVAL());
        _submit(_post(market, sigma, n));
    }
}

contract VolOracleTest is VolOracleBase {
    // ------------------------------------------------------------------ R1 signatures

    function test_ValidPostAccepted() public {
        VolPost memory p = _post(MKT, 5200, 1);
        vm.expectEmit(address(oracle));
        emit IODVolOracle.VolPosted(MKT, 5200, p.validUntil, 1);
        vm.prank(makeAddr("anyRelayer"));
        oracle.post(p, _sign(oracle, p, SIGNER_PK));
        VolReading memory r = oracle.read(MKT);
        assertEq(r.sigmaBps, 5200);
        assertEq(r.postedAt, _now());
        assertEq(r.validUntil, p.validUntil);
        assertFalse(r.stale);
        assertFalse(r.hardStale);
        assertEq(oracle.lastNonce(MKT), 1);
    }

    function test_RejectsWrongSigner() public {
        VolPost memory p = _post(MKT, 5200, 1);
        bytes memory sig = _sign(oracle, p, OTHER_PK);
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, sig);
    }

    function test_RejectsTamperedField() public {
        VolPost memory p = _post(MKT, 5200, 1);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        p.sigmaBps = 5300;
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, sig);
        p.sigmaBps = 5200;
        p.market = keccak256("market:OTHER");
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, sig);
    }

    function test_RejectsOtherChainId() public {
        VolPost memory p = _post(MKT, 5200, 1);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        bytes32 before = oracle.domainSeparator();
        vm.chainId(4663);
        assertTrue(oracle.domainSeparator() != before, "domain binds the chain id");
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, sig);
    }

    function test_RejectsOtherContract() public {
        ODVolOracle other = new ODVolOracle(admin, guardian, signerAddr);
        VolPost memory p = _post(MKT, 5200, 1);
        bytes memory sig = _sign(other, p, SIGNER_PK);
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, sig);
        other.post(p, sig);
    }

    function test_RejectsHighS() public {
        VolPost memory p = _post(MKT, 5200, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, oracle.hashPost(p));
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flipped = v == 27 ? 28 : 27;
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, abi.encodePacked(r, highS, flipped));
    }

    function test_RejectsMalformedSignature() public {
        VolPost memory p = _post(MKT, 5200, 1);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, "");
        bytes memory shortSig = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            shortSig[i] = sig[i];
        }
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, shortSig);
        sig[64] = bytes1(uint8(29));
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, sig);
    }

    function test_TypehashAndDomain() public view {
        assertEq(
            oracle.POST_TYPEHASH(),
            keccak256(
                "VolPost(bytes32 market,uint64 sigmaBps,uint64 buyBlockFrom,uint64 buyBlockTo,uint64 validUntil,uint64 nonce)"
            )
        );
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Overdrive Vol"),
                keccak256("1"),
                block.chainid,
                address(oracle)
            )
        );
        assertEq(oracle.domainSeparator(), expected);
    }

    /// test/vectors/volpost-eip712.json is the cross-language fixture for the vol engine signer; the same file is
    /// checked by app/test/volpost.test.ts::digestMatchesVector.
    function test_VectorsMatch() public {
        string memory json = vm.readFile("test/vectors/volpost-eip712.json");
        address at = vm.parseJsonAddress(json, ".typedData.domain.verifyingContract");
        vm.chainId(vm.parseJsonUint(json, ".typedData.domain.chainId"));
        vm.warp(vm.parseJsonUint(json, ".blockTimestamp"));
        assertEq(vm.parseJsonAddress(json, ".signer"), signerAddr, "vector signer is anvil account 0");
        assertEq(vm.parseJsonString(json, ".typedData.domain.name"), "Overdrive Vol");
        assertEq(vm.parseJsonString(json, ".typedData.domain.version"), "1");
        deployCodeTo("ODVolOracle.sol:ODVolOracle", abi.encode(admin, guardian, signerAddr), at);
        ODVolOracle o = ODVolOracle(at);

        VolPost memory p = VolPost({
            market: vm.parseJsonBytes32(json, ".typedData.message.market"),
            sigmaBps: uint64(vm.parseJsonUint(json, ".typedData.message.sigmaBps")),
            buyBlockFrom: uint64(vm.parseJsonUint(json, ".typedData.message.buyBlockFrom")),
            buyBlockTo: uint64(vm.parseJsonUint(json, ".typedData.message.buyBlockTo")),
            validUntil: uint64(vm.parseJsonUint(json, ".typedData.message.validUntil")),
            nonce: uint64(vm.parseJsonUint(json, ".typedData.message.nonce"))
        });
        assertEq(o.POST_TYPEHASH(), vm.parseJsonBytes32(json, ".typeHash"), "typeHash");
        assertEq(o.domainSeparator(), vm.parseJsonBytes32(json, ".domainSeparator"), "domainSeparator");
        assertEq(o.structHash(p), vm.parseJsonBytes32(json, ".structHash"), "structHash");
        bytes32 digest = o.hashPost(p);
        assertEq(digest, vm.parseJsonBytes32(json, ".digest"), "digest");

        bytes memory sig = vm.parseJsonBytes(json, ".signature");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, digest);
        assertEq(sig, abi.encodePacked(r, s, v), "signature (RFC 6979 is deterministic)");

        o.post(p, sig);
        VolReading memory reading = o.read(p.market);
        assertEq(reading.sigmaBps, p.sigmaBps);
        assertEq(reading.buyBlockFrom, p.buyBlockFrom);
        assertEq(reading.buyBlockTo, p.buyBlockTo);
        assertEq(o.lastNonce(p.market), p.nonce);
    }

    // ------------------------------------------------------------------ R2 nonce and validity

    function test_NonceReplayReverts() public {
        VolPost memory p = _post(MKT, 5200, 5);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        oracle.post(p, sig);
        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.NonceUsed.selector, uint64(5)));
        oracle.post(p, sig);
        VolPost memory older = _post(MKT, 5200, 4);
        bytes memory olderSig = _sign(oracle, older, SIGNER_PK);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.NonceUsed.selector, uint64(4)));
        oracle.post(older, olderSig);
        // Nonces are per market: nonce 1 on another market is fine.
        _submit(_post(keccak256("market:OTHER"), 5200, 1));
        _submit(_post(MKT, 5200, 6));
    }

    function test_NonceZeroRejected() public {
        VolPost memory p = _post(MKT, 5200, 0);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.NonceUsed.selector, uint64(0)));
        oracle.post(p, sig);
    }

    function testFuzz_NonceStrictlyIncreasing(uint64 a, uint64 b) public {
        a = uint64(bound(a, 1, type(uint64).max));
        _submit(_post(MKT, 5200, a));
        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        VolPost memory p = _post(MKT, 5200, b);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        if (b <= a) vm.expectRevert(abi.encodeWithSelector(IODVolOracle.NonceUsed.selector, b));
        oracle.post(p, sig);
    }

    function test_ValidityWindowBounds() public {
        uint64 t = _now();
        uint64[4] memory bad = [t, t + 5 minutes - 1, t + 2 hours + 1, t - 1];
        for (uint256 i; i < bad.length; ++i) {
            VolPost memory p = _post(MKT, 5200, 1);
            p.validUntil = bad[i];
            bytes memory sig = _sign(oracle, p, SIGNER_PK);
            vm.expectRevert(IODVolOracle.Expired.selector);
            oracle.post(p, sig);
        }
        VolPost memory lo = _post(MKT, 5200, 1);
        lo.validUntil = t + 5 minutes;
        _submit(lo);
        vm.warp(t + 30 seconds);
        VolPost memory hi = _post(MKT, 5200, 2);
        hi.validUntil = uint64(t + 30 seconds + 2 hours);
        _submit(hi);
    }

    function test_SignedPostExpiresInFlight() public {
        VolPost memory p = _post(MKT, 5200, 1);
        p.validUntil = _now() + 10 minutes;
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        vm.warp(vm.getBlockTimestamp() + 6 minutes); // now less than 5 minutes of validity left
        vm.expectRevert(IODVolOracle.Expired.selector);
        oracle.post(p, sig);
    }

    // ------------------------------------------------------------------ R3 step limit

    function test_StepLimit() public {
        _submitNext(MKT, 4000);
        _submitNext(MKT, 5000); // +25% exactly
        _submitNext(MKT, 3750); // -25% exactly
        vm.warp(vm.getBlockTimestamp() + 30 seconds);
        VolPost memory p = _post(MKT, 4688, 4); // +25.01%
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.StepTooLarge.selector, uint64(3750), uint64(4688)));
        oracle.post(p, sig);
    }

    function test_FirstPostExemptFromStep() public {
        _submitNext(MKT, 30000);
        assertEq(oracle.read(MKT).sigmaBps, 30000);
    }

    function testFuzz_StepLimit(uint64 prior, uint64 next) public {
        prior = uint64(bound(prior, 500, 30000));
        next = uint64(bound(next, 500, 30000));
        _submitNext(MKT, prior);
        vm.warp(vm.getBlockTimestamp() + 30 seconds);
        VolPost memory p = _post(MKT, next, 2);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        uint256 diff = next > prior ? next - prior : prior - next;
        bool ok = diff * 10_000 <= uint256(prior) * 2500;
        if (!ok) vm.expectRevert(abi.encodeWithSelector(IODVolOracle.StepTooLarge.selector, prior, next));
        oracle.post(p, sig);
        assertEq(oracle.read(MKT).sigmaBps, ok ? next : prior);
    }

    function test_BoundsRaiseDoesNotFreeze() public {
        _submitNext(MKT, 1000);
        vm.prank(admin);
        oracle.setBounds(MKT, 2000, 30000); // prior 1000 now below the floor
        _submitNext(MKT, 2500); // within 25% of the floor (the clamped reference)
        assertEq(oracle.read(MKT).sigmaBps, 2500);
    }

    function test_CeilingCutDoesNotFreeze() public {
        _submitNext(MKT, 20000);
        vm.prank(admin);
        oracle.setBounds(MKT, 500, 4000);
        _submitNext(MKT, 4000);
        _submitNext(MKT, 3000);
        assertEq(oracle.read(MKT).sigmaBps, 3000);
    }

    // ------------------------------------------------------------------ R4 bounds

    function test_BoundsEnforced() public {
        (uint64 f, uint64 c) = oracle.bounds(MKT);
        assertEq(f, 500);
        assertEq(c, 30000);
        _assertOutOfBounds(499, 1);
        _assertOutOfBounds(30001, 1);

        vm.prank(admin);
        oracle.setBounds(MKT, 1500, 4000); // a calm name, eligible for a race listing
        _assertOutOfBounds(1499, 1);
        _assertOutOfBounds(4001, 1);
        _submitNext(MKT, 1500);
        _submitNext(MKT, 1875);
        vm.warp(vm.getBlockTimestamp() + 30 seconds);
        _submit(_post(MKT, 2343, 3));
        // Bounds are per market.
        (f, c) = oracle.bounds(keccak256("market:OTHER"));
        assertEq(f, 500);
        assertEq(c, 30000);
    }

    function _assertOutOfBounds(uint64 sigma, uint64 nonce) internal {
        VolPost memory p = _post(MKT, sigma, nonce);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.OutOfBounds.selector, sigma));
        oracle.post(p, sig);
    }

    function test_SetBoundsHardLimits() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.InvalidBounds.selector, uint64(499), uint64(4000)));
        oracle.setBounds(MKT, 499, 4000);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.InvalidBounds.selector, uint64(500), uint64(30001)));
        oracle.setBounds(MKT, 500, 30001);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.InvalidBounds.selector, uint64(5000), uint64(4999)));
        oracle.setBounds(MKT, 5000, 4999);
        vm.expectEmit(address(oracle));
        emit IODVolOracle.BoundsSet(MKT, 500, 30000);
        oracle.setBounds(MKT, 500, 30000);
        oracle.setBounds(MKT, 4000, 4000);
        vm.stopPrank();

        address stranger = makeAddr("stranger");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, oracle.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(stranger);
        oracle.setBounds(MKT, 1000, 2000);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, oracle.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(guardian);
        oracle.setBounds(MKT, 1000, 2000);
    }

    // ------------------------------------------------------------------ R5 rate limit

    function test_RateLimit() public {
        _submit(_post(MKT, 5000, 1));
        uint64 t = _now();
        vm.warp(t + 29);
        VolPost memory p = _post(MKT, 5000, 2);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.TooSoon.selector, t + 30));
        oracle.post(p, sig);
        vm.warp(t + 30);
        oracle.post(p, sig);
        // Rate limit is per market: another market posts at once.
        _submit(_post(keccak256("market:OTHER"), 5000, 1));
    }

    function test_CompromisedSignerWalkIsSlow() public {
        // Max steps at the max rate: about 10 minutes from 5% to 300%, never in one block.
        _submitNext(MKT, 500);
        uint64 sigma = 500;
        uint256 posts;
        while (sigma < 30000) {
            uint64 next = uint64((uint256(sigma) * 12500) / 10000);
            if (next > 30000) next = 30000;
            _submitNext(MKT, next);
            sigma = next;
            ++posts;
        }
        assertGe(posts, 19, "at least 19 posts from floor to ceiling");
        assertGe(_now() - T0, 19 * 30, "at least 9.5 minutes");
    }

    // ------------------------------------------------------------------ R6 read

    function test_ReadUnknownMarket() public view {
        VolReading memory r = oracle.read(keccak256("market:NEVER"));
        assertEq(r.sigmaBps, 0);
        assertEq(r.postedAt, 0);
        assertEq(r.validUntil, 0);
        assertTrue(r.stale);
        assertTrue(r.hardStale);
        (uint64 f, uint64 c) = oracle.bounds(keccak256("market:NEVER"));
        assertEq(f, 500);
        assertEq(c, 30000);
        assertEq(oracle.lastNonce(keccak256("market:NEVER")), 0);
    }

    function test_StaleFlags() public {
        VolPost memory p = _post(MKT, 5200, 1);
        _submit(p);
        vm.warp(p.validUntil);
        VolReading memory r = oracle.read(MKT);
        assertFalse(r.stale);
        assertFalse(r.hardStale);
        vm.warp(uint256(p.validUntil) + 1);
        r = oracle.read(MKT);
        assertTrue(r.stale);
        assertFalse(r.hardStale);
        assertEq(r.sigmaBps, 5200, "last sigma stays readable");
        vm.warp(uint256(p.validUntil) + 3 days);
        assertFalse(oracle.read(MKT).hardStale);
        vm.warp(uint256(p.validUntil) + 3 days + 1);
        r = oracle.read(MKT);
        assertTrue(r.stale);
        assertTrue(r.hardStale);
        assertEq(r.sigmaBps, 5200);
        // A fresh post clears both flags.
        _submit(_post(MKT, 5200, 2));
        r = oracle.read(MKT);
        assertFalse(r.stale);
        assertFalse(r.hardStale);
    }

    function testFuzz_ReadNeverReverts(bytes32 market, uint64 dt) public {
        _submit(_post(MKT, 5200, 1));
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 100 * 365 days));
        oracle.read(market);
        oracle.read(MKT);
    }

    // ------------------------------------------------------------------ R7 signer control

    function test_GuardianRevokes() public {
        _submit(_post(MKT, 5200, 1));
        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        VolPost memory p = _post(MKT, 5200, 2);
        bytes memory sig = _sign(oracle, p, SIGNER_PK);

        vm.expectEmit(address(oracle));
        emit IODVolOracle.SignerRevoked(signerAddr);
        vm.prank(guardian);
        oracle.revokeSigner();
        assertEq(oracle.signer(), address(0));

        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(p, sig);
        assertEq(oracle.read(MKT).sigmaBps, 5200, "last value readable");
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        assertTrue(oracle.read(MKT).stale, "ages into stale");
        assertEq(oracle.read(MKT).sigmaBps, 5200);

        // Only the guardian revokes.
        address stranger = makeAddr("stranger");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ODRoles.GUARDIAN_ROLE
            )
        );
        vm.prank(stranger);
        oracle.revokeSigner();
    }

    function test_OnlyAdminSetsSigner() public {
        address newSigner = vm.addr(OTHER_PK);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, oracle.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(guardian);
        oracle.setSigner(newSigner);

        vm.prank(admin);
        vm.expectRevert(IODVolOracle.InvalidSigner.selector);
        oracle.setSigner(address(0));

        VolPost memory old = _post(MKT, 5200, 1);
        bytes memory oldSig = _sign(oracle, old, SIGNER_PK);
        vm.expectEmit(address(oracle));
        emit IODVolOracle.SignerSet(newSigner);
        vm.prank(admin);
        oracle.setSigner(newSigner);
        vm.expectRevert(IODVolOracle.BadSignature.selector);
        oracle.post(old, oldSig);
        oracle.post(old, _sign(oracle, old, OTHER_PK));
    }

    function test_ConstructorChecks() public {
        vm.expectRevert(IODVolOracle.InvalidAdmin.selector);
        new ODVolOracle(address(0), guardian, signerAddr);
        vm.expectRevert(IODVolOracle.InvalidSigner.selector);
        new ODVolOracle(admin, guardian, address(0));
        assertTrue(oracle.hasRole(oracle.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(oracle.hasRole(ODRoles.GUARDIAN_ROLE, guardian));
        assertEq(oracle.signer(), signerAddr);
    }

    // ------------------------------------------------------------------ R8 buy-block window

    function test_BuyBlockBounds() public {
        uint64 t = _now();
        _assertBadWindow(t - 1, t + 1 days, 1); // starts in the past
        _assertBadWindow(t + 2 days, t + 1 days, 1); // to before from
        _assertBadWindow(t, t + 3 days + 1, 1); // longer than 3 days
        _assertBadWindow(0, t + 1 days, 1); // half-set
        _assertBadWindow(t, 0, 1);

        VolPost memory p = _post(MKT, 5200, 1);
        p.buyBlockFrom = t + 1 days;
        p.buyBlockTo = t + 4 days;
        _submit(p);
        VolReading memory r = oracle.read(MKT);
        assertEq(r.buyBlockFrom, t + 1 days);
        assertEq(r.buyBlockTo, t + 4 days);

        // 0/0 clears the window.
        vm.warp(t + 30 seconds);
        _submit(_post(MKT, 5200, 2));
        r = oracle.read(MKT);
        assertEq(r.buyBlockFrom, 0);
        assertEq(r.buyBlockTo, 0);
    }

    function _assertBadWindow(uint64 from, uint64 to, uint64 nonce) internal {
        VolPost memory p = _post(MKT, 5200, nonce);
        p.buyBlockFrom = from;
        p.buyBlockTo = to;
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        vm.expectRevert(abi.encodeWithSelector(IODVolOracle.BadBuyBlockWindow.selector, from, to));
        oracle.post(p, sig);
    }

    function testFuzz_BuyBlockWindow(uint64 from, uint64 to) public {
        uint64 t = _now();
        from = uint64(bound(from, t, t + 30 days));
        to = uint64(bound(to, t, t + 30 days));
        VolPost memory p = _post(MKT, 5200, 1);
        p.buyBlockFrom = from;
        p.buyBlockTo = to;
        bytes memory sig = _sign(oracle, p, SIGNER_PK);
        bool ok = to >= from && to - from <= 3 days;
        if (!ok) vm.expectRevert(abi.encodeWithSelector(IODVolOracle.BadBuyBlockWindow.selector, from, to));
        oracle.post(p, sig);
        if (ok) assertEq(oracle.read(MKT).buyBlockTo, to);
    }

    // ------------------------------------------------------------------ R9 pair markets

    function test_PairKeyPosts() public {
        bytes32 a = keccak256("market:A");
        bytes32 b = keccak256("market:B");
        bytes32 pair = oracle.pairKey(a, b);
        assertEq(pair, keccak256(abi.encode(a, b)));
        assertTrue(pair != oracle.pairKey(b, a), "order matters");
        _submit(_post(a, 4000, 1));
        _submit(_post(pair, 2500, 1));
        assertEq(oracle.read(pair).sigmaBps, 2500);
        assertEq(oracle.read(a).sigmaBps, 4000);
        assertEq(oracle.read(b).sigmaBps, 0);
        vm.prank(admin);
        oracle.setBounds(pair, 1000, 4000);
        (uint64 f, uint64 c) = oracle.bounds(pair);
        assertEq(f, 1000);
        assertEq(c, 4000);
    }
}

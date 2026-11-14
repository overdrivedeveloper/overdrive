// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/// The Governor as ODFees sees it: fundCash / fundExitReserve pull USDG with transferFrom. Modes model every way the
/// real call can end: pull all, revert, pull half, pull all and settle owed fees back inside the call with notify (the
/// F12-1 path: the real Governor does this from fundCash), and pull all then hand part back with no notify.
contract FeesGovMock {
    MockUSDG internal immutable usdg;
    ODFees internal fees;
    uint256 public mode; // 0 pull, 1 revert, 2 pull half, 3 settle back with notify (F12-1), 4 hand back unnotified
    uint256 public backBps = 5_000; // share of the pull handed back in modes 3 and 4
    uint256 public received;

    constructor(MockUSDG u) {
        usdg = u;
    }

    function setFees(ODFees f) external {
        fees = f;
    }

    function setMode(uint256 m, uint256 bps) external {
        mode = m;
        backBps = bps;
    }

    function fundCash(uint256 amount) external {
        _take(amount);
    }

    function fundExitReserve(uint256 amount) external {
        _take(amount);
    }

    function _take(uint256 amount) internal {
        if (mode == 1) revert("governor down");
        uint256 pull = mode == 2 ? amount / 2 : amount;
        usdg.transferFrom(msg.sender, address(this), pull);
        received += pull;
        if (mode == 3 || mode == 4) {
            uint256 back = pull * backBps / 10_000;
            usdg.transfer(address(fees), back);
            received -= back;
            if (mode == 3) fees.notify(fees.K_TOLL(), bytes32(0), back); // owed fees settled back (F12-1)
        }
    }
}

/// The stakers recipient: notifyRewards pulls the USDG, or reverts.
contract FeesStakeMock {
    MockUSDG internal immutable usdg;
    bool public down;
    uint256 public received;

    constructor(MockUSDG u) {
        usdg = u;
    }

    function setDown(bool v) external {
        down = v;
    }

    function notifyRewards(uint256 amount) external {
        if (down) revert("stake down");
        usdg.transferFrom(msg.sender, address(this), amount);
        received += amount;
    }
}

/// Stateful handler over ODFees with the real contract and real transfers. Every action is bounded and never reverts
/// itself; per-step checks count violations, the invariants read the counters and the global books.
contract FeesHandler is Test {
    ODFees internal fees;
    MockUSDG internal usdg;
    FeesGovMock internal gov;
    FeesStakeMock internal stake;
    address internal admin;
    address internal notifier;
    address internal stranger = makeAddr("feesStranger");
    address[4] internal pots; // keepers, hedgers, treasury, burn (plain transfers)
    bytes32[7] internal buckets;

    /// Expected unbooked USDG (balance - books): grows by donations only, sync zeroes it. distribute, release and
    /// notify must leave it unchanged (they never mint or destroy value in the books).
    uint256 public ghostSlack;
    uint256 public ghostIn; // every USDG unit sent to ODFees (notify arrivals, donations, settle-backs)
    uint256 public ghostOut; // every USDG unit that left ODFees
    uint256 public ghostNotified;
    uint256 public ghostSynced;

    uint256 public slackViolations; // an action changed balance - books other than as expected
    uint256 public authViolations; // an unauthorised call succeeded
    uint256 public earlyDistributions; // distribute succeeded before lastDistribution + PERIOD
    uint256 public unarrivedNotifies; // notify succeeded without the USDG having arrived
    uint256 public f121Paths; // distributions that ran with the Governor settling fees back inside its payout
    mapping(bytes32 => uint256) public calls;

    constructor(
        ODFees f,
        MockUSDG u,
        FeesGovMock g,
        FeesStakeMock s,
        address admin_,
        address notifier_,
        address[4] memory p
    ) {
        fees = f;
        usdg = u;
        gov = g;
        stake = s;
        admin = admin_;
        notifier = notifier_;
        pots = p;
        buckets = [
            f.B_GOVERNOR(), f.B_EXIT_RESERVE(), f.B_KEEPERS(), f.B_HEDGERS(), f.B_TREASURY(), f.B_STAKERS(), f.B_BURN()
        ];
    }

    // ------------------------------------------------------------------------------------------ helpers

    function _books() internal view returns (uint256) {
        return fees.pending() + fees.totalHeld();
    }

    function _bal() internal view returns (uint256) {
        return usdg.balanceOf(address(fees));
    }

    function _outside() internal view returns (uint256 sum) {
        sum = usdg.balanceOf(address(gov)) + usdg.balanceOf(address(stake));
        for (uint256 i; i < 4; ++i) {
            sum += usdg.balanceOf(pots[i]);
        }
    }

    function _checkSlack() internal {
        if (_bal() < _books() || _bal() - _books() != ghostSlack) ++slackViolations;
    }

    // ------------------------------------------------------------------------------------------ actions

    /// A notifier sends USDG and notifies it. With `short` set it notifies more than arrived: must revert NotArrived.
    function notify(uint256 kindSeed, uint256 amount, bool short) external {
        ++calls["notify"];
        amount = bound(amount, 1, 1_000_000e6);
        bytes32 kind = [fees.K_SPREAD(), fees.K_TOLL(), fees.K_BACKER_TOLL()][kindSeed % 3];
        uint256 send = short ? amount - 1 : amount;
        if (short && ghostSlack != 0) send = 0; // slack could cover the gap: keep the shortfall real
        if (send != 0) {
            usdg.mint(notifier, send);
            vm.prank(notifier);
            usdg.transfer(address(fees), send);
            ghostIn += send;
        }
        uint256 b0 = _books();
        vm.prank(notifier);
        try fees.notify(kind, keccak256(abi.encode(kindSeed)), amount) {
            if (short && _bal() < b0 + amount) ++unarrivedNotifies;
            if (_books() != b0 + amount) ++slackViolations;
            ghostNotified += amount;
            ghostSlack = ghostSlack + send - amount;
        } catch {
            ghostSlack += send; // the arrival stays as unbooked USDG until sync
            if (!short) ++slackViolations; // a full arrival must be accepted
        }
        _checkSlack();
    }

    /// Unnotified USDG lands on ODFees.
    function donate(uint256 amount) external {
        ++calls["donate"];
        amount = bound(amount, 1, 100_000e6);
        usdg.mint(address(this), amount);
        usdg.transfer(address(fees), amount);
        ghostIn += amount;
        ghostSlack += amount;
        _checkSlack();
    }

    function sync() external {
        ++calls["sync"];
        uint256 b0 = _books();
        uint256 got = fees.sync();
        if (got != ghostSlack || _books() != b0 + got) ++slackViolations;
        ghostSynced += got;
        ghostSlack = 0;
        _checkSlack();
    }

    function warp(uint256 dt) external {
        ++calls["warp"];
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1 hours, 10 days));
    }

    function distribute() external {
        ++calls["distribute"];
        uint256 next = fees.lastDistribution() + fees.PERIOD();
        uint256 bal0 = _bal();
        uint256 out0 = _outside();
        uint256 mode = gov.mode();
        try fees.distribute() {
            ++calls["distributeOk"];
            if (vm.getBlockTimestamp() < next) ++earlyDistributions;
            if (mode == 3) ++f121Paths;
            _account(bal0, out0);
        } catch {
            if (vm.getBlockTimestamp() >= next) ++slackViolations; // distribute never fails once due
        }
        _checkSlack();
    }

    function release(uint256 bucketSeed) external {
        ++calls["release"];
        uint256 bal0 = _bal();
        uint256 out0 = _outside();
        try fees.release(buckets[bucketSeed % 7]) {
            _account(bal0, out0);
        } catch {
            ++slackViolations; // release never reverts: a failed payout is held
        }
        _checkSlack();
    }

    /// Moves of USDG between ODFees and the recipients: everything outside grows by exactly what ODFees lost.
    function _account(uint256 bal0, uint256 out0) internal {
        uint256 bal1 = _bal();
        uint256 out1 = _outside();
        if (out1 < out0 || bal1 > bal0 || out1 - out0 != bal0 - bal1) ++slackViolations;
        ghostOut += bal0 - bal1;
    }

    function setGovMode(uint256 m, uint256 bps) external {
        ++calls["setGovMode"];
        gov.setMode(m % 5, bound(bps, 0, 10_000));
    }

    function setStakeDown(bool v) external {
        ++calls["setStakeDown"];
        stake.setDown(v);
    }

    function setPotBlocked(uint256 i, bool v) external {
        ++calls["setPotBlocked"];
        usdg.setBlocked(pots[i % 4], v);
    }

    /// The admin points a bucket at nobody (held) or back at its usual recipient.
    function setRecipient(uint256 bucketSeed, bool none) external {
        ++calls["setRecipient"];
        uint256 i = bucketSeed % 7;
        address to;
        if (!none) {
            if (i < 2) to = address(gov);
            else if (i == 5) to = address(stake);
            else to = pots[i == 6 ? 3 : i - 2];
        }
        vm.prank(admin);
        fees.setRecipient(buckets[i], to);
    }

    function setSplit(uint16 ops, uint16 treasury, uint16 stakers) external {
        ++calls["setSplit"];
        ops = uint16(bound(ops, 0, 10_000));
        treasury = uint16(bound(treasury, 0, 10_000 - ops));
        stakers = uint16(bound(stakers, 0, 10_000 - ops - treasury));
        vm.prank(admin);
        fees.setSplit(ops, treasury, stakers, 10_000 - ops - treasury - stakers);
    }

    function setOpsSplit(uint16 g, uint16 r, uint16 k) external {
        ++calls["setOpsSplit"];
        g = uint16(bound(g, 0, 10_000));
        r = uint16(bound(r, 0, 10_000 - g));
        k = uint16(bound(k, 0, 10_000 - g - r));
        vm.prank(admin);
        fees.setOpsSplit(g, r, k, 10_000 - g - r - k);
    }

    /// Every privileged entry point refuses a stranger; notify refuses a non-notifier.
    function strangerCalls(uint256 which, uint256 amount) external {
        ++calls["stranger"];
        amount = bound(amount, 0, 1_000e6);
        vm.startPrank(stranger);
        bool ok;
        uint256 w = which % 6;
        if (w == 0) (ok,) = address(fees).call(abi.encodeCall(ODFees.notify, (fees.K_TOLL(), bytes32(0), amount)));
        else if (w == 1) (ok,) = address(fees).call(abi.encodeCall(ODFees.setSplit, (10_000, 0, 0, 0)));
        else if (w == 2) (ok,) = address(fees).call(abi.encodeCall(ODFees.setOpsSplit, (10_000, 0, 0, 0)));
        else if (w == 3) (ok,) = address(fees).call(abi.encodeCall(ODFees.setRecipient, (buckets[2], stranger)));
        else if (w == 4) (ok,) = address(fees).call(abi.encodeCall(ODFees.setFeeParams, (0, 0)));
        else (ok,) = address(fees).call(abi.encodeCall(ODFees.setNotifier, (stranger, true)));
        vm.stopPrank();
        if (ok) ++authViolations;
    }

    function heldSum() external view returns (uint256 sum) {
        for (uint256 i; i < 7; ++i) {
            sum += fees.held(buckets[i]);
        }
    }
}

/// ODFees stateful suite: real ODFees, mock USDG with a blocklist, a Governor mock covering the F12-1 settle-back,
/// a stake mock and plain-transfer pots. 100 runs x 100 depth = 10,000 calls per invariant.
contract FeesInvariantTest is Test {
    ODFees internal fees;
    MockUSDG internal usdg;
    FeesGovMock internal gov;
    FeesStakeMock internal stake;
    FeesHandler internal h;
    address internal admin = makeAddr("feesAdmin");
    address internal notifier = makeAddr("feesNotifier");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        gov = new FeesGovMock(usdg);
        stake = new FeesStakeMock(usdg);
        fees = new ODFees(IERC20(address(usdg)), admin, address(gov));
        gov.setFees(fees);
        address[4] memory pots = [makeAddr("keepers"), makeAddr("hedgers"), makeAddr("treasury"), makeAddr("burn")];
        vm.startPrank(admin);
        fees.setNotifier(notifier, true);
        fees.setNotifier(address(gov), true); // the Governor notifies owed fees (F12-1 path)
        fees.setRecipient(fees.B_KEEPERS(), pots[0]);
        fees.setRecipient(fees.B_HEDGERS(), pots[1]);
        fees.setRecipient(fees.B_TREASURY(), pots[2]);
        fees.setRecipient(fees.B_STAKERS(), address(stake));
        fees.setRecipient(fees.B_BURN(), pots[3]);
        vm.stopPrank();
        h = new FeesHandler(fees, usdg, gov, stake, admin, notifier, pots);
        targetContract(address(h));
    }

    /// ODFees USDG balance >= pending + totalHeld, and the gap is exactly the unbooked USDG (donations not yet synced).
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_F1_BooksCoveredAndExact() public view {
        uint256 bal = usdg.balanceOf(address(fees));
        uint256 books = fees.pending() + fees.totalHeld();
        assertGe(bal, books, "ODFees books more USDG than it holds");
        assertEq(bal - books, h.ghostSlack(), "unbooked USDG drifted");
    }

    /// distribute, release, notify and sync never mint or destroy value: per-step check count, and the global ledger
    /// in - out = balance, books = notified + synced - paid out.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_F2_NoValueMinted() public view {
        assertEq(h.slackViolations(), 0, "an action changed the books other than by its own amount");
        assertEq(usdg.balanceOf(address(fees)), h.ghostIn() - h.ghostOut(), "USDG ledger");
        assertEq(
            fees.pending() + fees.totalHeld(),
            h.ghostNotified() + h.ghostSynced() - h.ghostOut(),
            "books = notified + synced - paid"
        );
        assertEq(h.unarrivedNotifies(), 0, "notify booked USDG that had not arrived");
    }

    /// totalHeld is the sum of the seven buckets; splits sum to 10,000 bps; fee params stay under the cap.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_F3_HeldSumAndSplits() public view {
        assertEq(fees.totalHeld(), h.heldSum(), "totalHeld = sum of buckets");
        assertEq(uint256(fees.opsBps()) + fees.treasuryBps() + fees.stakersBps() + fees.burnBps(), 10_000, "split sum");
        assertEq(
            uint256(fees.governorBps()) + fees.exitReserveBps() + fees.keepersBps() + fees.hedgersBps(),
            10_000,
            "ops split sum"
        );
        assertLe(fees.protocolSpreadShareBps(), fees.MAX_FEE_PARAM_BPS());
        assertLe(fees.tollFeeBps(), fees.MAX_FEE_PARAM_BPS());
    }

    /// Only the admin sets parameters, only notifiers notify; distribute runs at most once per PERIOD.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_F4_AuthAndCadence() public view {
        assertEq(h.authViolations(), 0, "an unauthorised call succeeded");
        assertEq(h.earlyDistributions(), 0, "distribute ran before its period");
        assertLe(fees.lastDistribution(), vm.getBlockTimestamp());
    }
}

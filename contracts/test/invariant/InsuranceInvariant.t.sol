// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODInsurance} from "overdrive/governor/ODInsurance.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/// Stateful handler over the real ODInsurance: funders, donations, cover draws by the Governor, the backer and
/// strangers, coverer resets and USDG pauses. Every action is bounded and never reverts itself.
contract InsuranceHandler is Test {
    ODInsurance internal ins;
    MockUSDG internal usdg;
    address internal admin;
    address internal gov;
    address internal backer;
    address[3] internal outsiders; // a stranger, the admin, a funder: none may draw

    uint256 public ghostFunded;
    uint256 public ghostDonated;
    uint256 public ghostPaid; // sum of sent over every successful cover
    uint256 public ghostAsked; // sum of amounts asked over every successful cover
    mapping(address => uint256) public ghostReceived; // per coverer

    uint256 public overpays; // a cover sent more than min(asked, balance before)
    uint256 public underpays; // a cover sent less than min(asked, balance before)
    uint256 public misdirected; // a cover's USDG went anywhere but msg.sender
    uint256 public outsiderDraws; // a non-coverer drew
    uint256 public covererResets; // a coverer changed after it was set
    uint256 public coverFailures; // a coverer's draw reverted with the token live
    mapping(bytes32 => uint256) public calls;

    constructor(ODInsurance i, MockUSDG u, address admin_, address gov_, address backer_) {
        ins = i;
        usdg = u;
        admin = admin_;
        gov = gov_;
        backer = backer_;
        outsiders = [makeAddr("insStranger"), admin_, makeAddr("insFunder")];
    }

    function fund(uint256 amount, uint256 who) external {
        ++calls["fund"];
        amount = bound(amount, 0, 1_000_000e6);
        address f = who % 2 == 0 ? makeAddr("insFunder") : gov;
        if (!usdg.paused()) usdg.mint(f, amount); // a paused token refuses the mint; fund must then revert
        vm.startPrank(f);
        usdg.approve(address(ins), amount);
        try ins.fund(amount) {
            ghostFunded += amount;
        } catch {
            if (!usdg.paused()) ++coverFailures;
        }
        vm.stopPrank();
    }

    function donate(uint256 amount) external {
        ++calls["donate"];
        if (usdg.paused()) return;
        amount = bound(amount, 0, 100_000e6);
        usdg.mint(address(ins), amount);
        ghostDonated += amount;
    }

    /// The Governor or the backer draws. Sent must be exactly min(asked, balance), to the caller, once.
    function cover(uint256 amount, bool byBacker) external {
        ++calls["cover"];
        address c = byBacker ? backer : gov;
        uint256 bal0 = usdg.balanceOf(address(ins));
        amount = bound(amount, 0, bal0 * 2 + 1e6);
        uint256 cBal0 = usdg.balanceOf(c);
        uint256 others0 = usdg.balanceOf(byBacker ? gov : backer);
        vm.prank(c);
        try ins.cover(amount) returns (uint256 sent) {
            uint256 want = amount < bal0 ? amount : bal0;
            if (sent > want) ++overpays;
            if (sent < want) ++underpays;
            if (usdg.balanceOf(c) - cBal0 != sent || bal0 - usdg.balanceOf(address(ins)) != sent) ++misdirected;
            if (usdg.balanceOf(byBacker ? gov : backer) != others0) ++misdirected;
            ghostPaid += sent;
            ghostAsked += amount;
            ghostReceived[c] += sent;
        } catch {
            if (!usdg.paused()) ++coverFailures;
        }
    }

    /// A non-coverer (stranger, admin, funder) tries to draw: must revert.
    function outsiderCover(uint256 who, uint256 amount) external {
        ++calls["outsiderCover"];
        amount = bound(amount, 0, 1_000_000e6);
        vm.prank(outsiders[who % 3]);
        try ins.cover(amount) {
            ++outsiderDraws;
        } catch {}
    }

    /// The admin (or a stranger) tries to replace a coverer that is already set: must revert.
    function resetCoverers(bool byAdmin, bool both) external {
        ++calls["resetCoverers"];
        address n = makeAddr("newCoverer");
        vm.prank(byAdmin ? admin : outsiders[0]);
        try ins.setCoverers(n, both ? n : address(0)) {} catch {}
        if (ins.governor() != gov || ins.backer() != backer) ++covererResets;
    }

    function setPaused(bool p) external {
        ++calls["setPaused"];
        usdg.setPaused(p);
    }
}

/// ODInsurance stateful suite: 100 runs x 100 depth = 10,000 calls per invariant.
contract InsuranceInvariantTest is Test {
    ODInsurance internal ins;
    MockUSDG internal usdg;
    InsuranceHandler internal h;
    address internal admin = makeAddr("insAdmin");
    address internal gov = makeAddr("insGovernor");
    address internal backer = makeAddr("insBacker");

    function setUp() public {
        usdg = new MockUSDG();
        ins = new ODInsurance(IERC20(address(usdg)), admin, address(0), address(0));
        vm.prank(admin);
        ins.setCoverers(gov, backer);
        h = new InsuranceHandler(ins, usdg, admin, gov, backer);
        targetContract(address(h));
    }

    /// The pool holds exactly funded + donated - paid; payouts never exceed what came in.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_I1_BalanceConserved() public view {
        assertEq(usdg.balanceOf(address(ins)), h.ghostFunded() + h.ghostDonated() - h.ghostPaid(), "insurance ledger");
        assertEq(ins.balance(), usdg.balanceOf(address(ins)));
        assertLe(h.ghostPaid(), h.ghostFunded() + h.ghostDonated());
    }

    /// Every draw pays exactly min(asked, balance) to its caller, once: never more, never to anyone else.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_I2_PayoutsBounded() public view {
        assertEq(h.overpays(), 0, "a cover paid more than asked or held");
        assertEq(h.underpays(), 0, "a cover paid less than min(asked, balance)");
        assertEq(h.misdirected(), 0, "cover USDG went to someone other than the caller");
        assertLe(h.ghostPaid(), h.ghostAsked());
        assertEq(h.ghostReceived(gov) + h.ghostReceived(backer), h.ghostPaid(), "only coverers received");
        assertEq(h.coverFailures(), 0, "a coverer draw or a fund reverted with the token live");
    }

    /// Only the Governor and the backer draw; the coverers are set once and never replaced; the admin cannot draw.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_I3_OnlyCoverers() public view {
        assertEq(h.outsiderDraws(), 0, "a non-coverer drew from insurance");
        assertEq(h.covererResets(), 0, "a coverer was replaced");
        assertEq(ins.governor(), gov);
        assertEq(ins.backer(), backer);
    }
}

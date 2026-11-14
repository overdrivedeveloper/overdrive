// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODOracleGuard} from "overdrive/oracle/ODOracleGuard.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {GearStatus, Session} from "overdrive/interfaces/ODTypes.sol";

/// What the queue handler needs from the fixture: time, prices, sessions and references (the fixture owns the mocks).
interface ISellQueueEnv {
    function envWarp(uint256 dt) external;
    function envSession(uint256 s) external;
    function envDropRef(uint256 m) external;
    function envMove(uint256 m, uint256 bps, bool up) external;
}

/// Stateful handler over the real minter sell queue (real oracle guard, registry, Governor, ODFees, insurance and
/// gear tokens from SystemFixture). Holders buy, sell, queue, cancel; anyone fills; the guardian pauses; the keeper
/// drains free cash so live sells queue. Every action is bounded and never reverts itself.
contract SellQueueHandler is Test {
    struct Rec {
        bytes32 gearId;
        address owner;
        address recipient;
        uint256 tokens;
        uint256 minOut;
    }

    ODMinter internal minter;
    ODGovernor internal gov;
    ODGearRegistry internal reg;
    ODOracleGuard internal guard;
    MockUSDG internal usdg;
    ISellQueueEnv internal env;
    address internal admin;
    address internal guardian;
    address[4] internal holders;
    address internal filler = makeAddr("sqFiller");
    bytes32[] internal gearIds;
    address[] internal tokenOf;
    bytes32[3] internal markets = [bytes32("TSLA"), bytes32("NVDA"), bytes32("ETH")];

    uint256[] public open; // open tickets
    uint256[] public closed; // filled or cancelled tickets
    mapping(uint256 => Rec) public rec;
    mapping(address => uint256) public ghostEscrow; // per gear token: tokens sitting in open tickets

    uint256 public ghostQueued;
    uint256 public ghostFilled;
    uint256 public ghostCancelled;
    uint256 public gatedExits; // queueSell or an owner cancel refused
    uint256 public orderBreaks; // a new ticket id was not ticketCount + 1, or a ticket was reused
    uint256 public wrongSettles; // a fill paid other than its result, below minUsdgOut, or moved escrow wrongly
    uint256 public wrongRefunds; // a cancel returned other than exactly the escrowed tokens to the owner
    uint256 public reopened; // a closed ticket was filled or cancelled again, or a non-owner cancelled
    uint256 public sticky; // a refused fill or cancel changed the ticket or the escrow
    mapping(bytes32 => uint256) public calls;

    constructor(
        ODMinter m,
        ODGovernor g,
        ODGearRegistry r,
        ODOracleGuard gd,
        MockUSDG u,
        ISellQueueEnv e,
        address admin_,
        address guardian_,
        bytes32[] memory ids
    ) {
        minter = m;
        gov = g;
        reg = r;
        guard = gd;
        usdg = u;
        env = e;
        admin = admin_;
        guardian = guardian_;
        holders = [makeAddr("sqH0"), makeAddr("sqH1"), makeAddr("sqH2"), makeAddr("sqH3")];
        gearIds = ids;
        for (uint256 i; i < ids.length; ++i) {
            tokenOf.push(r.gear(ids[i]).token);
        }
        for (uint256 i; i < 4; ++i) {
            vm.prank(holders[i]);
            u.approve(address(m), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------------------------------ holders

    function buy(uint256 actor, uint256 gi, uint256 usdgIn) external {
        ++calls["buy"];
        address who = holders[actor % 4];
        bytes32 g = gearIds[gi % gearIds.length];
        usdgIn = bound(usdgIn, 10e6, 20_000e6);
        usdg.mint(who, usdgIn);
        vm.prank(who);
        try minter.buy(g, usdgIn, 0, who, uint64(vm.getBlockTimestamp())) {
            ++calls["buyOk"];
        } catch {}
    }

    function sell(uint256 actor, uint256 gi, uint256 frac) external {
        ++calls["sell"];
        address who = holders[actor % 4];
        uint256 i = gi % gearIds.length;
        uint256 bal = IERC20(tokenOf[i]).balanceOf(who);
        if (bal == 0) return;
        vm.prank(who);
        try minter.sell(gearIds[i], bound(frac, 1, bal), 0, who, uint64(vm.getBlockTimestamp())) {} catch {}
    }

    /// Queueing is an exit: it must succeed for any holder, any amount held, any session, pause or status.
    function queueSell(uint256 actor, uint256 gi, uint256 frac, uint256 minOut, uint256 to) external {
        ++calls["queueSell"];
        address who = holders[actor % 4];
        uint256 i = gi % gearIds.length;
        address token = tokenOf[i];
        uint256 bal = IERC20(token).balanceOf(who);
        if (bal == 0) {
            // nothing held: try to buy first (refused buys are fine; then there is nothing to queue)
            usdg.mint(who, 5_000e6);
            vm.prank(who);
            try minter.buy(gearIds[i], 5_000e6, 0, who, uint64(vm.getBlockTimestamp())) {
                ++calls["buyOk"];
            } catch {}
            bal = IERC20(token).balanceOf(who);
            if (bal == 0) return;
        }
        uint256 tokens = bound(frac, 1, bal);
        minOut = minOut % 3 == 0 ? 0 : bound(minOut, 0, 50_000e6);
        address recipient = holders[to % 4];
        uint256 expectId = minter.ticketCount() + 1;
        uint256 esc0 = IERC20(token).balanceOf(address(minter));
        vm.prank(who);
        try minter.queueSell(gearIds[i], tokens, minOut, recipient) returns (uint256 t) {
            if (t != expectId || rec[t].tokens != 0) ++orderBreaks;
            if (IERC20(token).balanceOf(address(minter)) != esc0 + tokens) ++wrongSettles;
            if (IERC20(token).balanceOf(who) != bal - tokens) ++wrongSettles;
            rec[t] = Rec(gearIds[i], who, recipient, tokens, minOut);
            open.push(t);
            ghostEscrow[token] += tokens;
            ++ghostQueued;
        } catch {
            ++gatedExits;
        }
    }

    /// Anyone fills. A fill pays the recipient exactly its result, at least minUsdgOut, and burns exactly the escrow.
    function fill(uint256 ti, bool byOwner) external {
        ++calls["fill"];
        if (open.length == 0) return;
        uint256 k = ti % open.length;
        uint256 t = open[k];
        Rec memory r = rec[t];
        address token = _tokenOf(r.gearId);
        uint256 esc0 = IERC20(token).balanceOf(address(minter));
        uint256 rBal0 = usdg.balanceOf(r.recipient);
        vm.prank(byOwner ? r.owner : filler);
        try minter.fillQueued(t) returns (uint256 out) {
            ++calls["fillOk"];
            if (out < r.minOut || usdg.balanceOf(r.recipient) - rBal0 != out) ++wrongSettles;
            if (esc0 - IERC20(token).balanceOf(address(minter)) != r.tokens) ++wrongSettles;
            (,,, uint256 left,) = minter.queuedSell(t);
            if (left != 0) ++wrongSettles;
            _close(k, token, r.tokens);
            ++ghostFilled;
        } catch {
            ++calls["fillRefused"];
            _checkUnchanged(t, r, token, esc0);
        }
    }

    /// Markets reopen and every input is refreshed, then the fill runs (the path a keeper takes at the next open).
    function fillFresh(uint256 ti, bool byOwner) external {
        ++calls["fillFresh"];
        env.envSession(0);
        env.envWarp(1 minutes);
        this.fill(ti, byOwner);
    }

    /// The owner cancels: always allowed, returns exactly the escrowed tokens. Anyone else is refused.
    function cancel(uint256 ti, bool byOwner) external {
        ++calls["cancel"];
        if (open.length == 0) return;
        uint256 k = ti % open.length;
        uint256 t = open[k];
        Rec memory r = rec[t];
        address token = _tokenOf(r.gearId);
        uint256 esc0 = IERC20(token).balanceOf(address(minter));
        uint256 oBal0 = IERC20(token).balanceOf(r.owner);
        address caller = byOwner ? r.owner : filler;
        vm.prank(caller);
        try minter.cancelQueued(t) {
            if (!byOwner) ++reopened;
            if (IERC20(token).balanceOf(r.owner) - oBal0 != r.tokens) ++wrongRefunds;
            if (esc0 - IERC20(token).balanceOf(address(minter)) != r.tokens) ++wrongRefunds;
            _close(k, token, r.tokens);
            ++ghostCancelled;
        } catch {
            if (byOwner) ++gatedExits;
            _checkUnchanged(t, r, token, esc0);
        }
    }

    /// A filled or cancelled ticket can never be filled or cancelled again.
    function replayClosed(uint256 ti, bool asFill) external {
        ++calls["replayClosed"];
        if (closed.length == 0) return;
        uint256 t = closed[ti % closed.length];
        address owner = rec[t].owner;
        vm.prank(owner);
        bool ok;
        if (asFill) (ok,) = address(minter).call(abi.encodeCall(ODMinter.fillQueued, (t)));
        else (ok,) = address(minter).call(abi.encodeCall(ODMinter.cancelQueued, (t)));
        if (ok) ++reopened;
    }

    // ------------------------------------------------------------------------------------------ environment

    function warp(uint256 dt) external {
        ++calls["warp"];
        env.envWarp(bound(dt, 1 minutes, 2 days));
    }

    function session(uint256 s) external {
        ++calls["session"];
        env.envSession(s);
    }

    function dropRef(uint256 m) external {
        ++calls["dropRef"];
        env.envDropRef(m);
    }

    function move(uint256 m, uint256 bps, bool up) external {
        ++calls["move"];
        env.envMove(m, bound(bps, 0, 300), up);
    }

    /// The keeper moves all free cash to the exit reserve, so live sells and fills need the reserve.
    function drainCash() external {
        ++calls["drainCash"];
        uint256 c = gov.trackedCash();
        if (c == 0) return;
        vm.prank(admin);
        try gov.moveToExitReserve(c) {} catch {}
    }

    /// The guardian pauses (Governor buys, a market, or a gear to BUYS_PAUSED / SELL_ONLY); the admin lifts it.
    function pause(uint256 which, uint256 idx) external {
        ++calls["pause"];
        bool on = which % 4 == 0; // lifts three times as often as it pauses, so buys stay reachable
        uint256 w = (which / 4) % 3;
        vm.startPrank(on ? guardian : admin);
        if (w == 0) {
            try gov.setBuysPaused(on) {} catch {}
        } else if (w == 1) {
            try guard.setBuysPaused(markets[idx % 3], on) {} catch {}
        } else {
            GearStatus st = on ? (idx % 2 == 0 ? GearStatus.BUYS_PAUSED : GearStatus.SELL_ONLY) : GearStatus.LISTED;
            try reg.setStatus(gearIds[idx % gearIds.length], st) {} catch {}
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------ helpers

    function _tokenOf(bytes32 g) internal view returns (address) {
        for (uint256 i; i < gearIds.length; ++i) {
            if (gearIds[i] == g) return tokenOf[i];
        }
        return address(0);
    }

    function _close(uint256 k, address token, uint256 tokens) internal {
        closed.push(open[k]);
        open[k] = open[open.length - 1];
        open.pop();
        ghostEscrow[token] -= tokens;
    }

    function _checkUnchanged(uint256 t, Rec memory r, address token, uint256 esc0) internal {
        (bytes32 g, address o, address rc, uint256 tk, uint256 mo) = minter.queuedSell(t);
        if (g != r.gearId || o != r.owner || rc != r.recipient || tk != r.tokens || mo != r.minOut) ++sticky;
        if (IERC20(token).balanceOf(address(minter)) != esc0) ++sticky;
    }

    function openLength() external view returns (uint256) {
        return open.length;
    }

    function gearCount() external view returns (uint256) {
        return gearIds.length;
    }

    function tokenAt(uint256 i) external view returns (address) {
        return tokenOf[i];
    }
}

/// Minter sell queue stateful suite on the real protocol (SystemFixture). 100 runs x 100 depth = 10,000 calls per
/// invariant.
contract SellQueueInvariantTest is SystemFixture, ISellQueueEnv {
    SellQueueHandler internal h;

    function setUp() public override {
        super.setUp();
        bytes32[] memory ids = new bytes32[](5);
        ids[0] = sport;
        ids[1] = cruise;
        ids[2] = reverse;
        ids[3] = ethSport;
        ids[4] = pair;
        h = new SellQueueHandler(minter, gov, reg, guard, usdg, this, admin, guardian, ids);
        targetContract(address(h));
    }

    // ------------------------------------------------------------------------------------------ environment

    function envWarp(uint256 dt) external {
        _warpFresh(dt);
    }

    function envSession(uint256 s) external {
        s %= 10;
        _session(s < 5 ? Session(s) : Session.OPEN); // half the moves return to OPEN
    }

    function envDropRef(uint256 m) external {
        _dropRef([TSLA, NVDA, ETH][m % 3]);
    }

    function envMove(uint256 m, uint256 bps, bool up) external {
        bytes32 mk = [TSLA, NVDA, ETH][m % 3];
        uint256 p = _p(mk);
        _price(mk, up ? p * (10_000 + bps) / 10_000 : p * (10_000 - bps) / 10_000);
    }

    // ------------------------------------------------------------------------------------------ invariants

    /// Escrow conservation: for every gear, the minter holds exactly the tokens of the open tickets, and no USDG.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_Q1_EscrowEqualsOpenTickets() public view {
        for (uint256 i; i < h.gearCount(); ++i) {
            address token = h.tokenAt(i);
            assertEq(IERC20(token).balanceOf(address(minter)), h.ghostEscrow(token), "escrow != open tickets");
        }
        uint256 n = h.openLength();
        for (uint256 k; k < n; ++k) {
            uint256 t = h.open(k);
            (bytes32 g, address o, address r, uint256 tk, uint256 mo) = minter.queuedSell(t);
            (bytes32 g2, address o2, address r2, uint256 tk2, uint256 mo2) = h.rec(t);
            assertTrue(g == g2 && o == o2 && r == r2 && tk == tk2 && mo == mo2, "open ticket drifted");
        }
        assertEq(usdg.balanceOf(address(minter)), 0, "minter holds USDG");
    }

    /// Every queued sell settles (fill, exact payout >= minUsdgOut) or refunds (owner cancel, exact tokens), once.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_Q2_SettleOrRefundExactly() public view {
        assertEq(h.wrongSettles(), 0, "a fill paid or burned the wrong amount");
        assertEq(h.wrongRefunds(), 0, "a cancel refunded the wrong amount");
        assertEq(h.reopened(), 0, "a closed ticket settled twice, or a non-owner cancelled");
        assertEq(h.sticky(), 0, "a refused fill or cancel changed the ticket");
        assertEq(h.ghostQueued(), h.ghostFilled() + h.ghostCancelled() + h.openLength(), "ticket accounting");
    }

    /// Queue order: ticket ids are sequential from 1 and never reused; ticketCount = tickets ever opened.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_Q3_TicketOrder() public view {
        assertEq(h.orderBreaks(), 0, "ticket id out of order or reused");
        assertEq(minter.ticketCount(), h.ghostQueued(), "ticketCount");
    }

    /// Exits are never gated: queueSell and an owner cancel succeed under every session, pause, status and price state.
    /// forge-config: default.invariant.runs = 100
    /// forge-config: default.invariant.depth = 100
    /// forge-config: deep.invariant.runs = 100
    /// forge-config: deep.invariant.depth = 100
    function invariant_Q4_ExitsNeverGated() public view {
        assertEq(h.gatedExits(), 0, "a queue or owner cancel was refused");
    }

    /// One coverage line per run, appended to out/sqcov.txt: how many buys, queues, fills and cancels the run reached.
    function afterInvariant() external {
        vm.writeLine(
            "out/sqcov.txt",
            string.concat(
                "SQCOV buyOk=",
                vm.toString(h.calls("buyOk")),
                " queued=",
                vm.toString(h.ghostQueued()),
                " filled=",
                vm.toString(h.ghostFilled()),
                " cancelled=",
                vm.toString(h.ghostCancelled()),
                " fillRefused=",
                vm.toString(h.calls("fillRefused"))
            )
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODTest} from "../utils/ODTest.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockMinterForGovernor} from "../mocks/MockMinterForGovernor.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {ODInsurance} from "overdrive/governor/ODInsurance.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODVolOracle} from "overdrive/oracle/ODVolOracle.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODVolOracle} from "overdrive/interfaces/IODVolOracle.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";
import {Gear, GearConfig, MarketConfig, PriceReading, Session} from "overdrive/interfaces/ODTypes.sol";

/// Oracle guard stand-in: per-market p, refP and session.
contract GovGuard {
    struct M {
        uint256 p;
        uint256 refP;
        Session s;
    }

    mapping(bytes32 => M) public m;
    bool public bomb;

    function setBomb(bool v) external {
        bomb = v;
    }

    function set(bytes32 k, uint256 p, uint256 refP) external {
        m[k].p = p;
        m[k].refP = refP;
    }

    function setSession(bytes32 k, Session s) external {
        m[k].s = s;
    }

    function config(bytes32) external pure returns (MarketConfig memory c) {
        c.enabled = true;
    }

    function read(bytes32 k) public view returns (PriceReading memory r) {
        require(!bomb, "guard down");
        M memory x = m[k];
        r.p = x.p;
        r.refP = x.refP;
        r.session = x.s;
        r.fresh = x.s == Session.OPEN;
        r.updatedAt = uint64(block.timestamp);
    }

    function readRatio(bytes32 a, bytes32 b) external view returns (PriceReading memory r) {
        PriceReading memory ra = read(a);
        PriceReading memory rb = read(b);
        r.p = ra.p * 1e18 / rb.p;
        r.refP = (ra.refP == 0 || rb.refP == 0) ? 0 : ra.refP * 1e18 / rb.refP;
        r.fresh = ra.fresh && rb.fresh;
    }
}

/// ODFees stand-in: records notifications; shares settable.
contract GovFees {
    uint16 public protocolSpreadShareBps = 1000;
    uint16 public tollFeeBps = 1000;
    bool public reverting;
    mapping(bytes32 => uint256) public notified;

    function setReverting(bool v) external {
        reverting = v;
    }

    function notify(bytes32 kind, bytes32, uint256 usdg) external {
        require(!reverting, "fees down");
        notified[kind] += usdg;
    }
}

abstract contract GovernorFixture is ODTest {
    bytes32 internal constant TSLA = "TSLA";
    bytes32 internal constant NVDA = "NVDA";
    bytes32 internal constant SPY = "SPY";
    bytes32 internal constant ETH = "ETH";
    bytes32 internal constant NONE = bytes32(0);

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal hedger = makeAddr("hedger");
    address internal hedgeWallet = makeAddr("hedgeWallet");
    address internal backerC = makeAddr("backer");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    MockUSDG internal usdg;
    GovGuard internal guard;
    GovFees internal fees;
    ODVolOracle internal vol;
    ODGearRegistry internal reg;
    MockMinterForGovernor internal minter;
    ODInsurance internal ins;
    ODGovernor internal gov;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        guard = new GovGuard();
        fees = new GovFees();
        vol = new ODVolOracle(admin, guardian, makeAddr("volSigner"));
        reg = new ODGearRegistry(admin, guardian, IODOracleGuard(address(guard)), IODVolOracle(address(vol)));
        minter = new MockMinterForGovernor(IERC20(address(usdg)), IODGearRegistry(address(reg)));
        vm.prank(admin);
        reg.setMinter(address(minter));
        ins = new ODInsurance(IERC20(address(usdg)), admin, address(0), address(0));
        gov = new ODGovernor(
            IERC20(address(usdg)),
            admin,
            guardian,
            IODGearRegistry(address(reg)),
            IODOracleGuard(address(guard)),
            IODInsurance(address(ins)),
            address(fees)
        );
        minter.setGovernor(IODGovernor(address(gov)));
        vm.startPrank(admin);
        gov.setMinter(address(minter));
        gov.setBacker(backerC);
        gov.setHedger(hedgeWallet);
        gov.grantRole(ODRoles.HEDGER_ROLE, hedger);
        gov.grantRole(ODRoles.KEEPER_ROLE, keeper);
        gov.setDepositor(lp, true);
        gov.setMarketGroup(SPY, 1);
        gov.setMarketGroup(ETH, 2);
        ins.setCoverers(address(gov), backerC);
        vm.stopPrank();
        guard.set(TSLA, 250e18, 250e18);
        guard.set(NVDA, 125e18, 125e18);
        guard.set(SPY, 600e18, 600e18);
        guard.set(ETH, 3000e18, 3000e18);
    }

    // ------------------------------------------------------------------------------------------ helpers

    function _list(bytes32 a, bytes32 b, Gear g, uint128 cap) internal returns (bytes32 id) {
        string memory sym = b == NONE
            ? string.concat(_tick(a), reg.suffixOf(g))
            : string.concat(_tick(a), "/", _tick(b), reg.suffixOf(g));
        vm.prank(admin);
        id = reg.listGear(a, b, g, 1e18, cap, 30, sym);
    }

    function _tick(bytes32 m) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && m[n] != 0) ++n;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = m[i];
        return string(out);
    }

    function _token(bytes32 id) internal view returns (IERC20) {
        return IERC20(reg.gear(id).token);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        if (!gov.isDepositor(who)) {
            vm.prank(admin);
            gov.setDepositor(who, true);
        }
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(gov), amount);
        shares = gov.deposit(amount, who);
        vm.stopPrank();
    }

    function _markets() internal pure returns (bytes32[] memory ms) {
        ms = new bytes32[](4);
        ms[0] = TSLA;
        ms[1] = NVDA;
        ms[2] = SPY;
        ms[3] = ETH;
    }

    function _poke() internal {
        gov.pokeRisk(_markets());
    }

    /// Buys `tokens` of `id` for `usdgIn` (alice pays) with no spread.
    function _buy(bytes32 id, uint256 tokens, uint256 usdgIn) internal {
        _buyS(id, tokens, usdgIn, 0);
    }

    function _buyS(bytes32 id, uint256 tokens, uint256 usdgIn, uint256 spread) internal {
        usdg.mint(alice, usdgIn);
        vm.prank(alice);
        usdg.approve(address(minter), usdgIn);
        minter.buy(id, alice, alice, tokens, usdgIn, spread);
    }

    function _sell(bytes32 id, uint256 tokens, uint256 usdgOut) internal returns (bool) {
        return minter.sell(id, alice, alice, tokens, usdgOut, 0);
    }

    function _fundCash(uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(gov), amount);
        gov.fundCash(amount);
    }

    function _fundReserve(uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(gov), amount);
        gov.fundExitReserve(amount);
    }

    function _setParams(IODGovernor.Params memory p) internal {
        vm.prank(admin);
        gov.setParams(p);
    }
}

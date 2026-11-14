// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODTest} from "../utils/ODTest.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockPyth} from "../mocks/MockPyth.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockKindCalendar, MockAggregatorImpl} from "../mocks/OracleMocks.sol";
import {ODOracleGuard} from "overdrive/oracle/ODOracleGuard.sol";
import {ODVolOracle} from "overdrive/oracle/ODVolOracle.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {ODInsurance} from "overdrive/governor/ODInsurance.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODVolOracle, VolPost} from "overdrive/interfaces/IODVolOracle.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {Gear, MarketConfig, Quote, Session} from "overdrive/interfaces/ODTypes.sol";

/// The real protocol wired end to end: ODOracleGuard (Chainlink-shaped feeds, Pyth reference, Stock Tokens and a
/// step calendar are the only mocks, being external), ODVolOracle with a signing key, ODGearRegistry and gear tokens,
/// ODGovernor, ODInsurance, ODFees and ODMinter. USDG is a mock. Markets: TSLA and NVDA (stocks), ETH (24/7).
abstract contract SystemFixture is ODTest {
    bytes32 internal constant TSLA = "TSLA";
    bytes32 internal constant NVDA = "NVDA";
    bytes32 internal constant ETH = "ETH";
    bytes32 internal constant NONE = bytes32(0);
    uint256 internal constant T0 = 1_800_000_000;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");
    address internal volSigner;
    uint256 internal volKey;

    MockUSDG internal usdg;
    MockKindCalendar internal cal;
    MockPyth internal pyth;
    address internal aggImpl;
    ODOracleGuard internal guard;
    ODVolOracle internal vol;
    ODGearRegistry internal reg;
    ODInsurance internal ins;
    ODFees internal fees;
    ODGovernor internal gov;
    ODMinter internal minter;

    mapping(bytes32 => MockAggregator) internal feedOf;
    mapping(bytes32 => MockStockToken) internal stockOf;
    mapping(bytes32 => uint64) internal sigmaOf;
    mapping(bytes32 => uint64) internal nonceOf;
    mapping(bytes32 => uint256) internal postedAt;

    bytes32 internal cruise;
    bytes32 internal sport;
    bytes32 internal race;
    bytes32 internal eco;
    bytes32 internal reverse;
    bytes32 internal ethSport;
    bytes32 internal pair;

    function setUp() public virtual {
        vm.warp(T0);
        (volSigner, volKey) = makeAddrAndKey("volSigner");
        usdg = _newUsdg();
        cal = new MockKindCalendar(Session.OPEN);
        pyth = new MockPyth();
        aggImpl = address(new MockAggregatorImpl());
        guard = new ODOracleGuard(admin, guardian, address(cal), address(pyth), address(0));
        vol = new ODVolOracle(admin, guardian, volSigner);
        reg = new ODGearRegistry(admin, guardian, IODOracleGuard(address(guard)), IODVolOracle(address(vol)));
        ins = new ODInsurance(IERC20(address(usdg)), admin, address(0), address(0));
        // fees needs the Governor address and the Governor needs fees: predict the Governor (next-but-one deploy)
        address govAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        fees = new ODFees(IERC20(address(usdg)), admin, govAt);
        gov = new ODGovernor(
            IERC20(address(usdg)),
            admin,
            guardian,
            IODGearRegistry(address(reg)),
            IODOracleGuard(address(guard)),
            IODInsurance(address(ins)),
            address(fees)
        );
        assertEq(address(gov), govAt, "predicted governor");
        minter = new ODMinter(
            IERC20(address(usdg)),
            admin,
            guardian,
            IODGearRegistry(address(reg)),
            IODOracleGuard(address(guard)),
            IODVolOracle(address(vol)),
            IODGovernor(address(gov)),
            address(fees)
        );

        _market(TSLA, 250e18, false);
        _market(NVDA, 125e18, false);
        _market(ETH, 3000e18, true);
        _postVol(TSLA, 3500);
        _postVol(NVDA, 3500);
        _postVol(ETH, 3500);
        _postVol(vol.pairKey(TSLA, NVDA), 3000);

        address backerAt = _deployBacker();
        vm.startPrank(admin);
        reg.setMinter(address(minter));
        vol.setBounds(TSLA, 500, 4000); // RACE needs a vol ceiling <= 40%
        gov.setMinter(address(minter));
        gov.setBacker(backerAt);
        gov.setHedger(makeAddr("hedgeWallet"));
        gov.setDepositor(lp, true);
        gov.setMarketGroup(ETH, 2);
        ins.setCoverers(address(gov), backerAt);
        fees.setNotifier(address(gov), true);
        fees.setNotifier(backerAt, true);
        vm.stopPrank();

        cruise = _list(TSLA, NONE, Gear.CRUISE);
        sport = _list(TSLA, NONE, Gear.SPORT);
        race = _list(TSLA, NONE, Gear.RACE);
        eco = _list(TSLA, NONE, Gear.ECO);
        reverse = _list(TSLA, NONE, Gear.REVERSE);
        ethSport = _list(ETH, NONE, Gear.SPORT);
        pair = _list(TSLA, NVDA, Gear.SPORT);

        _deposit(lp, _lpDeposit());
        _poke();
    }

    /// The address wired as the Governor's backer. The backer suites override it with a real ODBacker.
    function _deployBacker() internal virtual returns (address) {
        return makeAddr("backer");
    }

    /// The USDG mock; a test may return a variant (e.g. a reentrant one).
    function _newUsdg() internal virtual returns (MockUSDG) {
        return new MockUSDG();
    }

    function _lpDeposit() internal view virtual returns (uint256) {
        return 1_000_000e6;
    }

    // ------------------------------------------------------------------------------------------ markets

    function _market(bytes32 m, uint256 pWad, bool alwaysOpen) internal {
        MockAggregator f = new MockAggregator(8, int256(pWad / 1e10));
        f.setAggregator(aggImpl);
        feedOf[m] = f;
        MarketConfig memory c;
        c.feed = address(f);
        if (!alwaysOpen) {
            MockStockToken t = new MockStockToken();
            stockOf[m] = t;
            c.stockToken = address(t);
        }
        c.multiplierEmbedded = true;
        c.pythMultiplierEmbedded = true;
        c.alwaysOpen = alwaysOpen;
        c.pythId = keccak256(abi.encode("pyth", m));
        c.maxAgeOpen = 26 hours;
        c.maxAgeExtended = 26 hours;
        c.maxAgeClosed = 5 days;
        c.refMaxAge = 1 hours;
        c.twapWindow = 30 minutes;
        c.refBandBps = 200;
        c.continuityBps = 5000;
        c.enabled = true;
        vm.prank(admin);
        guard.setMarket(m, c);
        _ref(m, pWad);
        guard.poke(m);
    }

    /// Feed and reference both at `pWad`; pokes the guard (records last good when live).
    function _price(bytes32 m, uint256 pWad) internal {
        feedOf[m].push(int256(pWad / 1e10));
        _ref(m, pWad);
        guard.poke(m);
    }

    /// Reference (Pyth) only.
    function _ref(bytes32 m, uint256 pWad) internal {
        int64 px = int64(int256(pWad / 1e10));
        pyth.setPrice(
            keccak256(abi.encode("pyth", m)), px, uint64(uint256(int256(px)) / 1000), -8, vm.getBlockTimestamp()
        );
    }

    /// Pyth published too long ago: no reference.
    function _dropRef(bytes32 m) internal {
        pyth.setPublishTime(keccak256(abi.encode("pyth", m)), vm.getBlockTimestamp() - 2 hours);
    }

    function _session(Session s) internal {
        cal.setKind(s);
    }

    function _postVol(bytes32 key, uint64 sigmaBps) internal {
        _postVolWindow(key, sigmaBps, 0, 0);
    }

    function _postVolWindow(bytes32 key, uint64 sigmaBps, uint64 from, uint64 to) internal {
        VolPost memory p = VolPost({
            market: key,
            sigmaBps: sigmaBps,
            buyBlockFrom: from,
            buyBlockTo: to,
            validUntil: uint64(vm.getBlockTimestamp() + 2 hours),
            nonce: ++nonceOf[key]
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(volKey, vol.hashPost(p));
        vol.post(p, abi.encodePacked(r, s, v));
        sigmaOf[key] = sigmaBps;
        postedAt[key] = vm.getBlockTimestamp();
    }

    /// Moves time and keeps every input fresh (feeds, references, vol posts, the Governor's cached equity).
    function _warpFresh(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
        _refreshAll();
    }

    function _refreshAll() internal {
        _price(TSLA, _p(TSLA));
        _price(NVDA, _p(NVDA));
        _price(ETH, _p(ETH));
        _repost(TSLA);
        _repost(NVDA);
        _repost(ETH);
        _repost(vol.pairKey(TSLA, NVDA));
        _poke();
    }

    /// Re-signs the last sigma unless a post landed inside the oracle's minimum interval.
    function _repost(bytes32 key) internal {
        if (vm.getBlockTimestamp() >= postedAt[key] + vol.MIN_POST_INTERVAL()) _postVol(key, sigmaOf[key]);
    }

    function _p(bytes32 m) internal view returns (uint256) {
        (, int256 a,,,) = feedOf[m].latestRoundData();
        return uint256(a) * 1e10;
    }

    // ------------------------------------------------------------------------------------------ protocol

    function _list(bytes32 a, bytes32 b, Gear g) internal returns (bytes32 id) {
        string memory sym = b == NONE
            ? string.concat(_tick(a), reg.suffixOf(g))
            : string.concat(_tick(a), "/", _tick(b), reg.suffixOf(g));
        vm.prank(admin);
        id = reg.listGear(a, b, g, 1e18, 1_000_000e18, 30, sym);
    }

    function _tick(bytes32 m) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && m[n] != 0) ++n;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = m[i];
        }
        return string(out);
    }

    function _token(bytes32 id) internal view returns (IERC20) {
        return IERC20(reg.gear(id).token);
    }

    function _deposit(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(gov), amount);
        gov.deposit(amount, who);
        vm.stopPrank();
    }

    function _poke() internal {
        bytes32[] memory ms = new bytes32[](3);
        ms[0] = TSLA;
        ms[1] = NVDA;
        ms[2] = ETH;
        gov.pokeRisk(ms);
    }

    function _fund(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.prank(who);
        usdg.approve(address(minter), type(uint256).max);
    }

    function _buy(address who, bytes32 id, uint256 usdgIn) internal returns (uint256 tokens) {
        _fund(who, usdgIn);
        vm.prank(who);
        tokens = minter.buy(id, usdgIn, 0, who, uint64(vm.getBlockTimestamp()));
    }

    function _sell(address who, bytes32 id, uint256 tokens) internal returns (uint256 out) {
        vm.prank(who);
        out = minter.sell(id, tokens, 0, who, uint64(vm.getBlockTimestamp()));
    }

    function _quote(bytes32 id, bool isBuy, bool exactIn, uint256 amount) internal view returns (Quote memory) {
        return minter.quote(id, isBuy, exactIn, amount);
    }

    function _setTradeParams(IODMinter.TradeParams memory p) internal {
        vm.prank(admin);
        minter.setTradeParams(p);
    }
}

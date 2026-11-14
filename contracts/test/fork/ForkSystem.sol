// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ODTest} from "../utils/ODTest.sol";
import {SettleFirstRouter} from "./ForkBase.sol";
import {ODOracleGuard} from "overdrive/oracle/ODOracleGuard.sol";
import {ODMarketHours} from "overdrive/oracle/ODMarketHours.sol";
import {ODVolOracle} from "overdrive/oracle/ODVolOracle.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {ODInsurance} from "overdrive/governor/ODInsurance.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {ODBacker} from "overdrive/backer/ODBacker.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODVolOracle, VolPost} from "overdrive/interfaces/IODVolOracle.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODMarketHours, SessionWindow} from "overdrive/interfaces/IODMarketHours.sol";
import {Gear, MarketConfig, PriceReading, Session} from "overdrive/interfaces/ODTypes.sol";

/// The full Overdrive system on a fork of Robinhood Chain mainnet (latest block): REAL USDG, the REAL v4 PoolManager,
/// REAL Chainlink feed proxies, REAL Stock Tokens, REAL v3 TWAP pools and the REAL Pyth Core address (2026-11-13
/// survey, docs feeds.json). Every Overdrive contract is deployed fresh. The launch gear set is listed:
///   ETH, BTC, NVDA, TSLA: CRUISE, SPORT, ECO, REVERSE (RACE refused: vol ceiling above 40%)
///   SPY, QQQ: all five (vol ceiling 4000)
///   pairs (SPORT): NVDA/AMD, QQQ/SPY. COIN/MSTR cannot list: COIN has no usable TWAP and Pyth is stale.
/// Price moves are `vm.mockCall`s on the feed PROXY (latestRoundData) and on Pyth Core (getPriceUnsafe); the system is
/// never told. Pyth on 4663 is 7 days stale, so before the first mock ETH and BTC (no v3 pool) and COIN (pool
/// cardinality 1) read "reference unavailable" while the other stocks read the real v3 TWAP; once a market is mocked
/// its fresh Pyth price stands in for a Pyth push. COIN's Pyth is never mocked. Skips without RHC_RPC_URL.
abstract contract ForkSystem is ODTest {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant RHC_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant PYTH_CORE = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    uint256 internal constant WAD = 1e18;
    uint32 internal constant REF_MAX_AGE = 120;

    bytes32 internal constant ETH = "ETH";
    bytes32 internal constant BTC = "BTC";
    bytes32 internal constant TSLA = "TSLA";
    bytes32 internal constant NVDA = "NVDA";
    bytes32 internal constant SPY = "SPY";
    bytes32 internal constant QQQ = "QQQ";
    bytes32 internal constant AMD = "AMD";
    bytes32 internal constant COIN = "COIN";
    bytes32 internal constant MSTR = "MSTR";
    bytes32 internal constant AAPL = "AAPL";
    bytes32 internal constant MSFT = "MSFT";
    bytes32 internal constant META = "META";
    bytes32 internal constant AMZN = "AMZN";
    bytes32 internal constant PLTR = "PLTR";
    bytes32 internal constant NONE = bytes32(0);

    struct Mkt {
        address token;
        address feed;
        address pool;
        bytes32 pythId;
        uint32 maxAgeInSession;
        uint8 group; // 0 stock, 1 etf, 2 crypto
        uint64 floorBps;
        uint64 ceilingBps;
        uint64 sigmaBps;
    }

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    Vm.Wallet internal volWallet;

    IERC20 internal usdg = IERC20(USDG);
    ODMarketHours internal mh;
    ODOracleGuard internal guard;
    ODVolOracle internal vol;
    ODGearRegistry internal reg;
    ODInsurance internal ins;
    ODFees internal fees;
    ODGovernor internal gov;
    ODMinter internal minter;
    ODBacker internal backer;
    ODHook internal hook;
    SettleFirstRouter internal router;

    bytes32[] internal allMarkets;
    bytes32[] internal riskMarkets; // markets with listed gears
    bytes32[] internal allGears;
    mapping(bytes32 => Mkt) internal mk;
    mapping(bytes32 => uint256) internal px; // per-token price (WAD) the system sees, 8-dp precision
    mapping(bytes32 => uint256) internal multOf; // effective uiMultiplier the mocks assume
    mapping(bytes32 => bool) internal feedNotEmbedded; // feed prices one share (split tests)
    mapping(bytes32 => bool) internal noPyth; // never mock Pyth (COIN)
    mapping(bytes32 => uint80) internal roundOf;
    mapping(bytes32 => uint64) internal nonceOf;
    mapping(bytes32 => uint64) internal sigmaOf;
    mapping(bytes32 => uint256) internal postedAt;
    mapping(bytes32 => mapping(Gear => bytes32)) internal gearOf;
    bytes32 internal nvdaAmd;
    bytes32 internal qqqSpy;

    function setUp() public virtual {
        if (bytes(vm.envOr("RHC_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        _forkShared();
        require(RHC_POOL_MANAGER.code.length > 0 && USDG.code.length > 0, "not the RHC fork");
        volWallet = vm.createWallet("overdrive-test-vol-signer");
        _addMarkets();
        _deploySystem();
        _configureMarkets();
        _mockAll();
        _postVols();
        _listLaunchSet();
        _seedGovernor(_seedUsdg());
        _poke();
    }

    /// Forks a recent block rounded down to a multiple of 500 (about 90 s), so every test of a run shares one fork
    /// backend and its RPC cache instead of each fetching `latest` again (the public RPC rate-limits at 429).
    function _forkShared() internal {
        string memory url = vm.envString("RHC_RPC_URL");
        bytes memory raw = vm.rpc(url, "eth_blockNumber", "[]");
        uint256 latest;
        for (uint256 i; i < raw.length; ++i) {
            latest = (latest << 8) | uint8(raw[i]);
        }
        vm.createSelectFork(url, latest - latest % 500);
    }

    function _seedUsdg() internal view virtual returns (uint256) {
        return 2_000_000e6;
    }

    /// Lists the launch gear set; a suite may list fewer (the gas sweep lists its own).
    function _listLaunchSet() internal virtual {
        Gear[4] memory four = [Gear.CRUISE, Gear.SPORT, Gear.ECO, Gear.REVERSE];
        bytes32[4] memory names = [ETH, BTC, NVDA, TSLA];
        for (uint256 i; i < names.length; ++i) {
            for (uint256 j; j < 4; ++j) {
                _listOne(names[i], NONE, four[j]);
            }
        }
        for (uint256 g; g < 5; ++g) {
            _listOne(SPY, NONE, Gear(g));
            _listOne(QQQ, NONE, Gear(g));
        }
        nvdaAmd = _listOne(NVDA, AMD, Gear.SPORT);
        qqqSpy = _listOne(QQQ, SPY, Gear.SPORT);
    }

    // ------------------------------------------------------------------------------------------------ markets

    function _add(
        bytes32 id,
        address token,
        address feed,
        address pool,
        bytes32 pythId,
        uint32 inSession,
        uint8 group,
        uint64 floor_,
        uint64 ceiling,
        uint64 sigma
    ) internal {
        mk[id] = Mkt(token, feed, pool, pythId, inSession, group, floor_, ceiling, sigma);
        allMarkets.push(id);
    }

    /// Addresses from docs feeds.json (2026-11-13 survey); in-session age bounds as OracleFork.
    function _addMarkets() internal {
        // forgefmt: disable-start
        _add(ETH, address(0), 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9, address(0), 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace, 284400, 2, 3000, 20000, 6000); // not-a-key: Pyth price id
        _add(BTC, address(0), 0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251, address(0), 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43, 111600, 2, 3000, 20000, 5000); // not-a-key: Pyth price id
        _add(TSLA, 0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 0x4A1166a659A55625345e9515b32adECea5547C38, 0xf4ACdAEEB7022862A763C9B1B885e11191c889E3, 0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1, 93600, 0, 2000, 15000, 5000); // not-a-key: Pyth price id
        _add(NVDA, 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15, 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3, 0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593, 93600, 0, 2000, 15000, 4500); // not-a-key: Pyth price id
        _add(SPY, 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 0x319724394D3A0e3669269846abE664Cd621f9f6A, 0xa7Bb1AC63BBaB0C44316E6c8C455213441689167, 0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5, 367200, 1, 1500, 4000, 1800); // not-a-key: Pyth price id
        _add(QQQ, 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 0x80901d846d5D7B030F26B480776EE3b29374C2ae, 0xD60A5d14dB690B7Afad71F76B108071D7175597d, 0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d, 414000, 1, 1500, 4000, 2200); // not-a-key: Pyth price id
        _add(AMD, 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, 0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72, 0x48D284A2A4d3DC1b3Da08231Fe44317e7e7Aa51f, 0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e, 104400, 0, 2000, 15000, 5000); // not-a-key: Pyth price id
        _add(COIN, 0x6330D8C3178a418788dF01a47479c0ce7CCF450b, 0xA3a468A452940B7D6b69991207B508c609a98Ef2, 0x3a6eC0aa6C702323414d449B5F60f4B742A82dED, 0xfee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245, 93600, 0, 3000, 20000, 7000); // not-a-key: Pyth price id
        _add(MSTR, 0xec262a75e413fAfD0dF80480274532C79D42da09, 0x396118bdFB181e6240E74D243F266B061c0edc3D, 0x17578C0e0D15da44f31677263114F71aE76653EA, 0xe1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09, 93600, 0, 3000, 20000, 7000); // not-a-key: Pyth price id
        _add(AAPL, 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0, 0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D, 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688, 345600, 0, 2000, 15000, 3000); // not-a-key: Pyth price id
        _add(MSFT, 0xe93237C50D904957Cf27E7B1133b510C669c2e74, 0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E, 0xeb60bCD1D920ad6E102690CCFC6fB488899E1510, 0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1, 363600, 0, 2000, 15000, 3000); // not-a-key: Pyth price id
        _add(META, 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, 0x7C38C00C30BEe9378381E7B6135d7283356D71b1, 0x107a7Cb40d8665360ba10E59471Af06150A50922, 0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe, 108000, 0, 2000, 15000, 3500); // not-a-key: Pyth price id
        _add(AMZN, 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C, 0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef, 0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a, 345600, 0, 2000, 15000, 3500); // not-a-key: Pyth price id
        _add(PLTR, 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A, 0x820ABedFF239034956B7A9d2F0a331f9F075eB4c, 0x851680416A4f4E1c463d45171d61ACDdBc8554c0, 0x11a70634863ddffb71f2b11f2cff29f73f3db8f6d0b78c49f2b5f4ad36e885f0, 93600, 0, 3000, 20000, 6000); // not-a-key: Pyth price id
        // forgefmt: disable-end
        noPyth[COIN] = true;
    }

    function _deploySystem() internal {
        mh = new ODMarketHours(admin, keeper);
        _openSessionAroundNow();
        guard = new ODOracleGuard(admin, guardian, address(mh), PYTH_CORE, address(0));
        vol = new ODVolOracle(admin, guardian, volWallet.addr);
        reg = new ODGearRegistry(admin, guardian, IODOracleGuard(address(guard)), IODVolOracle(address(vol)));
        ins = new ODInsurance(usdg, admin, address(0), address(0));
        address govAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        fees = new ODFees(usdg, admin, govAt);
        gov = new ODGovernor(
            usdg,
            admin,
            guardian,
            IODGearRegistry(address(reg)),
            IODOracleGuard(address(guard)),
            IODInsurance(address(ins)),
            address(fees)
        );
        require(address(gov) == govAt, "predicted governor");
        minter = new ODMinter(
            usdg,
            admin,
            guardian,
            IODGearRegistry(address(reg)),
            IODOracleGuard(address(guard)),
            IODVolOracle(address(vol)),
            IODGovernor(address(gov)),
            address(fees)
        );
        backer = new ODBacker(
            usdg,
            admin,
            guardian,
            IODGearRegistry(address(reg)),
            IODMinter(address(minter)),
            IODGovernor(address(gov)),
            IODOracleGuard(address(guard)),
            IODMarketHours(address(mh)),
            IODInsurance(address(ins)),
            address(fees)
        );
        bytes memory code = abi.encodePacked(
            type(ODHook).creationCode, abi.encode(RHC_POOL_MANAGER, address(minter), address(reg), address(usdg), admin)
        );
        (address predicted, bytes32 salt) = ODHookMiner.find(address(this), code);
        hook = new ODHook{salt: salt}(
            IPoolManager(RHC_POOL_MANAGER), IODMinter(address(minter)), IODGearRegistry(address(reg)), usdg, admin
        );
        require(address(hook) == predicted, "mined hook");
        router = new SettleFirstRouter(IPoolManager(RHC_POOL_MANAGER));

        vm.startPrank(admin);
        reg.setMinter(address(minter));
        gov.setMinter(address(minter));
        gov.setBacker(address(backer));
        gov.setHedger(makeAddr("hedgeWallet"));
        gov.setDepositor(lp, true);
        ins.setCoverers(address(gov), address(backer));
        fees.setNotifier(address(gov), true);
        fees.setNotifier(address(backer), true);
        minter.setHook(address(hook));
        vm.stopPrank();
    }

    /// One OPEN window from 1 h ago for almost 7 days: every stock reads in session whatever the fork's day. Since L-9
    /// the keeper cannot push a window over calendar-closed time, so this mechanics harness writes the window straight
    /// into ODMarketHours storage (test only, a forced calendar like SystemFixture's mock). Suites that test the real
    /// calendar (WeekendFork) clear it through the keeper and enable the fallback.
    function _openSessionAroundNow() internal {
        uint256 open = vm.getBlockTimestamp() - 1 hours;
        uint256 close = vm.getBlockTimestamp() + 7 days - 2 hours;
        // ODMarketHours layout: slot 0 AccessControl._roles, slot 1 _sessions, slot 2 _kinds (Session.OPEN is 0).
        vm.store(address(mh), bytes32(uint256(1)), bytes32(uint256(1)));
        vm.store(address(mh), keccak256(abi.encode(uint256(1))), bytes32(open | (close << 64)));
        vm.store(address(mh), bytes32(uint256(2)), bytes32(uint256(1)));
        SessionWindow[] memory w = mh.sessions();
        require(w.length == 1 && w[0].open == open && w[0].close == close, "ForkSystem: ODMarketHours layout moved");
        require(mh.kindAt(vm.getBlockTimestamp()) == Session.OPEN, "ForkSystem: forced window not read");
    }

    function _configureMarkets() internal {
        vm.startPrank(admin);
        for (uint256 i; i < allMarkets.length; ++i) {
            bytes32 m = allMarkets[i];
            guard.setMarket(m, _cfg(m));
            vol.setBounds(m, mk[m].floorBps, mk[m].ceilingBps);
            gov.setMarketGroup(m, mk[m].group);
        }
        vm.stopPrank();
    }

    function _cfg(bytes32 m) internal view returns (MarketConfig memory c) {
        Mkt memory x = mk[m];
        c.feed = x.feed;
        c.stockToken = x.token;
        c.multiplierEmbedded = !feedNotEmbedded[m]; // Robinhood docs: feed = share price x multiplier
        c.pythMultiplierEmbedded = false; // Pyth equity prices one share
        c.alwaysOpen = x.token == address(0);
        c.pythId = x.pythId;
        c.twapPool = x.pool;
        c.maxAgeOpen = x.maxAgeInSession;
        c.maxAgeExtended = x.maxAgeInSession;
        c.maxAgeClosed = 432000;
        c.refMaxAge = REF_MAX_AGE;
        c.twapWindow = 30 minutes;
        c.refBandBps = 200;
        c.continuityBps = 1500;
        c.enabled = true;
    }

    // ------------------------------------------------------------------------------------------------ mocks

    /// Starts every market at its REAL latest feed answer (multiplier as the token reports it) and mocks from here on.
    function _mockAll() internal {
        for (uint256 i; i < allMarkets.length; ++i) {
            bytes32 m = allMarkets[i];
            (uint80 rid, int256 a,,,) = IFeed(mk[m].feed).latestRoundData();
            roundOf[m] = rid;
            multOf[m] = mk[m].token == address(0) ? WAD : IStock(mk[m].token).uiMultiplier();
            _setPx(m, uint256(a) * 1e10);
            guard.poke(m);
        }
    }

    /// Feed (and Pyth unless excluded) at per-token price `pWad`, published now. Does not poke.
    function _setPx(bytes32 m, uint256 pWad) internal {
        pWad = pWad / 1e10 * 1e10;
        px[m] = pWad;
        uint256 mult = multOf[m];
        uint256 feedAns = feedNotEmbedded[m] ? pWad * WAD / mult / 1e10 : pWad / 1e10;
        _mockFeed(m, feedAns, vm.getBlockTimestamp());
        if (!noPyth[m]) {
            int64 perShare = int64(int256(pWad * WAD / mult / 1e10));
            _mockPyth(m, perShare, vm.getBlockTimestamp());
        }
    }

    function _mockFeed(bytes32 m, uint256 answer8, uint256 updatedAt) internal {
        uint80 rid = ++roundOf[m];
        vm.mockCall(
            mk[m].feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(rid, int256(answer8), updatedAt, updatedAt, rid)
        );
    }

    function _mockPyth(bytes32 m, int64 price8, uint256 publishTime) internal {
        vm.mockCall(
            PYTH_CORE,
            abi.encodeWithSignature("getPriceUnsafe(bytes32)", mk[m].pythId),
            abi.encode(price8, uint64(uint256(int256(price8)) / 1000), int32(-8), publishTime)
        );
    }

    /// Mocks a pending multiplier change on a Stock Token (ERC-8056 fields the guard reads).
    function _mockSplit(bytes32 m, uint256 current, uint256 pending, uint256 effectiveAt) internal {
        address t = mk[m].token;
        vm.mockCall(t, abi.encodeWithSignature("uiMultiplier()"), abi.encode(current));
        vm.mockCall(t, abi.encodeWithSignature("newUIMultiplier()"), abi.encode(pending));
        vm.mockCall(t, abi.encodeWithSignature("effectiveAt()"), abi.encode(effectiveAt));
    }

    /// Moves `market` by `moveBps` (signed) in steps of at most 10% so the continuity check (15%) never latches; pokes
    /// the guard after each step. Feed proxy and Pyth move together.
    function walkPrice(bytes32 market, int256 moveBps) internal {
        uint256 target = uint256(int256(px[market]) * (10_000 + moveBps) / 10_000);
        while (px[market] != target) {
            uint256 cur = px[market];
            uint256 next;
            if (target > cur) next = cur * 11 / 10 < target ? cur * 11 / 10 : target;
            else next = cur * 9 / 10 > target ? cur * 9 / 10 : target;
            _setPx(market, next);
            if (px[market] == cur) break; // 8-dp floor reached
            target = target / 1e10 * 1e10;
            guard.poke(market);
        }
    }

    function postVol(bytes32 key, uint64 sigmaBps) internal {
        VolPost memory p = VolPost({
            market: key,
            sigmaBps: sigmaBps,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(vm.getBlockTimestamp() + 2 hours),
            nonce: ++nonceOf[key]
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(volWallet.privateKey, vol.hashPost(p));
        vol.post(p, abi.encodePacked(r, s, v));
        sigmaOf[key] = sigmaBps;
        postedAt[key] = vm.getBlockTimestamp();
    }

    function _postVols() internal {
        for (uint256 i; i < allMarkets.length; ++i) {
            postVol(allMarkets[i], mk[allMarkets[i]].sigmaBps);
        }
        postVol(vol.pairKey(NVDA, AMD), 3500);
        postVol(vol.pairKey(QQQ, SPY), 1500);
        postVol(vol.pairKey(COIN, MSTR), 5000);
    }

    function _repost(bytes32 key) internal {
        if (sigmaOf[key] != 0 && vm.getBlockTimestamp() >= postedAt[key] + vol.MIN_POST_INTERVAL()) {
            postVol(key, sigmaOf[key]);
        }
    }

    /// Keeps every input fresh at the current prices (a new round per feed, Pyth, vol posts, the Governor's equity).
    function _refresh() internal {
        for (uint256 i; i < allMarkets.length; ++i) {
            bytes32 m = allMarkets[i];
            _setPx(m, px[m]);
            guard.poke(m);
            _repost(m);
        }
        _repost(vol.pairKey(NVDA, AMD));
        _repost(vol.pairKey(QQQ, SPY));
        _poke();
    }

    /// Re-applies every price mock at `px` (mocks survive vm.revertToState; storage does not) and pokes the guard.
    function _remock() internal {
        for (uint256 i; i < allMarkets.length; ++i) {
            _setPx(allMarkets[i], px[allMarkets[i]]);
            guard.poke(allMarkets[i]);
        }
    }

    /// Value per token with the NF divided out (the toll removed), for "value unchanged" checks across time.
    function _valueExToll(bytes32 id) internal view returns (uint256) {
        (uint256 v,) = minter.valuePerToken(id);
        return v * WAD / minter.normState(id).nf;
    }

    function _warpFresh(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
        _refresh();
    }

    /// The crank: hourly `accrueMany` over every listed gear for `hours_` hours, inputs refreshed each hour.
    function _crank(uint256 hours_) internal {
        for (uint256 h; h < hours_; ++h) {
            _warpFresh(1 hours);
            minter.accrueMany(allGears);
        }
    }

    function _poke() internal {
        if (riskMarkets.length != 0) gov.pokeRisk(riskMarkets);
    }

    // ------------------------------------------------------------------------------------------------ protocol

    function _listOne(bytes32 a, bytes32 b, Gear g) internal returns (bytes32 id) {
        string memory sym = b == NONE
            ? string.concat(_tick(a), reg.suffixOf(g))
            : string.concat(_tick(a), "/", _tick(b), reg.suffixOf(g));
        vm.startPrank(admin);
        id = reg.listGear(a, b, g, 1e18, 1_000_000e18, 30, sym);
        hook.initializeGearPool(id);
        vm.stopPrank();
        allGears.push(id);
        if (b == NONE) gearOf[a][g] = id;
        _riskMarket(a);
        if (b != NONE) _riskMarket(b);
    }

    function _riskMarket(bytes32 m) internal {
        for (uint256 i; i < riskMarkets.length; ++i) {
            if (riskMarkets[i] == m) return;
        }
        riskMarkets.push(m);
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

    /// Real USDG to `who` through the balances slot (forge `deal`).
    function _fundUsdg(address who, uint256 amount) internal {
        deal(USDG, who, usdg.balanceOf(who) + amount);
    }

    /// Seeds the Governor through `deposit` (never a transfer) and funds the exit reserve from free cash.
    function _seedGovernor(uint256 amount) internal {
        if (amount == 0) return;
        _fundUsdg(lp, amount);
        vm.startPrank(lp);
        usdg.approve(address(gov), amount);
        gov.deposit(amount, lp);
        vm.stopPrank();
        vm.prank(admin);
        gov.moveToExitReserve(amount / 20);
    }

    function _keyParams(bytes32 id, bool isBuy, uint256 amount)
        internal
        view
        returns (PoolKey memory key, IPoolManager.SwapParams memory p)
    {
        key = hook.poolKeyOf(id);
        bool usdgIs0 = Currency.unwrap(key.currency0) == USDG;
        p.zeroForOne = isBuy == usdgIs0;
        p.amountSpecified = -int256(amount);
        p.sqrtPriceLimitX96 = p.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    /// Buy through the hook on the real PoolManager (settle-first router, exact in); returns tokens received.
    function _hookBuy(address who, bytes32 id, uint256 usdgIn) internal returns (uint256 got) {
        _fundUsdg(who, usdgIn);
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _keyParams(id, true, usdgIn);
        IERC20 t = _token(id);
        uint256 b0 = t.balanceOf(who);
        vm.startPrank(who);
        usdg.approve(address(router), usdgIn);
        router.swapExactIn(key, p);
        vm.stopPrank();
        got = t.balanceOf(who) - b0;
    }

    /// Sell through the hook (exact tokens in); returns USDG received.
    function _hookSell(address who, bytes32 id, uint256 tokens) internal returns (uint256 got) {
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _keyParams(id, false, tokens);
        uint256 b0 = usdg.balanceOf(who);
        vm.startPrank(who);
        _token(id).approve(address(router), tokens);
        router.swapExactIn(key, p);
        vm.stopPrank();
        got = usdg.balanceOf(who) - b0;
    }

    /// Direct minter buy / sell (queues and settled paths).
    function _buy(address who, bytes32 id, uint256 usdgIn) internal returns (uint256 tokens) {
        _fundUsdg(who, usdgIn);
        vm.startPrank(who);
        usdg.approve(address(minter), usdgIn);
        tokens = minter.buy(id, usdgIn, 0, who, uint64(vm.getBlockTimestamp()));
        vm.stopPrank();
    }

    function _sell(address who, bytes32 id, uint256 tokens) internal returns (uint256 out) {
        vm.prank(who);
        out = minter.sell(id, tokens, 0, who, uint64(vm.getBlockTimestamp()));
    }

    function _read(bytes32 m) internal view returns (PriceReading memory) {
        return guard.read(m);
    }
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IStock {
    function uiMultiplier() external view returns (uint256);
}

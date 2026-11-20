// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODScript} from "./ODScript.sol";
import {Gear, MarketConfig} from "overdrive/interfaces/ODTypes.sol";
import {Holiday} from "overdrive/interfaces/IODMarketHours.sol";

/// @title SystemConfig
/// @notice Reads `script/config/<network>.json` (or the raw JSON in `OD_CONFIG_JSON`, or the path in `OD_CONFIG`). A
/// role or required external left at the zero address is a placeholder: the loader refuses it, so the deploy cannot run
/// until the owner fills the file. `external.ovrd` is the exception: at zero (with `dev.ovrd` false) the system deploys
/// without ODStake and the stake follows in phase 2 (DeployStake.s.sol). Gear count is held under the registry cap
/// (MAX_GEARS 32, 12 per market).
abstract contract SystemConfig is ODScript {
    uint256 internal constant MIN_DELAY = 172800;
    uint256 internal constant MAX_GEARS = 32;
    uint256 internal constant MAX_GEARS_PER_MARKET = 12;
    uint256 internal constant MAX_MIN_EXIT_RESERVE = 1_000_000e6;

    struct Roles {
        address ownerSafe;
        address guardianSafe;
        address keeper;
        address hedger;
        address volSigner;
        address paymasterSigner;
        address treasury;
    }

    struct Externals {
        address usdg;
        address poolManager;
        address stateView;
        address v4Quoter;
        address pythCore;
        address permit2;
        address entryPoint;
        address v3Factory;
        address createX;
        address ovrd;
    }

    struct Dev {
        bool usdg; // deploy a mintable test USDG (never on 4663)
        bool ovrd; // deploy a test OVRD for ODStake (never on 4663)
        bool poolManager; // deploy a v4 PoolManager (plain anvil only)
    }

    struct MarketCfg {
        bytes32 id;
        string symbol;
        bool crypto;
        uint8 group;
        uint64 volFloorBps;
        uint64 volCeilingBps;
        MarketConfig cfg;
    }

    struct GearCfg {
        bytes32 marketA;
        bytes32 marketB;
        Gear gear;
        uint128 capUsdWad;
        uint16 spreadBps;
        uint128 unitWad;
    }

    struct PaymasterCfg {
        uint256 maxCostPerOp;
        uint256 accountDailyCap;
        uint256 globalDailyCap;
    }

    struct Config {
        string network;
        uint256 chainId;
        uint256 minDelay;
        Roles roles;
        Externals ext;
        Dev dev;
        PaymasterCfg paymaster;
        uint256 seedUsdgPerGear;
        uint256 seedGearWadPerGear;
        bool seedApproved;
        /// D-tiny-reserve: the Governor's minExitReserveUsdg the ListGears batch sets (6 decimals); 0 = the config sets
        /// no figure and the batch leaves the Governor's params alone.
        uint256 minExitReserveUsdg;
        MarketCfg[] markets;
        GearCfg[] gears;
        /// R8-1: NYSE full and early closes written to ODMarketHours at deploy (ascending by Eastern day).
        Holiday[] holidays;
    }

    error ConfigRefused(string why);

    function _configJson(string memory network) internal view returns (string memory json) {
        json = vm.envOr("OD_CONFIG_JSON", string(""));
        if (bytes(json).length != 0) return json;
        string memory path = vm.envOr("OD_CONFIG", string(""));
        if (bytes(path).length == 0) path = string.concat(vm.projectRoot(), "/script/config/", network, ".json");
        json = vm.readFile(path);
    }

    function loadConfig(string memory network) internal view returns (Config memory c) {
        c = parseConfig(_configJson(network));
    }

    function parseConfig(string memory j) public view returns (Config memory c) {
        c.network = vm.parseJsonString(j, ".network");
        c.chainId = vm.parseJsonUint(j, ".chainId");
        c.minDelay = vm.parseJsonUint(j, ".minDelaySec");
        c.roles = Roles({
            ownerSafe: vm.parseJsonAddress(j, ".roles.ownerSafe"),
            guardianSafe: vm.parseJsonAddress(j, ".roles.guardianSafe"),
            keeper: vm.parseJsonAddress(j, ".roles.keeper"),
            hedger: vm.parseJsonAddress(j, ".roles.hedger"),
            volSigner: vm.parseJsonAddress(j, ".roles.volSigner"),
            paymasterSigner: vm.parseJsonAddress(j, ".roles.paymasterSigner"),
            treasury: vm.parseJsonAddress(j, ".roles.treasury")
        });
        c.ext = Externals({
            usdg: vm.parseJsonAddress(j, ".external.usdg"),
            poolManager: vm.parseJsonAddress(j, ".external.poolManager"),
            stateView: vm.parseJsonAddress(j, ".external.stateView"),
            v4Quoter: vm.parseJsonAddress(j, ".external.v4Quoter"),
            pythCore: vm.parseJsonAddress(j, ".external.pythCore"),
            permit2: vm.parseJsonAddress(j, ".external.permit2"),
            entryPoint: vm.parseJsonAddress(j, ".external.entryPoint"),
            v3Factory: vm.parseJsonAddress(j, ".external.v3Factory"),
            createX: vm.parseJsonAddress(j, ".external.createX"),
            ovrd: vm.parseJsonAddress(j, ".external.ovrd")
        });
        c.dev = Dev({
            usdg: vm.parseJsonBool(j, ".dev.usdg"),
            ovrd: vm.parseJsonBool(j, ".dev.ovrd"),
            poolManager: vm.parseJsonBool(j, ".dev.poolManager")
        });
        c.paymaster = PaymasterCfg({
            maxCostPerOp: vm.parseUint(vm.parseJsonString(j, ".paymaster.maxCostPerOpWei")),
            accountDailyCap: vm.parseUint(vm.parseJsonString(j, ".paymaster.accountDailyCapWei")),
            globalDailyCap: vm.parseUint(vm.parseJsonString(j, ".paymaster.globalDailyCapWei"))
        });
        c.seedUsdgPerGear = vm.parseUint(vm.parseJsonString(j, ".hookSeed.usdgPerGear"));
        c.seedGearWadPerGear = vm.parseUint(vm.parseJsonString(j, ".hookSeed.gearWadPerGear"));
        c.seedApproved = vm.parseJsonBool(j, ".hookSeed.approvedByOwner");
        if (vm.keyExistsJson(j, ".governorParams.minExitReserveUsdg")) {
            c.minExitReserveUsdg = vm.parseUint(vm.parseJsonString(j, ".governorParams.minExitReserveUsdg"));
            if (c.minExitReserveUsdg == 0) revert ConfigRefused("governorParams.minExitReserveUsdg is zero");
        }
        c.markets = _markets(j);
        c.gears = _gears(j);
        c.holidays = _holidays(j);
    }

    /// `.holidays[i]` = { date (for the reader), day (days since 1970-01-01, Eastern date), closeMinute (0 = closed
    /// all day, else the early close as a minute of the Eastern day) }.
    function _holidays(string memory j) private view returns (Holiday[] memory hs) {
        uint256 n;
        while (vm.keyExistsJson(j, string.concat(".holidays[", vm.toString(n), "]"))) ++n;
        hs = new Holiday[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".holidays[", vm.toString(i), "]");
            hs[i] = Holiday({
                day: uint32(vm.parseJsonUint(j, string.concat(k, ".day"))),
                closeMinute: uint16(vm.parseJsonUint(j, string.concat(k, ".closeMinute")))
            });
        }
    }

    function _markets(string memory j) private view returns (MarketCfg[] memory ms) {
        uint256 n;
        while (vm.keyExistsJson(j, string.concat(".markets[", vm.toString(n), "]"))) ++n;
        ms = new MarketCfg[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".markets[", vm.toString(i), "]");
            MarketCfg memory m;
            m.symbol = vm.parseJsonString(j, string.concat(k, ".symbol"));
            m.id = bytes32(bytes(m.symbol));
            m.crypto = keccak256(bytes(vm.parseJsonString(j, string.concat(k, ".kind")))) == keccak256("crypto");
            m.group = uint8(vm.parseJsonUint(j, string.concat(k, ".group")));
            m.volFloorBps = uint64(vm.parseJsonUint(j, string.concat(k, ".volFloorBps")));
            m.volCeilingBps = uint64(vm.parseJsonUint(j, string.concat(k, ".volCeilingBps")));
            MarketConfig memory c;
            c.feed = vm.parseJsonAddress(j, string.concat(k, ".feed"));
            c.stockToken = vm.parseJsonAddress(j, string.concat(k, ".stockAsset"));
            c.multiplierEmbedded = vm.parseJsonBool(j, string.concat(k, ".multiplierEmbedded"));
            c.pythMultiplierEmbedded = vm.parseJsonBool(j, string.concat(k, ".pythMultiplierEmbedded"));
            c.alwaysOpen = m.crypto;
            // stored without 0x so the file holds no bare 32-byte hex (the public guard reads those as keys)
            c.pythId = vm.parseBytes32(string.concat("0x", vm.parseJsonString(j, string.concat(k, ".pythId"))));
            c.twapPool = vm.parseJsonAddress(j, string.concat(k, ".twapPool"));
            uint32 inSession = uint32(vm.parseJsonUint(j, string.concat(k, ".maxAgeInSession")));
            c.maxAgeOpen = inSession;
            c.maxAgeExtended = inSession;
            c.maxAgeClosed = uint32(vm.parseJsonUint(j, string.concat(k, ".maxAgeClosed")));
            c.refMaxAge = uint32(vm.parseJsonUint(j, string.concat(k, ".refMaxAge")));
            c.twapWindow = uint32(vm.parseJsonUint(j, string.concat(k, ".twapWindow")));
            c.refBandBps = uint16(vm.parseJsonUint(j, string.concat(k, ".refBandBps")));
            c.continuityBps = uint16(vm.parseJsonUint(j, string.concat(k, ".continuityBps")));
            c.enabled = true;
            m.cfg = c;
            ms[i] = m;
        }
    }

    function _gears(string memory j) private view returns (GearCfg[] memory gs) {
        uint256 n;
        while (vm.keyExistsJson(j, string.concat(".gears[", vm.toString(n), "]"))) ++n;
        gs = new GearCfg[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".gears[", vm.toString(i), "]");
            GearCfg memory g;
            g.marketA = bytes32(bytes(vm.parseJsonString(j, string.concat(k, ".marketA"))));
            g.marketB = bytes32(bytes(vm.parseJsonString(j, string.concat(k, ".marketB"))));
            g.gear = gearOf(vm.parseJsonString(j, string.concat(k, ".gear")));
            g.capUsdWad = uint128(vm.parseJsonUint(j, string.concat(k, ".capUsd")) * 1e18);
            g.spreadBps = uint16(vm.parseJsonUint(j, string.concat(k, ".spreadBps")));
            g.unitWad = uint128(vm.parseJsonUint(j, string.concat(k, ".unitUsd")) * 1e18);
            gs[i] = g;
        }
    }

    function gearOf(string memory s) internal pure returns (Gear) {
        bytes32 h = keccak256(bytes(s));
        if (h == keccak256("CRUISE")) return Gear.CRUISE;
        if (h == keccak256("SPORT")) return Gear.SPORT;
        if (h == keccak256("RACE")) return Gear.RACE;
        if (h == keccak256("ECO")) return Gear.ECO;
        if (h == keccak256("REVERSE")) return Gear.REVERSE;
        revert ConfigRefused("unknown gear");
    }

    function gearName(Gear g) internal pure returns (string memory) {
        string[5] memory n = ["CRUISE", "SPORT", "RACE", "ECO", "REVERSE"];
        return n[uint8(g)];
    }

    function gearSuffix(Gear g) internal pure returns (string memory) {
        string[5] memory n = ["CRUISE", "SPORT", "RACE", "ECO", "REVERSE"];
        return string.concat(" ", n[uint8(g)]);
    }

    function symbolOf(bytes32 m) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && m[n] != 0) ++n;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = m[i];
        }
        return string(out);
    }

    /// True when the config names no $OVRD (no address yet, no test token): the system deploys without ODStake (phase
    /// 1) and DeployStake adds it once the token exists (phase 2, one timelock batch wires it).
    function stakeLater(Config memory c) public pure returns (bool) {
        return !c.dev.ovrd && c.ext.ovrd == address(0);
    }

    /// Refuses a config that still holds a placeholder, uses a test token on mainnet, breaks the gear caps or names a
    /// chain other than the RPC's (a fork accepts 4663 and anvil's 31337).
    function validateConfig(Config memory c) public view {
        bool fork = keccak256(bytes(c.network)) == keccak256("fork");
        bool anvil = keccak256(bytes(c.network)) == keccak256("anvil");
        if (!fork && !anvil && c.chainId != block.chainid) revert ConfigRefused("chain id differs from the RPC");
        if (fork && block.chainid != CHAIN_MAINNET && block.chainid != 31337) revert ConfigRefused("fork chain id");
        if (block.chainid == CHAIN_MAINNET && !fork && (c.dev.usdg || c.dev.ovrd || c.dev.poolManager)) {
            revert ConfigRefused("test tokens on mainnet");
        }
        if (c.dev.poolManager && !anvil) revert ConfigRefused("dev PoolManager outside anvil");
        if (c.minDelay != MIN_DELAY) revert ConfigRefused("timelock delay must be 172800");
        Roles memory r = c.roles;
        if (
            r.ownerSafe == address(0) || r.guardianSafe == address(0) || r.keeper == address(0)
                || r.hedger == address(0) || r.volSigner == address(0) || r.paymasterSigner == address(0)
                || r.treasury == address(0)
        ) revert ConfigRefused("placeholder role address");
        if (r.guardianSafe == r.ownerSafe || r.guardianSafe == r.keeper || r.guardianSafe == r.hedger) {
            revert ConfigRefused("guardian must differ from the owner Safe and the bots");
        }
        if (r.keeper == r.ownerSafe || r.hedger == r.ownerSafe) revert ConfigRefused("a bot is the owner Safe");
        if (!c.dev.usdg && c.ext.usdg == address(0)) revert ConfigRefused("placeholder usdg");
        if (!c.dev.poolManager && c.ext.poolManager == address(0)) revert ConfigRefused("placeholder poolManager");
        if (c.ext.entryPoint == address(0)) revert ConfigRefused("placeholder entryPoint");
        if (_isRealChain(c.chainId) && c.ext.createX == address(0)) revert ConfigRefused("placeholder createX");
        if (c.markets.length != 0 && c.ext.pythCore == address(0)) revert ConfigRefused("placeholder pythCore");
        if (c.gears.length > MAX_GEARS) revert ConfigRefused("more gears than MAX_GEARS");
        // D-tiny-reserve: a set figure is a whole USDG amount between 1 and 1,000,000 USDG (fits the uint64 field).
        if (
            c.minExitReserveUsdg != 0
                && (c.minExitReserveUsdg % 1e6 != 0 || c.minExitReserveUsdg > MAX_MIN_EXIT_RESERVE)
        ) {
            revert ConfigRefused("governorParams.minExitReserveUsdg out of range");
        }
        // R8-1: the calendar must know the holidays from the first block. The list must reach past today (a list
        // that ended in the past would read the next holiday as a trading day).
        uint256 nh = c.holidays.length;
        if (nh == 0 || nh > 64) revert ConfigRefused("holiday list empty or over 64");
        for (uint256 i = 1; i < nh; ++i) {
            if (c.holidays[i].day <= c.holidays[i - 1].day) revert ConfigRefused("holidays not ascending");
        }
        if (uint256(c.holidays[nh - 1].day) * 1 days <= block.timestamp) {
            revert ConfigRefused("holiday list is in the past");
        }
        for (uint256 i; i < c.markets.length; ++i) {
            uint256 per;
            for (uint256 k; k < c.gears.length; ++k) {
                if (c.gears[k].marketA == c.markets[i].id || c.gears[k].marketB == c.markets[i].id) ++per;
            }
            if (per > MAX_GEARS_PER_MARKET) revert ConfigRefused("more than 12 gears on one market");
        }
    }
}

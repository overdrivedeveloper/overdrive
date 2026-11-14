// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IODGearRegistry} from "../interfaces/IODGearRegistry.sol";
import {IODOracleGuard} from "../interfaces/IODOracleGuard.sol";
import {IODVolOracle} from "../interfaces/IODVolOracle.sol";
import {Gear, GearStatus, GearConfig, MarketConfig, PriceReading} from "../interfaces/ODTypes.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";
import {ODPowers} from "../interfaces/ODPowers.sol";
import {ODGearFactory} from "./ODGearFactory.sol";

/// @title ODGearRegistry
/// @notice The one list of gears (underlying, power, p0, unit, cap, spread, status) that the minter, hook, backer,
/// indexer and site read. Each gear is one ERC-20 clone at a deterministic address (salt = gear id).
/// @dev DEFAULT_ADMIN_ROLE is the timelock: it lists gears, raises caps, narrows spreads, un-pauses and settles. The
/// guardian only reduces risk: it pauses buys, moves a gear to sell-only, lowers a cap or widens a spread. No status
/// blocks exits; the minter enforces that (SELL_ONLY and BUYS_PAUSED allow sells, SETTLED allows redeem).
/// NF and toll state live in the minter, never here.
contract ODGearRegistry is AccessControl, IODGearRegistry {
    bytes32 public constant GUARDIAN_ROLE = ODRoles.GUARDIAN_ROLE;

    uint16 public constant MAX_SPREAD_BPS = 500;
    uint16 public constant MIN_SPREAD_BPS = 10;
    /// @notice Bounds every per-market loop in the minter and backer.
    uint8 public constant MAX_GEARS_PER_MARKET = 12;
    /// L-1: total gears ever listed (settled ones stay in the list). The Governor's book (pokeRisk, every LP deposit
    /// and claim) walks all of them, about 0.23M gas per gear holding supply on the RHC fork (lane 08: 5.97M at 20,
    /// 10.58M at 40), so 32 keeps pokeRisk near 8.7M and a claim or deposit under 10M.
    uint8 public constant MAX_GEARS = 32;
    /// @notice RACE (p = 3) lists only on a market whose vol ceiling is at most 40% a year.
    uint64 public constant RACE_MAX_VOL_BPS = 4000;
    uint128 public constant MIN_UNIT_WAD = 1e18;
    uint128 public constant MAX_UNIT_WAD = 1000e18;
    uint256 public constant MAX_SYMBOL_BYTES = 32;

    event MinterSet(address minter);

    error ZeroAddress();
    error MinterAlreadySet();
    error MinterNotSet();
    error MarketNotReady(bytes32 market);
    error TooManyGears(bytes32 market);
    error GearCapReached(uint256 cap);
    error SymbolInvalid(string symbol);

    IODOracleGuard public immutable guard;
    IODVolOracle public immutable vol;
    ODGearFactory public immutable factory;
    address public minter;

    mapping(bytes32 id => GearConfig) private _gears;
    mapping(bytes32 market => bytes32[]) private _byMarket;
    bytes32[] private _ids;

    constructor(address admin, address guardian, IODOracleGuard guard_, IODVolOracle vol_) {
        if (
            admin == address(0) || guardian == address(0) || address(guard_) == address(0)
                || address(vol_) == address(0)
        ) revert ZeroAddress();
        guard = guard_;
        vol = vol_;
        factory = new ODGearFactory();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    // ------------------------------------------------------------------------------------------------------- admin

    /// @notice Admin, once: the ODMinter that every gear token trusts to mint and burn.
    function setMinter(address minter_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minter_ == address(0)) revert ZeroAddress();
        if (minter != address(0)) revert MinterAlreadySet();
        minter = minter_;
        emit MinterSet(minter_);
    }

    /// @inheritdoc IODGearRegistry
    /// @dev Single name: `marketB` is 0. Pair: `marketA` over `marketB`, SPORT only in v1. Every market must be
    /// enabled in the guard, read fresh and not be buys-paused; p0 is the guard's price (or ratio) right now.
    function listGear(
        bytes32 marketA,
        bytes32 marketB,
        Gear gear_,
        uint128 unitWad,
        uint128 capUsdWad,
        uint16 spreadBps,
        string calldata symbol
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (bytes32 id) {
        address minter_ = minter;
        if (minter_ == address(0)) revert MinterNotSet();
        bool pair = marketB != bytes32(0);
        if (marketA == bytes32(0) || marketA == marketB) revert InvalidParams();
        if (pair && gear_ != Gear.SPORT) revert NotAllowed();
        if (unitWad < MIN_UNIT_WAD || unitWad > MAX_UNIT_WAD) revert InvalidParams();
        if (capUsdWad == 0) revert InvalidParams();
        if (spreadBps < MIN_SPREAD_BPS || spreadBps > MAX_SPREAD_BPS) revert InvalidParams();

        id = idOf(marketA, marketB, gear_);
        if (_gears[id].token != address(0)) revert GearExists(id);

        if (_ids.length >= MAX_GEARS) revert GearCapReached(MAX_GEARS);
        if (_byMarket[marketA].length >= MAX_GEARS_PER_MARKET) revert TooManyGears(marketA);
        if (pair && _byMarket[marketB].length >= MAX_GEARS_PER_MARKET) revert TooManyGears(marketB);

        if (gear_ == Gear.RACE) {
            (, uint64 ceilingBps) = vol.bounds(marketA);
            if (ceilingBps == 0 || ceilingBps > RACE_MAX_VOL_BPS) revert NotAllowed();
        }

        uint256 p0 = _readyPrice(marketA);
        if (pair) {
            _readyPrice(marketB);
            PriceReading memory r = guard.readRatio(marketA, marketB);
            if (!r.fresh || r.buysPaused) revert MarketNotReady(marketB);
            p0 = r.p;
        }
        if (p0 == 0) revert MarketNotReady(marketA);

        string memory name = _nameOf(symbol, gear_, pair);
        // Effects first; the factory (ours) then deploys the clone at the predicted address.
        address token = factory.predict(id);

        bool race = gear_ == Gear.RACE;
        _gears[id] = GearConfig({
            marketA: marketA,
            marketB: marketB,
            gear: gear_,
            token: token,
            p0: p0,
            unitWad: unitWad,
            capUsdWad: capUsdWad,
            spreadBps: spreadBps,
            collateralBps: race ? 25000 : 20000,
            maintenanceBps: race ? 20000 : 15000,
            status: GearStatus.LISTED,
            listedAt: uint64(block.timestamp)
        });
        _ids.push(id);
        _byMarket[marketA].push(id);
        if (pair) _byMarket[marketB].push(id);
        emit GearListed(id, marketA, marketB, gear_, token, p0, unitWad);
        factory.deploy(id, minter_, name, symbol);
    }

    /// @inheritdoc IODGearRegistry
    /// @dev Risk order: LISTED < BUYS_PAUSED < SELL_ONLY < SETTLED. The guardian may only move a gear to BUYS_PAUSED or
    /// SELL_ONLY, and only upward in that order. The admin may set any status except NONE. SETTLED is terminal.
    function setStatus(bytes32 id, GearStatus status) external {
        GearConfig storage g = _known(id);
        GearStatus cur = g.status;
        if (cur == GearStatus.SETTLED) revert NotAllowed();
        if (status == GearStatus.NONE) revert InvalidParams();
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            _checkRole(GUARDIAN_ROLE);
            bool lowersRisk =
                (status == GearStatus.BUYS_PAUSED || status == GearStatus.SELL_ONLY) && uint8(status) > uint8(cur);
            if (!lowersRisk) revert NotAllowed();
        }
        g.status = status;
        emit GearStatusSet(id, status);
    }

    /// @inheritdoc IODGearRegistry
    /// @dev The guardian may only lower the cap and keep or widen the spread; anything else needs the admin.
    function setParams(bytes32 id, uint128 capUsdWad, uint16 spreadBps) external {
        GearConfig storage g = _known(id);
        if (spreadBps < MIN_SPREAD_BPS || spreadBps > MAX_SPREAD_BPS) revert InvalidParams();
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            _checkRole(GUARDIAN_ROLE);
            if (capUsdWad > g.capUsdWad || spreadBps < g.spreadBps) revert NotAllowed();
        }
        g.capUsdWad = capUsdWad;
        g.spreadBps = spreadBps;
        emit GearParamsSet(id, capUsdWad, spreadBps);
    }

    // ------------------------------------------------------------------------------------------------------- views

    /// @inheritdoc IODGearRegistry
    /// @dev An unknown id returns an empty config (status NONE, token 0).
    function gear(bytes32 id) external view returns (GearConfig memory) {
        return _gears[id];
    }

    /// @inheritdoc IODGearRegistry
    function idOf(bytes32 marketA, bytes32 marketB, Gear gear_) public pure returns (bytes32) {
        return keccak256(abi.encode(marketA, marketB, gear_));
    }

    /// @inheritdoc IODGearRegistry
    function gearsOfMarket(bytes32 market) external view returns (bytes32[] memory) {
        return _byMarket[market];
    }

    /// @inheritdoc IODGearRegistry
    function gearCount() external view returns (uint256) {
        return _ids.length;
    }

    /// @inheritdoc IODGearRegistry
    function gearIdAt(uint256 i) external view returns (bytes32) {
        return _ids[i];
    }

    /// @inheritdoc IODGearRegistry
    function predictToken(bytes32 id) external view returns (address) {
        return factory.predict(id);
    }

    /// @inheritdoc IODGearRegistry
    function powerWad(Gear gear_) external pure returns (int256) {
        return ODPowers.powerWad(gear_);
    }

    /// @notice The token symbol suffix of a gear, e.g. "-SPORT".
    function suffixOf(Gear gear_) public pure returns (string memory) {
        if (gear_ == Gear.CRUISE) return "-CRUISE";
        if (gear_ == Gear.SPORT) return "-SPORT";
        if (gear_ == Gear.RACE) return "-RACE";
        if (gear_ == Gear.ECO) return "-ECO";
        return "-REV";
    }

    /// @notice The word a gear's token name ends in, e.g. "Sport".
    function wordOf(Gear gear_) public pure returns (string memory) {
        if (gear_ == Gear.CRUISE) return "Cruise";
        if (gear_ == Gear.SPORT) return "Sport";
        if (gear_ == Gear.RACE) return "Race";
        if (gear_ == Gear.ECO) return "Eco";
        return "Reverse";
    }

    // ----------------------------------------------------------------------------------------------------- internal

    function _known(bytes32 id) private view returns (GearConfig storage g) {
        g = _gears[id];
        if (g.token == address(0)) revert GearUnknown(id);
    }

    /// @dev Enabled, fresh, not buys-paused, non-zero price; returns the price.
    function _readyPrice(bytes32 market) private view returns (uint256) {
        MarketConfig memory cfg = guard.config(market);
        if (!cfg.enabled) revert MarketNotReady(market);
        PriceReading memory r = guard.read(market);
        if (!r.fresh || r.buysPaused || r.p == 0) revert MarketNotReady(market);
        return r.p;
    }

    /// @dev Checks `symbol` = TICKER + suffix (TICKER = "A/B" for a pair) and returns "Overdrive TICKER Word".
    /// TICKER: 1+ bytes of A-Z, 0-9 or '.', plus exactly one '/' (not first or last) for a pair and none otherwise.
    function _nameOf(string calldata symbol, Gear gear_, bool pair) private pure returns (string memory) {
        bytes memory s = bytes(symbol);
        bytes memory suf = bytes(suffixOf(gear_));
        if (s.length > MAX_SYMBOL_BYTES || s.length <= suf.length) revert SymbolInvalid(symbol);
        uint256 n = s.length - suf.length;
        for (uint256 i; i < suf.length; ++i) {
            if (s[n + i] != suf[i]) revert SymbolInvalid(symbol);
        }
        bytes memory ticker = new bytes(n);
        uint256 slashes;
        for (uint256 i; i < n; ++i) {
            bytes1 c = s[i];
            if (c == "/") {
                if (i == 0 || i == n - 1) revert SymbolInvalid(symbol);
                ++slashes;
            } else if (!((c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == ".")) {
                revert SymbolInvalid(symbol);
            }
            ticker[i] = c;
        }
        if (slashes != (pair ? 1 : 0)) revert SymbolInvalid(symbol);
        return string.concat("Overdrive ", string(ticker), " ", wordOf(gear_));
    }
}

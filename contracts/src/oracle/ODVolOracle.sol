// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IODVolOracle, VolPost, VolReading} from "../interfaces/IODVolOracle.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";

/// @title ODVolOracle
/// @notice Annualised volatility (sigma, bps) per market, posted by the off-chain vol engine's signer as EIP-712 typed
/// data. Anyone may relay a signed post: the signature, not the sender, is what is trusted. The toll every holder pays
/// is a function of this number, so a wrong or missing post must never jump the toll and never block a sell.
/// @dev Rules (test names in test/oracle/VolOracle.t.sol):
///  - R1 The signature is checked first, against the current signer, over every field plus the domain
///    (name "Overdrive Vol", version "1", chainId, this contract). High-s and malformed signatures revert BadSignature.
///  - R2 The nonce is strictly increasing per market; `validUntil` lies in [now + 5 min, now + 2 h].
///  - R3 After the first post, sigma moves at most 25% of the reference per post. The reference is the prior sigma
///    clamped into the market's current [floor, ceiling], so a bounds change cannot leave a market with no
///    acceptable post.
///  - R4 floor <= sigma <= ceiling. Unconfigured markets use the hard limits [5%, 300%].
///  - R5 At most one accepted post per market per MIN_POST_INTERVAL (the first post is exempt).
///  - R6 `read` never reverts. A market never posted reads sigma 0, stale and hardStale. Otherwise
///    stale = now > validUntil and hardStale = now > validUntil + 3 days; the last values stay readable.
///  - R7 The guardian revokes the signer at once; only the admin (the timelock) sets a new one.
///  - R8 Buy-block window (earnings gap risk): 0/0 means none; otherwise from >= now, to >= from, to - from <= 3 days.
///  - R9 A pair market uses the key keccak256(abi.encode(a, b)) and is posted like any market.
contract ODVolOracle is AccessControl, EIP712, IODVolOracle {
    bytes32 public constant POST_TYPEHASH = keccak256(
        "VolPost(bytes32 market,uint64 sigmaBps,uint64 buyBlockFrom,uint64 buyBlockTo,uint64 validUntil,uint64 nonce)"
    );

    /// @notice Largest move per post, in bps of the reference sigma (25%).
    uint64 public constant MAX_STEP_BPS = 2500;
    /// @notice Lowest floor and highest ceiling the admin may set (5% and 300% annual).
    uint64 public constant HARD_MIN_FLOOR_BPS = 500;
    uint64 public constant HARD_MAX_CEILING_BPS = 30000;
    /// @notice A post is valid for at least 5 minutes and at most 2 hours after it lands.
    uint64 public constant HARD_MIN_VALIDITY = 5 minutes;
    uint64 public constant HARD_MAX_VALIDITY = 2 hours;
    /// @notice Minimum time between two accepted posts for one market.
    uint64 public constant MIN_POST_INTERVAL = 30 seconds;
    /// @notice Past validUntil plus this, a reading is hardStale (buys of that market pause; sells are unaffected).
    uint64 public constant HARD_STALE_AFTER = 3 days;
    /// @notice Longest earnings buy-block window.
    uint64 public constant MAX_BUY_BLOCK = 3 days;

    bytes32 public constant GUARDIAN_ROLE = ODRoles.GUARDIAN_ROLE;

    uint256 private constant BPS = 10_000;

    /// @dev Two storage slots per market.
    struct Slot {
        uint64 sigmaBps;
        uint64 postedAt;
        uint64 validUntil;
        uint64 buyBlockFrom;
        uint64 buyBlockTo;
        uint64 nonce;
    }

    struct Bounds {
        uint64 floorBps;
        uint64 ceilingBps;
        bool set;
    }

    address public signer;
    mapping(bytes32 market => Slot) private _vol;
    mapping(bytes32 market => Bounds) private _bounds;

    constructor(address admin, address guardian, address signer_) EIP712("Overdrive Vol", "1") {
        if (admin == address(0)) revert InvalidAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (guardian != address(0)) _grantRole(GUARDIAN_ROLE, guardian);
        _setSigner(signer_);
    }

    // ------------------------------------------------------------------ admin and guardian

    /// @notice Admin (the timelock): rotate the signer. Every unsubmitted post signed by the old key becomes invalid.
    function setSigner(address signer_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSigner(signer_);
    }

    /// @notice Guardian: stop every post at once (suspected signer compromise). The last values stay readable and age
    /// into stale; only the admin's timelocked `setSigner` restores posting.
    function revokeSigner() external onlyRole(GUARDIAN_ROLE) {
        emit SignerRevoked(signer);
        signer = address(0);
    }

    /// @notice Admin: per-market sigma bounds, within [HARD_MIN_FLOOR_BPS, HARD_MAX_CEILING_BPS].
    function setBounds(bytes32 market, uint64 floorBps, uint64 ceilingBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (floorBps < HARD_MIN_FLOOR_BPS || ceilingBps > HARD_MAX_CEILING_BPS || floorBps > ceilingBps) {
            revert InvalidBounds(floorBps, ceilingBps);
        }
        _bounds[market] = Bounds({floorBps: floorBps, ceilingBps: ceilingBps, set: true});
        emit BoundsSet(market, floorBps, ceilingBps);
    }

    // ------------------------------------------------------------------ post

    /// @inheritdoc IODVolOracle
    function post(VolPost calldata p, bytes calldata sig) external {
        address current = signer;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashPost(p), sig);
        if (current == address(0) || err != ECDSA.RecoverError.NoError || recovered != current) revert BadSignature();

        if (p.validUntil < block.timestamp + HARD_MIN_VALIDITY || p.validUntil > block.timestamp + HARD_MAX_VALIDITY) {
            revert Expired();
        }

        Slot storage s = _vol[p.market];
        if (p.nonce <= s.nonce) revert NonceUsed(p.nonce);

        uint64 priorAt = s.postedAt;
        if (priorAt != 0 && block.timestamp < uint256(priorAt) + MIN_POST_INTERVAL) {
            revert TooSoon(priorAt + MIN_POST_INTERVAL);
        }

        (uint64 floor_, uint64 ceiling_) = bounds(p.market);
        if (p.sigmaBps < floor_ || p.sigmaBps > ceiling_) revert OutOfBounds(p.sigmaBps);

        uint64 prior = s.sigmaBps;
        if (priorAt != 0) {
            uint64 ref = prior < floor_ ? floor_ : (prior > ceiling_ ? ceiling_ : prior);
            uint256 diff = p.sigmaBps > ref ? p.sigmaBps - ref : ref - p.sigmaBps;
            if (diff * BPS > uint256(ref) * MAX_STEP_BPS) revert StepTooLarge(prior, p.sigmaBps);
        }

        if (p.buyBlockFrom != 0 || p.buyBlockTo != 0) {
            if (
                p.buyBlockFrom < block.timestamp || p.buyBlockTo < p.buyBlockFrom
                    || p.buyBlockTo - p.buyBlockFrom > MAX_BUY_BLOCK
            ) revert BadBuyBlockWindow(p.buyBlockFrom, p.buyBlockTo);
        }

        _vol[p.market] = Slot({
            sigmaBps: p.sigmaBps,
            // casting to 'uint64' is safe because timestamps fit until the year 584 billion
            // forge-lint: disable-next-line(unsafe-typecast)
            postedAt: uint64(block.timestamp),
            validUntil: p.validUntil,
            buyBlockFrom: p.buyBlockFrom,
            buyBlockTo: p.buyBlockTo,
            nonce: p.nonce
        });
        emit VolPosted(p.market, p.sigmaBps, p.validUntil, p.nonce);
    }

    // ------------------------------------------------------------------ views

    /// @notice Last posted values; never reverts. A market never posted reads sigma 0, stale and hardStale.
    function read(bytes32 market) external view returns (VolReading memory r) {
        Slot memory s = _vol[market];
        if (s.postedAt == 0) {
            r.stale = true;
            r.hardStale = true;
            return r;
        }
        r = VolReading({
            sigmaBps: s.sigmaBps,
            postedAt: s.postedAt,
            validUntil: s.validUntil,
            buyBlockFrom: s.buyBlockFrom,
            buyBlockTo: s.buyBlockTo,
            stale: block.timestamp > s.validUntil,
            hardStale: block.timestamp > uint256(s.validUntil) + HARD_STALE_AFTER
        });
    }

    /// @inheritdoc IODVolOracle
    function bounds(bytes32 market) public view returns (uint64 floorBps, uint64 ceilingBps) {
        Bounds memory b = _bounds[market];
        if (!b.set) return (HARD_MIN_FLOOR_BPS, HARD_MAX_CEILING_BPS);
        return (b.floorBps, b.ceilingBps);
    }

    /// @inheritdoc IODVolOracle
    function lastNonce(bytes32 market) external view returns (uint64) {
        return _vol[market].nonce;
    }

    /// @notice The market key of a pair: numerator market `a` over denominator market `b` (R9).
    function pairKey(bytes32 a, bytes32 b) external pure returns (bytes32) {
        return keccak256(abi.encode(a, b));
    }

    /// @inheritdoc IODVolOracle
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Returns the EIP-712 struct hash of a post.
    /// @param p The parameter struct.
    /// @return  The struct hash.
    function structHash(VolPost calldata p) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(POST_TYPEHASH, p.market, p.sigmaBps, p.buyBlockFrom, p.buyBlockTo, p.validUntil, p.nonce)
            );
    }

    /// @notice The EIP-712 digest the signer signs for `p`.
    function hashPost(VolPost calldata p) public view returns (bytes32) {
        return _hashTypedDataV4(structHash(p));
    }

    // ------------------------------------------------------------------ internal

    function _setSigner(address signer_) private {
        if (signer_ == address(0)) revert InvalidSigner();
        signer = signer_;
        emit SignerSet(signer_);
    }
}

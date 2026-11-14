// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IODFees} from "../interfaces/IODFees.sol";
import {IODGovernor} from "../interfaces/IODGovernor.sol";

/// @dev The single entry ODFees calls on the stake contract (kept out of IODStake so cores never see it).
interface IODStakeRewards {
    function notifyRewards(uint256 usdg) external;
}

/// @title ODFees
/// @notice Collects the protocol's fee share (a share of the spread and of the toll) and splits it once per PERIOD:
/// ops / treasury / stakers / burn (default 8000/1000/500/500), with ops split again into the Governor, the exit
/// reserve, keepers and hedgers (default 4000/3000/1500/1500). No revenue claim attaches to any of it.
/// @dev Accounting is internal: only USDG announced through `notify` by an allowed notifier, after it arrived, is
/// counted (a donation is never counted). The Governor and exit-reserve shares are paid through `fundCash` and
/// `fundExitReserve` (the Governor pulls them, so its own books see them); the stakers share through
/// `notifyRewards` on the stake contract; every other share is a plain transfer. A share whose recipient is unset or
/// whose payment fails is held and paid with a later distribution or `release` (one recipient cannot block the rest).
/// Rounding dust stays in `distributable`. Admin is the timelock.
contract ODFees is AccessControl, IODFees {
    using SafeERC20 for IERC20;

    bytes32 public constant B_GOVERNOR = "GOVERNOR";
    bytes32 public constant B_EXIT_RESERVE = "EXIT_RESERVE";
    bytes32 public constant B_KEEPERS = "KEEPERS";
    bytes32 public constant B_HEDGERS = "HEDGERS";
    bytes32 public constant B_TREASURY = "TREASURY";
    bytes32 public constant B_STAKERS = "STAKERS";
    bytes32 public constant B_BURN = "BURN";

    bytes32 public constant K_SPREAD = "SPREAD";
    bytes32 public constant K_TOLL = "TOLL";
    bytes32 public constant K_BACKER_TOLL = "BACKER_TOLL";

    uint32 public constant PERIOD = 7 days;
    uint256 private constant BPS = 10_000;
    uint16 public constant MAX_FEE_PARAM_BPS = 3_000;

    IERC20 public immutable usdg;

    uint16 public opsBps = 8_000;
    uint16 public treasuryBps = 1_000;
    uint16 public stakersBps = 500;
    uint16 public burnBps = 500;
    uint16 public governorBps = 4_000;
    uint16 public exitReserveBps = 3_000;
    uint16 public keepersBps = 1_500;
    uint16 public hedgersBps = 1_500;

    uint16 public override protocolSpreadShareBps = 1_000;
    uint16 public override tollFeeBps = 1_000;

    uint256 public lastDistribution;
    /// @notice Notified USDG not yet split (includes rounding dust of earlier splits).
    uint256 public pending;
    uint256 public totalHeld;
    mapping(bytes32 bucket => uint256 usdg) public held;
    mapping(bytes32 bucket => address recipient) public recipientOf;
    mapping(address notifier => bool allowed) public isNotifier;

    event NotifierSet(address indexed notifier, bool allowed);
    event FeeParamsSet(uint16 protocolSpreadShareBps, uint16 tollFeeBps);
    event Paid(bytes32 indexed bucket, address indexed to, uint256 amount);

    error NotNotifier();
    error NotArrived(uint256 balance, uint256 needed);
    error UnknownKind(bytes32 kind);

    constructor(IERC20 usdg_, address admin, address governor) {
        if (address(usdg_) == address(0) || admin == address(0)) revert InvalidParams();
        usdg = usdg_;
        lastDistribution = block.timestamp;
        recipientOf[B_GOVERNOR] = governor;
        recipientOf[B_EXIT_RESERVE] = governor;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------------ intake

    /// @inheritdoc IODFees
    function notify(bytes32 kind, bytes32 gearId, uint256 amount) external override {
        if (!isNotifier[msg.sender]) revert NotNotifier();
        if (kind != K_SPREAD && kind != K_TOLL && kind != K_BACKER_TOLL) revert UnknownKind(kind);
        uint256 needed = pending + totalHeld + amount;
        uint256 bal = usdg.balanceOf(address(this));
        if (bal < needed) revert NotArrived(bal, needed);
        pending += amount;
        emit Notified(kind, gearId, amount);
    }

    /// @notice L-3: anyone books USDG that arrived without a successful `notify` (a notify that failed or never came,
    /// or a plain transfer) as pending, so it goes through the next split like any fee. Pays nothing out and moves
    /// nothing; afterwards balance == pending + totalHeld.
    function sync() external override returns (uint256 amount) {
        uint256 booked = pending + totalHeld;
        uint256 bal = usdg.balanceOf(address(this));
        if (bal <= booked) return 0;
        amount = bal - booked;
        pending += amount;
        emit Synced(amount);
    }

    // ------------------------------------------------------------------------------------------------ split

    /// @inheritdoc IODFees
    function distribute() external override returns (uint256 amount) {
        uint256 next = lastDistribution + PERIOD;
        if (block.timestamp < next) revert TooEarly(next);
        lastDistribution = block.timestamp;
        amount = pending;
        pending = 0;

        uint256 ops = amount * opsBps / BPS;
        uint256[7] memory s;
        s[0] = ops * governorBps / BPS;
        s[1] = ops * exitReserveBps / BPS;
        s[2] = ops * keepersBps / BPS;
        s[3] = ops * hedgersBps / BPS;
        s[4] = amount * treasuryBps / BPS;
        s[5] = amount * stakersBps / BPS;
        s[6] = amount * burnBps / BPS;
        uint256 used = s[0] + s[1] + s[2] + s[3] + s[4] + s[5] + s[6];
        pending = amount - used; // rounding dust rolls into the next split

        bytes32[7] memory b = _buckets();
        for (uint256 i; i < 7; ++i) {
            _settle(b[i], s[i]);
        }
        emit Distributed(amount, s[0], s[1], s[2], s[3], s[4], s[5], s[6]);
    }

    /// @notice Pays a bucket's held USDG to its recipient now (anyone; no-op while unset or failing).
    function release(bytes32 bucket) external returns (uint256 paid) {
        return _settle(bucket, 0);
    }

    // ------------------------------------------------------------------------------------------------ views

    function distributable() external view override returns (uint256) {
        return pending;
    }

    function nextDistributionAt() external view override returns (uint256) {
        return lastDistribution + PERIOD;
    }

    // ------------------------------------------------------------------------------------------------ admin (timelock)

    function setSplit(uint16 ops, uint16 treasury, uint16 stakers, uint16 burn) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (uint256(ops) + treasury + stakers + burn != BPS) revert InvalidParams();
        (opsBps, treasuryBps, stakersBps, burnBps) = (ops, treasury, stakers, burn);
        emit SplitSet(ops, treasury, stakers, burn);
    }

    function setOpsSplit(uint16 governor, uint16 exitReserve, uint16 keepers, uint16 hedgers)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (uint256(governor) + exitReserve + keepers + hedgers != BPS) revert InvalidParams();
        (governorBps, exitReserveBps, keepersBps, hedgersBps) = (governor, exitReserve, keepers, hedgers);
        emit OpsSplitSet(governor, exitReserve, keepers, hedgers);
    }

    /// @notice Zero holds the bucket. GOVERNOR and EXIT_RESERVE must point at the Governor.
    function setRecipient(bytes32 bucket, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_isBucket(bucket)) revert InvalidParams();
        recipientOf[bucket] = recipient;
        emit RecipientSet(bucket, recipient);
    }

    function setFeeParams(uint16 spreadShareBps, uint16 tollBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (spreadShareBps > MAX_FEE_PARAM_BPS || tollBps > MAX_FEE_PARAM_BPS) revert InvalidParams();
        (protocolSpreadShareBps, tollFeeBps) = (spreadShareBps, tollBps);
        emit FeeParamsSet(spreadShareBps, tollBps);
    }

    /// @notice The Governor, the Backer and the Minter.
    function setNotifier(address notifier, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (notifier == address(0)) revert InvalidParams();
        isNotifier[notifier] = allowed;
        emit NotifierSet(notifier, allowed);
    }

    // ------------------------------------------------------------------------------------------------ internals

    /// @dev Pays `amount + held[bucket]`; whatever cannot be paid is held. Never reverts on the recipient.
    function _settle(bytes32 bucket, uint256 amount) private returns (uint256 paid) {
        uint256 h = held[bucket];
        uint256 total = amount + h;
        if (total == 0) return 0;
        address to = recipientOf[bucket];
        if (to != address(0)) paid = _pay(bucket, to, total);
        uint256 rest = total - paid;
        if (rest != h) {
            totalHeld = totalHeld + rest - h;
            held[bucket] = rest;
            if (rest > h) emit Held(bucket, rest - h);
        }
        if (paid != 0) emit Paid(bucket, to, paid);
    }

    /// @dev Returns what actually left this contract (measured), 0 on any failure. USDG the recipient sends back and
    /// books as pending during the call (the Governor's fundCash settles its owed fees with notify) counts as paid out,
    /// so it is never also kept by the bucket (F12-1: it was booked twice, pending and held).
    function _pay(bytes32 bucket, address to, uint256 amount) private returns (uint256 paid) {
        uint256 p0 = pending;
        uint256 before = usdg.balanceOf(address(this));
        if (bucket == B_GOVERNOR || bucket == B_EXIT_RESERVE || bucket == B_STAKERS) {
            usdg.forceApprove(to, amount);
            bytes memory data;
            if (bucket == B_GOVERNOR) data = abi.encodeCall(IODGovernor.fundCash, (amount));
            else if (bucket == B_EXIT_RESERVE) data = abi.encodeCall(IODGovernor.fundExitReserve, (amount));
            else data = abi.encodeCall(IODStakeRewards.notifyRewards, (amount));
            (bool ok,) = to.call(data);
            ok; // the measured balance decides
            usdg.forceApprove(to, 0);
        } else {
            (bool ok, bytes memory ret) = address(usdg).call(abi.encodeCall(IERC20.transfer, (to, amount)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) return 0;
        }
        uint256 afterBal = usdg.balanceOf(address(this));
        uint256 out = before + (pending - p0); // pending only grows during the call (distribute cannot re-enter)
        paid = out > afterBal ? out - afterBal : 0;
        if (paid > amount) paid = amount;
    }

    function _buckets() private pure returns (bytes32[7] memory b) {
        b = [B_GOVERNOR, B_EXIT_RESERVE, B_KEEPERS, B_HEDGERS, B_TREASURY, B_STAKERS, B_BURN];
    }

    function _isBucket(bytes32 bucket) private pure returns (bool) {
        bytes32[7] memory b = _buckets();
        for (uint256 i; i < 7; ++i) {
            if (b[i] == bucket) return true;
        }
        return false;
    }
}

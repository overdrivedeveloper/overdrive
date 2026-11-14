// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PackedUserOperation, IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IODPaymaster} from "../interfaces/IODPaymaster.sol";

/// @dev The Kernel factory's address derivation (v3.3 `getAddress(initData, salt)`, CREATE2 over its implementation).
interface IKernelFactoryAddress {
    function getAddress(bytes calldata data, bytes32 salt) external view returns (address);
}

/// @title ODPaymaster
/// @notice Verifying paymaster for ERC-4337 EntryPoint v0.7. It pays gas only for user operations that
/// (1) hold a signature from the sponsoring signer, (2) call nothing but the protocol targets (minter, backer, agent
/// router) or a USDG `approve` whose spender is one of them, with zero value and at most MAX_CALLS calls,
/// (3) stay inside per-operation, per-account-per-day and global-per-day gas caps, and (4) come from a Kernel account:
/// one this paymaster saw deployed through the Kernel factory (the sponsor signature covers the initCode), or one
/// registered with the standard setup. The call policy reads `execute(bytes32,bytes)` calldata, which only means what
/// it says on a real Kernel account. Owned (two-step) by the timelock; the guardian may pause sponsorship at once and
/// only the owner unpauses. A pause only stops sponsorship: users still trade with their own gas.
/// @dev Validation follows the ERC-7562 storage and opcode rules: no `block.timestamp` (the day bucket comes from the
/// signed `validUntil`), per-account state is one struct in a mapping keyed by the sender. The global cap and the
/// target set live in this contract's storage, so the paymaster must be staked in the EntryPoint (`addStake`).
///
/// paymasterAndData = paymaster (20) | verificationGasLimit (16) | postOpGasLimit (16) | validUntil (6) | validAfter (6) | signature (65).
/// The signature is an EIP-191 personal signature by `signer` over `getHash(userOp, validUntil, validAfter)`, which
/// binds the chain id and this paymaster's address (domain separation).
contract ODPaymaster is Ownable2Step, IODPaymaster {
    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    struct Usage {
        uint64 day;
        uint192 spent;
    }

    uint256 public constant PAYMASTER_DATA_OFFSET = 52;
    uint256 public constant PAYMASTER_DATA_LENGTH = 77; // validUntil 6 + validAfter 6 + signature 65
    uint256 public constant MAX_VALIDITY_WINDOW = 1 hours;
    uint256 public constant MAX_CALLS = 4;
    /// @notice Hard ceilings of the caps (wei of the gas token), so no setting can switch them off.
    uint256 public constant MAX_COST_PER_OP_CEILING = 0.05 ether;
    uint256 public constant ACCOUNT_DAILY_CAP_CEILING = 0.5 ether;
    uint256 public constant GLOBAL_DAILY_CAP_CEILING = 10 ether;
    /// @dev Kernel / ERC-7579 `execute(bytes32,bytes)`.
    bytes4 private constant EXECUTE = 0xe9ae5c53;
    bytes4 private constant APPROVE = 0x095ea7b3;
    /// @notice Kernel v3.3 factory and its ECDSA validator on Robinhood Chain 4663 (code checked with cast,
    /// recorded in the chain facts). Tests etch a stand-in factory at this address.
    address public constant KERNEL_FACTORY = 0x2577507b78c2008Ff367261CB6285d44ba5eF2E9;
    address public constant ECDSA_VALIDATOR = 0x845ADb2C711129d4f3966735eD98a9F09fC4cE57;
    /// @dev Kernel v3 `initialize(bytes21,address,bytes,bytes,bytes[])`.
    bytes4 private constant KERNEL_INITIALIZE = bytes4(keccak256("initialize(bytes21,address,bytes,bytes,bytes[])"));

    IEntryPoint public immutable ENTRY_POINT;
    address public immutable USDG;

    address public signer;
    address public guardian;
    bool public paused;
    /// @dev All caps are in wei of the chain's gas token and are checked against the EntryPoint's `maxCost`.
    uint256 public maxCostPerOp;
    uint256 public accountDailyCap;
    uint256 public globalDailyCap;

    Usage public globalUsage;
    mapping(address account => Usage) public accountUsage;
    /// @notice Senders known to be Kernel accounts. No other sender is sponsored.
    mapping(address account => bool) public kernelAccount;
    /// @notice Contracts a sponsored call may target, and the only spenders a sponsored USDG approve may name.
    mapping(address target => bool) public isProtocolTarget;
    address[] private _targets;

    event GuardianChanged(address indexed guardian);
    event Sponsored(address indexed account, uint256 indexed day, uint256 reservedCost);
    event Refunded(address indexed account, uint256 indexed day, uint256 amount);
    event KernelAccountSet(address indexed account, bool known);

    error NotEntryPoint();
    error PausedError();
    error NotGuardianOrOwner();
    error ZeroAddress();
    error BadTargets();
    error BadPaymasterData();
    error BadValidityWindow();
    error UnsupportedCallData();
    error TooManyCalls();
    error ValueNotAllowed();
    error TargetNotAllowed(address target);
    error ApproveNotAllowed(address spender);
    error MaxCostPerOpExceeded(uint256 maxCost, uint256 cap);
    error AccountDailyCapExceeded(address account, uint256 wouldSpend, uint256 cap);
    error GlobalDailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error UnknownAccount(address sender);
    error NotStandardAccount();
    error BadLimits();

    constructor(
        IEntryPoint ep,
        address owner_,
        address guardian_,
        address signer_,
        address[] memory protocolTargets_,
        address usdg,
        uint256 maxCostPerOp_,
        uint256 accountDailyCap_,
        uint256 globalDailyCap_
    ) Ownable(owner_) {
        if (address(ep) == address(0) || signer_ == address(0) || usdg == address(0) || guardian_ == address(0)) {
            revert ZeroAddress();
        }
        if (protocolTargets_.length == 0) revert BadTargets();
        for (uint256 i; i < protocolTargets_.length; ++i) {
            address t = protocolTargets_[i];
            if (t == address(0) || t == usdg || isProtocolTarget[t]) revert BadTargets();
            isProtocolTarget[t] = true;
            _targets.push(t);
        }
        ENTRY_POINT = ep;
        USDG = usdg;
        signer = signer_;
        guardian = guardian_;
        emit SignerChanged(signer_);
        emit GuardianChanged(guardian_);
        _setLimits(maxCostPerOp_, accountDailyCap_, globalDailyCap_);
    }

    // -----------------------------------------------------------------------------------------------------------
    // EntryPoint hooks
    // -----------------------------------------------------------------------------------------------------------

    /// @notice ERC-4337 v0.7 paymaster validation. Returns validationData with the signature-failed flag (1) when the
    /// sponsor signature does not verify; reverts when paused or when the call policy or a cap is violated.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(ENTRY_POINT)) revert NotEntryPoint();
        if (paused) revert PausedError();
        bytes calldata pd = userOp.paymasterAndData;
        if (pd.length != PAYMASTER_DATA_OFFSET + PAYMASTER_DATA_LENGTH) revert BadPaymasterData();

        uint48 validUntil = uint48(bytes6(pd[52:58]));
        uint48 validAfter = uint48(bytes6(pd[58:64]));
        if (validUntil == 0 || validUntil <= validAfter || validUntil - validAfter > MAX_VALIDITY_WINDOW) {
            revert BadValidityWindow();
        }
        validationData = (uint256(validUntil) << 160) | (uint256(validAfter) << 208);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, pd[64:129]);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) {
            return ("", validationData | 1);
        }

        _checkCalls(userOp.callData);
        _checkAccount(userOp);

        if (maxCost > maxCostPerOp) revert MaxCostPerOpExceeded(maxCost, maxCostPerOp);
        uint64 day = uint64(validUntil / 1 days);

        Usage memory a = accountUsage[userOp.sender];
        uint256 aSpent = a.day == day ? a.spent : 0;
        if (aSpent + maxCost > accountDailyCap) {
            revert AccountDailyCapExceeded(userOp.sender, aSpent + maxCost, accountDailyCap);
        }
        Usage memory g = globalUsage;
        uint256 gSpent = g.day == day ? g.spent : 0;
        if (gSpent + maxCost > globalDailyCap) revert GlobalDailyCapExceeded(gSpent + maxCost, globalDailyCap);

        accountUsage[userOp.sender] = Usage(day, uint192(aSpent + maxCost));
        globalUsage = Usage(day, uint192(gSpent + maxCost));
        emit Sponsored(userOp.sender, day, maxCost);
        // Gas the EntryPoint charges after postOp's actualGasCost: postOp's own gas (at most its limit) and the 10%
        // penalty on unused call and postOp gas (at most 10% of both limits). Booked in postOp at the op's fee.
        uint256 postOpGas = uint128(bytes16(pd[36:52]));
        uint256 extraGas = postOpGas + (uint128(uint256(userOp.accountGasLimits)) + postOpGas) / 10;
        context = abi.encode(userOp.sender, day, maxCost, extraGas);
    }

    /// @notice Returns the unused part of the reserved cost to the caps once the real cost is known. The cost booked is
    /// `actualGasCost` plus the most the EntryPoint can add after it (postOp gas and the unused-gas penalty) at the
    /// op's fee, never more than the reservation, so the caps never under-count what the deposit pays.
    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external
    {
        if (msg.sender != address(ENTRY_POINT)) revert NotEntryPoint();
        (address account, uint64 day, uint256 reserved, uint256 extraGas) =
            abi.decode(context, (address, uint64, uint256, uint256));
        uint256 cost = actualGasCost + extraGas * actualUserOpFeePerGas;
        uint256 refund = cost >= reserved ? 0 : reserved - cost;
        if (refund == 0) return;
        Usage memory a = accountUsage[account];
        if (a.day == day) accountUsage[account].spent = uint192(a.spent > refund ? a.spent - refund : 0);
        Usage memory g = globalUsage;
        if (g.day == day) globalUsage.spent = uint192(g.spent > refund ? g.spent - refund : 0);
        emit Refunded(account, day, refund);
    }

    /// @inheritdoc IODPaymaster
    /// @dev Covers every operation field the account signature covers except the account signature itself and the
    /// sponsor signature, plus the chain id and this paymaster's address.
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                bytes32(userOp.paymasterAndData[20:52]),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    function protocolTargets() external view returns (address[] memory) {
        return _targets;
    }

    // -----------------------------------------------------------------------------------------------------------
    // Call policy
    // -----------------------------------------------------------------------------------------------------------

    function _checkCalls(bytes calldata callData) internal view {
        if (callData.length < 100 || bytes4(callData[0:4]) != EXECUTE) revert UnsupportedCallData();
        (bytes32 mode, bytes memory exec) = abi.decode(callData[4:], (bytes32, bytes));
        bytes1 callType = bytes1(mode);
        if (callType == 0x00) {
            if (exec.length < 52) revert UnsupportedCallData();
            address target;
            uint256 value;
            assembly ("memory-safe") {
                target := shr(96, mload(add(exec, 32)))
                value := mload(add(exec, 52))
            }
            bytes memory data = new bytes(exec.length - 52);
            for (uint256 i; i < data.length; ++i) {
                data[i] = exec[i + 52];
            }
            _checkOne(target, value, data);
        } else if (callType == 0x01) {
            Execution[] memory calls = abi.decode(exec, (Execution[]));
            if (calls.length == 0 || calls.length > MAX_CALLS) revert TooManyCalls();
            for (uint256 i; i < calls.length; ++i) {
                _checkOne(calls[i].target, calls[i].value, calls[i].callData);
            }
        } else {
            revert UnsupportedCallData(); // delegatecall (0xff) and anything unknown
        }
    }

    /// @dev A known account passes. Otherwise the operation must deploy the sender through KERNEL_FACTORY (the
    /// EntryPoint has just done so and checked the address); the sender is then remembered. Storage keyed by the
    /// sender, so ERC-7562 allows it.
    function _checkAccount(PackedUserOperation calldata userOp) internal {
        address sender = userOp.sender;
        if (kernelAccount[sender]) return;
        bytes calldata initCode = userOp.initCode;
        if (initCode.length < 20 || address(bytes20(initCode[0:20])) != KERNEL_FACTORY) revert UnknownAccount(sender);
        kernelAccount[sender] = true;
        emit KernelAccountSet(sender, true);
    }

    function _checkOne(address target, uint256 value, bytes memory data) internal view {
        if (value != 0) revert ValueNotAllowed();
        if (isProtocolTarget[target]) {
            if (data.length < 4) revert UnsupportedCallData();
            return;
        }
        if (target == USDG) {
            if (data.length != 68) revert UnsupportedCallData();
            bytes4 sel;
            address spender;
            assembly ("memory-safe") {
                sel := mload(add(data, 32))
                spender := mload(add(data, 36))
            }
            if (sel != APPROVE) revert TargetNotAllowed(target);
            if (!isProtocolTarget[spender]) revert ApproveNotAllowed(spender);
            return;
        }
        revert TargetNotAllowed(target);
    }

    // -----------------------------------------------------------------------------------------------------------
    // Funding and administration
    // -----------------------------------------------------------------------------------------------------------

    /// @notice Anyone may top up the gas deposit held in the EntryPoint.
    function deposit() external payable {
        ENTRY_POINT.depositTo{value: msg.value}(address(this));
    }

    receive() external payable {
        ENTRY_POINT.depositTo{value: msg.value}(address(this));
    }

    function depositBalance() external view returns (uint256) {
        return ENTRY_POINT.balanceOf(address(this));
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        ENTRY_POINT.withdrawTo(to, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        ENTRY_POINT.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        ENTRY_POINT.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        ENTRY_POINT.withdrawStake(to);
    }

    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        signer = newSigner;
        emit SignerChanged(newSigner);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        guardian = newGuardian;
        emit GuardianChanged(newGuardian);
    }

    /// @notice 0 < maxCostPerOp <= accountDailyCap <= globalDailyCap, each under its hard ceiling.
    function setLimits(uint256 maxCostPerOp_, uint256 accountDailyCap_, uint256 globalDailyCap_) external onlyOwner {
        _setLimits(maxCostPerOp_, accountDailyCap_, globalDailyCap_);
    }

    /// @notice The guardian (or the owner) pauses at once; only the owner (the timelock) unpauses.
    function setPaused(bool paused_) external {
        if (paused_) {
            if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
        } else {
            _checkOwner();
        }
        paused = paused_;
        emit PausedChanged(paused_);
    }

    function _setLimits(uint256 maxCostPerOp_, uint256 accountDailyCap_, uint256 globalDailyCap_) private {
        if (
            maxCostPerOp_ == 0 || maxCostPerOp_ > accountDailyCap_ || accountDailyCap_ > globalDailyCap_
                || maxCostPerOp_ > MAX_COST_PER_OP_CEILING || accountDailyCap_ > ACCOUNT_DAILY_CAP_CEILING
                || globalDailyCap_ > GLOBAL_DAILY_CAP_CEILING
        ) revert BadLimits();
        maxCostPerOp = maxCostPerOp_;
        accountDailyCap = accountDailyCap_;
        globalDailyCap = globalDailyCap_;
        emit LimitsChanged(maxCostPerOp_, accountDailyCap_, globalDailyCap_);
    }

    /// @notice Permissionless: registers `account` as a Kernel account when it is the deployed KERNEL_FACTORY account
    /// for `initData` and `salt`, and `initData` is the standard setup the sponsor signs for (root validator = the
    /// ECDSA validator, no hook, a 20-byte owner, no hook data, no init config). The CREATE2 address binds the init
    /// data, so whoever deployed it does not matter: a stranger deploying a user's account first cannot make it
    /// unsponsorable. Not called during validation.
    function registerKernelAccount(address account, bytes calldata initData, bytes32 salt) external {
        if (initData.length < 4 || bytes4(initData[0:4]) != KERNEL_INITIALIZE) revert NotStandardAccount();
        (bytes21 root, address hook, bytes memory validatorData, bytes memory hookData, bytes[] memory initConfig) =
            abi.decode(initData[4:], (bytes21, address, bytes, bytes, bytes[]));
        if (
            root != bytes21(abi.encodePacked(bytes1(0x01), ECDSA_VALIDATOR)) || hook != address(1)
                || validatorData.length != 20 || hookData.length != 0 || initConfig.length != 0
        ) revert NotStandardAccount();
        if (IKernelFactoryAddress(KERNEL_FACTORY).getAddress(initData, salt) != account || account.code.length == 0) {
            revert UnknownAccount(account);
        }
        if (kernelAccount[account]) return;
        kernelAccount[account] = true;
        emit KernelAccountSet(account, true);
    }

    /// @notice Registers (or forgets) Kernel accounts deployed without a sponsored operation, after checking off chain
    /// that each is a Kernel proxy of the expected implementation with the standard validator.
    function setKernelAccounts(address[] calldata accounts, bool known) external onlyOwner {
        for (uint256 i; i < accounts.length; ++i) {
            kernelAccount[accounts[i]] = known;
            emit KernelAccountSet(accounts[i], known);
        }
    }
}

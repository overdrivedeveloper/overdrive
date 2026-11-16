// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/types/Currency.sol";

/// @title ODHookSeed
/// @notice D26 hook pool seed for the owner Safe: `seed` turns the Safe's ERC-20s (USDG, gear tokens) into ERC-6909
/// claims in the v4 PoolManager held by the Safe; `remove` burns the Safe's claims and sends the tokens back to the
/// Safe. A Safe cannot implement `unlockCallback` itself, so this contract opens the PoolManager lock for it.
/// @dev Periphery only: no core contract trusts or calls it. Only `owner` (immutable) can call `seed` and `remove`;
/// tokens always move owner -> PoolManager or PoolManager -> owner, never through or into this contract. Before `seed`
/// the Safe approves the ERC-20 amounts to this contract; before `remove` it approves the ERC-6909 ids on the
/// PoolManager (`approve(helper, id, amount)`), both consumed exactly in the same Safe batch. Native ETH and
/// fee-on-transfer tokens are refused.
contract ODHookSeed is IUnlockCallback {
    using SafeERC20 for IERC20;

    uint8 private constant SEED = 1;
    uint8 private constant REMOVE = 2;

    /// @notice The v4 PoolManager.
    IPoolManager public immutable poolManager;
    /// @notice The owner Safe: the only caller, the only source of seed tokens and the only receiver of removed tokens.
    address public immutable owner;

    error NotOwner();
    error NotPoolManager();
    error ZeroAddress();
    error LengthMismatch();
    error NativeNotSupported();
    error SettledShort(address currency);

    /// @notice Emitted per currency moved into claims.
    event Seeded(address indexed currency, uint256 amount);
    /// @notice Emitted per currency moved out of claims back to the owner.
    event Removed(address indexed currency, uint256 amount);

    /// @param poolManager_ The v4 PoolManager.
    /// @param owner_ The owner Safe.
    constructor(IPoolManager poolManager_, address owner_) {
        if (address(poolManager_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        owner = owner_;
    }

    /// @notice Moves `amounts[i]` of each ERC-20 `currencies[i]` from the owner into PoolManager ERC-6909 claims
    /// minted to the owner.
    /// @param currencies The ERC-20 tokens.
    /// @param amounts The amounts, one per token.
    function seed(address[] calldata currencies, uint256[] calldata amounts) external {
        _run(SEED, currencies, amounts);
    }

    /// @notice Burns `amounts[i]` of the owner's ERC-6909 claim on each `currencies[i]` and sends the tokens to the owner.
    /// @param currencies The ERC-20 tokens.
    /// @param amounts The amounts, one per token.
    function remove(address[] calldata currencies, uint256[] calldata amounts) external {
        _run(REMOVE, currencies, amounts);
    }

    /// @inheritdoc IUnlockCallback
    /// @dev The PoolManager calls back only the contract that called `unlock`, so only `_run` reaches the body.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 op, address[] memory currencies, uint256[] memory amounts) =
            abi.decode(data, (uint8, address[], uint256[]));
        for (uint256 i; i < currencies.length; ++i) {
            Currency c = Currency.wrap(currencies[i]);
            uint256 amt = amounts[i];
            if (op == SEED) {
                emit Seeded(currencies[i], amt);
                poolManager.sync(c);
                IERC20(currencies[i]).safeTransferFrom(owner, address(poolManager), amt);
                if (poolManager.settle() != amt) revert SettledShort(currencies[i]);
                poolManager.mint(owner, c.toId(), amt);
            } else {
                emit Removed(currencies[i], amt);
                poolManager.burn(owner, c.toId(), amt);
                poolManager.take(c, owner, amt);
            }
        }
        return "";
    }

    function _run(uint8 op, address[] calldata currencies, uint256[] calldata amounts) private {
        if (msg.sender != owner) revert NotOwner();
        if (currencies.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < currencies.length; ++i) {
            if (currencies[i] == address(0)) revert NativeNotSupported();
        }
        poolManager.unlock(abi.encode(op, currencies, amounts));
    }
}

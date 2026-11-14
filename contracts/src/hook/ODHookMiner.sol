// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";

/// @title ODHookMiner
/// @notice Finds a CREATE2 salt whose address carries exactly ODHook's permission bits (beforeInitialize,
/// beforeAddLiquidity, beforeSwap, beforeSwapReturnDelta) and nothing else in the low 14 bits. The salt depends on the
/// deployer, so it must be mined against the real deployer (a different deployer gets a different address).
/// @dev Self-contained (the vendored periphery ships no HookMiner). The init code hash is computed once.
library ODHookMiner {
    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG;
    uint256 internal constant MAX_LOOP = 400_000; // expected hits every 16384 salts

    /// @notice Reverts when no salt gives a hook address with the required flags.
    error SaltNotFound();

    /// @param deployer the address that will run CREATE2 (a factory, or the deploying contract itself)
    /// @param creationCodeWithArgs `abi.encodePacked(type(ODHook).creationCode, abi.encode(constructor args))`
    function find(address deployer, bytes memory creationCodeWithArgs)
        internal
        view
        returns (address hook, bytes32 salt)
    {
        bytes32 initHash = keccak256(creationCodeWithArgs);
        for (uint256 i; i < MAX_LOOP; ++i) {
            hook = computeAddress(deployer, bytes32(i), initHash);
            if (uint160(hook) & Hooks.ALL_HOOK_MASK == FLAGS && hook.code.length == 0) return (hook, bytes32(i));
        }
        revert SaltNotFound();
    }

    function computeAddress(address deployer, bytes32 salt, bytes32 initHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash)))));
    }
}

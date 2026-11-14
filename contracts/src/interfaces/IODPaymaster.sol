// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

/// ERC-4337 v0.7 paymaster surface plus the Overdrive admin functions.
interface IODPaymaster {
    enum PostOpMode {
        opSucceeded,
        opReverted,
        postOpReverted
    }
    /// @notice Validates a user operation for sponsorship.
    /// @dev Called by the ERC-4337 EntryPoint only. Checks the sponsor signature, the limits and the pause state.
    /// @param userOp The ERC-4337 packed user operation.
    /// @param userOpHash Hash of the user operation.
    /// @param maxCost Maximum gas cost the operation may incur, in wei.
    /// @return context  Opaque context returned by validation.
    /// @return validationData  The validation data.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData);
    /// @notice Settles the sponsorship after the operation.
    /// @dev Called by the ERC-4337 EntryPoint only.
    /// @param mode Whether the operation succeeded or reverted.
    /// @param context Opaque context returned by validation.
    /// @param actualGasCost Actual gas cost of the operation, in wei.
    /// @param actualUserOpFeePerGas Effective fee per gas of the operation.
    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external;
    /// @notice Emitted when the sponsoring signer changes.
    /// @param signer Address of the signer.
    event SignerChanged(address indexed signer);
    /// @notice Emitted when the sponsorship limits change.
    /// @param maxCostPerOp Largest gas cost sponsored for a single operation, in wei.
    /// @param accountDailyCap Daily sponsored gas cap per account, in wei.
    /// @param globalDailyCap Daily sponsored gas cap for all accounts, in wei.
    event LimitsChanged(uint256 maxCostPerOp, uint256 accountDailyCap, uint256 globalDailyCap);
    /// @notice Emitted when sponsorship is paused or unpaused.
    /// @param paused True to pause, false to unpause.
    event PausedChanged(bool paused);
    /// @notice Sets the sponsoring signer.
    /// @dev Owner only.
    /// @param signer Address of the signer.
    function setSigner(address signer) external;
    /// @notice Sets the sponsorship limits.
    /// @dev Owner only.
    /// @param maxCostPerOp Largest gas cost sponsored for a single operation, in wei.
    /// @param accountDailyCap Daily sponsored gas cap per account, in wei.
    /// @param globalDailyCap Daily sponsored gas cap for all accounts, in wei.
    function setLimits(uint256 maxCostPerOp, uint256 accountDailyCap, uint256 globalDailyCap) external;
    /// @notice Pauses or unpauses sponsorship.
    /// @dev The guardian pauses; the owner (timelock) unpauses.
    /// @param paused True to pause, false to unpause.
    function setPaused(bool paused) external; // guardian pauses, owner (timelock) unpauses
    // The hash the sponsoring signer signs as an EIP-191 personal message (todo 10 R7, vector in paymaster-hash.json).
    /// @notice Returns the hash the sponsoring signer signs as an EIP-191 personal message.
    /// @param userOp The ERC-4337 packed user operation.
    /// @param validUntil Latest time the approval is valid.
    /// @param validAfter Earliest time the approval is valid.
    /// @return  The hash to sign.
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        external
        view
        returns (bytes32);
}

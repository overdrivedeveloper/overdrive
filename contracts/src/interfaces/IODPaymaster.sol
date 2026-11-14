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
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData);
    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external;
    event SignerChanged(address indexed signer);
    event LimitsChanged(uint256 maxCostPerOp, uint256 accountDailyCap, uint256 globalDailyCap);
    event PausedChanged(bool paused);
    function setSigner(address signer) external;
    function setLimits(uint256 maxCostPerOp, uint256 accountDailyCap, uint256 globalDailyCap) external;
    function setPaused(bool paused) external; // guardian pauses, owner (timelock) unpauses
    // The hash the sponsoring signer signs as an EIP-191 personal message (todo 10 R7, vector in paymaster-hash.json).
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        external
        view
        returns (bytes32);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// DEFAULT_ADMIN_ROLE is held by the TimelockController (48 h delay).
library ODRoles {
    bytes32 internal constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 internal constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 internal constant HEDGER_ROLE = keccak256("HEDGER_ROLE");
    /// Reserved, unused unless sealed-batch liquidation needs a dedicated caller class.
    bytes32 internal constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");
}

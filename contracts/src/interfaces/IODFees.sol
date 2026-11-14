// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODFees {
    /// @notice Emitted when a fee is notified; kind is SPREAD, TOLL or BACKER_TOLL.
    /// @param kind Kind tag (bytes32).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param usdg Amount of USDG, in 6-decimal units.
    event Notified(bytes32 indexed kind, bytes32 indexed gearId, uint256 usdg); // kind: "SPREAD","TOLL","BACKER_TOLL"
    /// @notice Emitted when pending fees are distributed.
    /// @param amount The amount, in the units of the asset concerned.
    /// @param toGovernor Amount sent to the Governor.
    /// @param toExitReserve Amount sent to the exit reserve.
    /// @param toKeepers Amount sent to keepers.
    /// @param toHedgers Amount sent to hedgers.
    /// @param toTreasury Amount sent to the treasury.
    /// @param toStakers Amount sent to stakers.
    /// @param toBurn Amount sent to the burn.
    event Distributed(
        uint256 amount,
        uint256 toGovernor,
        uint256 toExitReserve,
        uint256 toKeepers,
        uint256 toHedgers,
        uint256 toTreasury,
        uint256 toStakers,
        uint256 toBurn
    );
    /// @notice Emitted when an amount is held in a bucket because no recipient is set.
    /// @param bucket Fee bucket tag (bytes32).
    /// @param amount The amount, in the units of the asset concerned.
    event Held(bytes32 indexed bucket, uint256 amount);
    /// @notice Emitted when the recipient of a bucket is set.
    /// @param bucket Fee bucket tag (bytes32).
    /// @param recipient The address that receives the output.
    event RecipientSet(bytes32 indexed bucket, address recipient);
    /// @notice Emitted when the top-level split changes.
    /// @param opsBps Operations share, in basis points.
    /// @param treasuryBps Treasury share, in basis points.
    /// @param stakersBps Stakers share, in basis points.
    /// @param burnBps Burn share, in basis points.
    event SplitSet(uint16 opsBps, uint16 treasuryBps, uint16 stakersBps, uint16 burnBps);
    /// @notice Emitted when the split of the operations part changes.
    /// @param governorBps Governor share of the operations part, in basis points.
    /// @param exitReserveBps Exit reserve share of the operations part, in basis points.
    /// @param keepersBps Keepers share of the operations part, in basis points.
    /// @param hedgersBps Hedgers share of the operations part, in basis points.
    event OpsSplitSet(uint16 governorBps, uint16 exitReserveBps, uint16 keepersBps, uint16 hedgersBps);
    /// @notice Reverts when distribute is called before the next distribution time.
    /// @param nextAt Earliest timestamp at which the action is allowed.
    error TooEarly(uint256 nextAt);
    /// @notice Reverts when split parameters are invalid.
    error InvalidParams();
    /// @notice Records a fee that the caller has already transferred.
    /// @dev Governor or Backer only.
    /// @param kind Kind tag (bytes32).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param usdg Amount of USDG, in 6-decimal units.
    function notify(bytes32 kind, bytes32 gearId, uint256 usdg) external; // caller has transferred first; Governor/Backer only
    /// @notice Distributes pending fees across the buckets.
    /// @dev Anyone may call, once per 7 days (TooEarly otherwise).
    /// @return amount  amount=The amount distributed.
    function distribute() external returns (uint256 amount); // anyone, once per 7 days
    /// @notice Emitted when USDG that arrived without a notify is booked as pending.
    /// @param usdg Amount of USDG, in 6-decimal units.
    event Synced(uint256 usdg);
    /// @notice Books USDG that arrived without a notify as pending.
    /// @dev Anyone may call.
    /// @return usdg  usdg=The amount newly booked.
    function sync() external returns (uint256 usdg); // anyone: books USDG that arrived without a notify as pending (L-3)
    /// @notice Returns the amount a distribute call would split now.
    /// @return  The resulting value.
    function distributable() external view returns (uint256);
    /// @notice Returns the earliest time of the next distribution.
    /// @return  Unix timestamp.
    function nextDistributionAt() external view returns (uint256);
    /// @notice Returns the protocol share of the spread.
    /// @return  Basis points (default 1000).
    function protocolSpreadShareBps() external view returns (uint16); // default 1000
    /// @notice Returns the toll fee rate.
    /// @return  Basis points (default 1000).
    function tollFeeBps() external view returns (uint16); // default 1000
}

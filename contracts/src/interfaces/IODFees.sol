// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODFees {
    event Notified(bytes32 indexed kind, bytes32 indexed gearId, uint256 usdg); // kind: "SPREAD","TOLL","BACKER_TOLL"
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
    event Held(bytes32 indexed bucket, uint256 amount);
    event RecipientSet(bytes32 indexed bucket, address recipient);
    event SplitSet(uint16 opsBps, uint16 treasuryBps, uint16 stakersBps, uint16 burnBps);
    event OpsSplitSet(uint16 governorBps, uint16 exitReserveBps, uint16 keepersBps, uint16 hedgersBps);
    error TooEarly(uint256 nextAt);
    error InvalidParams();
    function notify(bytes32 kind, bytes32 gearId, uint256 usdg) external; // caller has transferred first; Governor/Backer only
    function distribute() external returns (uint256 amount); // anyone, once per 7 days
    event Synced(uint256 usdg);
    function sync() external returns (uint256 usdg); // anyone: books USDG that arrived without a notify as pending (L-3)
    function distributable() external view returns (uint256);
    function nextDistributionAt() external view returns (uint256);
    function protocolSpreadShareBps() external view returns (uint16); // default 1000
    function tollFeeBps() external view returns (uint16); // default 1000
}

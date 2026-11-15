// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Ghost state the system handler records on every action; the invariants in SystemInvariant.t.sol read it.
/// Counters named `...Violations`, `...Mismatches` or `...Gated` must stay 0; the rest are coverage evidence.
abstract contract Ghosts {
    // ---------------------------------------------------------------------------------------- coverage
    bytes32[] internal _actions;
    mapping(bytes32 action => uint256) public callsOf;
    mapping(bytes32 action => uint256) public revertsOf;
    uint256 public totalCalls;

    // ---------------------------------------------------------------------------------------- R1 holders exit
    uint256 public r1Checked; // holder sells of value <= exit reserve, reserve >= floor, both prices present
    uint256 public r1Violations; // ...that still ended in UseQueue

    // ---------------------------------------------------------------------------------------- R2 holder balances
    /// Each holder's balance per gear token as implied by the holder's own trades and queue actions only.
    mapping(address holder => mapping(address token => uint256)) public expectedBal;

    // ---------------------------------------------------------------------------------------- R3 quote = execution
    uint256 public quoteChecks;
    uint256 public quoteMismatches;
    bytes32 public lastMismatch;

    // ---------------------------------------------------------------------------------------- R4 exits never gated
    uint256 public exitsGated; // sell, queue cancel, backer repay/deposit or Governor claim refused for another reason
    bytes32 public lastGatedAction;
    bytes4 public lastGatedSelector;
    uint256 public sellUseQueue; // the only allowed sell refusal (no reference / no cash), counted apart
    uint256 public claimHedgeStale; // the only allowed claim refusal
    uint256 public hookSellsOverPmBalance; // hook sells larger than the PoolManager's gear balance, sent direct

    // ---------------------------------------------------------------------------------------- R5 escrow
    mapping(address token => uint256) public escrowOf; // gear tokens the minter must hold for open tickets
    mapping(address target => uint256) public donatedUsdg;

    // ---------------------------------------------------------------------------------------- R7 NF
    uint256 public nfViolations;
    bytes32 public lastNfViolation;

    // ---------------------------------------------------------------------------------------- R8 exit reserve
    uint256 public reserveViolations;
    uint256 public reserveDrawn; // total exit reserve decrease
    uint256 public reservePaidToHolders; // of which inside a holder payout of at least that size
    uint256 internal _holderPaidThisCall;

    // ---------------------------------------------------------------------------------------- M-7 below-zero sells
    mapping(uint256 vaultId => uint256) public ghostOwnOf; // I4-1: wallet-minted debt still open, per vault
    mapping(bytes32 gear => uint256) public ghostOwnGear; // ...and per gear (the sum)
    uint256 public usdgRepays; // successful repayWithUsdg calls of the I4-1 step
    uint256 public m7Crossing; // checked sells with a share below the wallet-minted debt (the branch M-7 exists for)
    uint256 public liveChecked; // S18: holder sells wholly above the wallet-minted debt with the cash to pay them in reach
    uint256 public liveViolations; // ...that were queued all the same
    uint256 public ownMints; // successful mints to an owner's wallet
    uint256 public lockCeilingViolations; // M-8: ...that left the locks above the ceiling
    uint256 public m7Checked; // successful minter sells (holder, backer, queue fill) checked
    uint256 public m7BelowZero; // ...that left the gear's net below zero
    uint256 public m7BelowZeroDirect; // ...of which wholly above the own-minted debt (paid like any sell)
    uint256 public m7DrawViolations; // reserve + insurance drawn beyond the share above the own-minted debt
    uint256 public m7LockViolations; // a sell raised a backer sale lock or took more from it than its share
    uint256 public backerSells; // successful sells of backer-minted tokens by the vault owner
    uint256 public backerSellsRefused; // ...refused UseQueue (below-zero share over the lock plus free cash)

    // ---------------------------------------------------------------------------------------- R9 donations
    uint256 public donationChecks;
    uint256 public donationEffects;
    bytes32 public lastDonationEffect;

    // ---------------------------------------------------------------------------------------- R11 pauses
    uint256 public guardianPauses;
    uint256 public timelockUnpauses;
    uint256 public nonTimelockUnpauses; // a successful unpause call by anyone but the timelock

    // ---------------------------------------------------------------------------------------- R12 fees
    uint256 public feesNotified;
    uint256 public feesPaidOut;
    uint256 public feeViolations;
    uint256 public feeDoubleBooked; // F12-1: USDG booked both as pending and as held by distribute (see handler)

    // ---------------------------------------------------------------------------------------- liquidation stats
    uint256 public batchesSealed;
    uint256 public batchesExecuted;
    uint256 public vaultsLiquidated;

    function actionCount() external view returns (uint256) {
        return _actions.length;
    }

    function actionAt(uint256 i) external view returns (bytes32) {
        return _actions[i];
    }

    function _count(bytes32 action, bool ok) internal {
        if (callsOf[action] == 0) _actions.push(action);
        ++callsOf[action];
        if (!ok) ++revertsOf[action];
        ++totalCalls;
    }

    function _mismatch(bytes32 what) internal {
        ++quoteMismatches;
        lastMismatch = what;
    }

    function _gated(bytes32 action, bytes memory err) internal {
        ++exitsGated;
        lastGatedAction = action;
        lastGatedSelector = err.length >= 4 ? bytes4(err) : bytes4(0);
    }

    function _sel(bytes memory err) internal pure returns (bytes4) {
        return err.length >= 4 ? bytes4(err) : bytes4(0);
    }
}

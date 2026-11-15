// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IODGovernor} from "../interfaces/IODGovernor.sol";

/// @title ODSaleCredit
/// @notice A vault's sale credit (I6-1): the proceeds of debt sold to the Governor, which never leave the Governor.
/// They are part of the vault's collateral, cannot be withdrawn while held, and are locked behind the sold debt. The
/// lock falls as that debt is repaid or liquidated; the Governor then pays the unlocked part from its free cash, as
/// far as that goes. External library (delegatecall) so ODBacker stays under 24,576 bytes: the calls to the Governor
/// are made as ODBacker.
/// @dev Units: USDG 6 dp, gear tokens 18 dp. Every function returns the USDG that left the vault's credit, for
/// ODBacker's total (totalHeld).
library ODSaleCredit {
    /// `usdg`: the vault's collateral held by the Governor. `locked`: the part of it locked behind sold debt.
    struct Held {
        uint256 usdg;
        uint256 locked;
    }

    /// @notice Settles a vault's credit after its sold debt (debt not minted to the owner's wallet) fell from
    /// `soldBefore` to `sold`, and after `cancel` of the credit paid a buy-back (the Governor keeps that USDG).
    /// @dev The lock falls in proportion to the sold debt (Ceil: rounds toward staying locked; all of it once no sold
    /// debt is left) and never passes the credit left. The unlocked part is asked of the Governor, which pays it from
    /// free cash only, as far as that goes; what it does not pay stays held, unlocked, and is asked again at the next
    /// call (ODBacker.withdraw calls this with `sold` equal to `soldBefore`).
    /// @param h The vault's credit.
    /// @param gov The Governor.
    /// @param sold The vault's sold debt now, in gear tokens.
    /// @param soldBefore The vault's sold debt before the repay, in gear tokens.
    /// @param cancel Credit used up with no payment (at most the credit held), in USDG.
    /// @return out USDG that left the credit: `cancel` plus what the Governor paid to the caller.
    function settle(Held storage h, IODGovernor gov, uint256 sold, uint256 soldBefore, uint256 cancel)
        external
        returns (uint256 out)
    {
        uint256 held = h.usdg;
        if (held == 0) return 0;
        uint256 locked = h.locked;
        if (sold < soldBefore) locked = Math.mulDiv(locked, sold, soldBefore, Math.Rounding.Ceil);
        held -= cancel;
        if (locked > held) locked = held;
        h.locked = locked;
        if (held != locked || cancel != 0) out = gov.settleSaleCredit(held - locked, cancel);
        h.usdg = held - out;
        out += cancel;
    }

    /// @notice Pays up to `want` of a toll fee out of the vault's credit, locked or not (a fee lowers collateral).
    /// @dev Never reverts: a Governor that refuses pays nothing. The lock never passes the credit left.
    /// @param h The vault's credit.
    /// @param gov The Governor.
    /// @param want USDG wanted (at most the credit held).
    /// @return got USDG the Governor paid to the caller from its free cash.
    function payFee(Held storage h, IODGovernor gov, uint256 want) external returns (uint256 got) {
        try gov.settleSaleCredit(want, 0) returns (uint256 p) {
            got = p;
        } catch {}
        uint256 held = h.usdg - got;
        h.usdg = held;
        if (h.locked > held) h.locked = held;
    }

    /// @notice Uses a liquidated vault's credit: first for the Governor's share (cancelled, no transfer), then it
    /// stays with the vault as its surplus (unlocked), and only the rest is asked of the Governor's free cash, for
    /// the executor's bonus.
    /// @dev When free cash is short the Governor keeps the unpaid part and the bonus is smaller by it (`unpaid`).
    /// @param h The vault's credit.
    /// @param gov The Governor.
    /// @param toGovernor The Governor's share of the collateral, in USDG.
    /// @param surplus The collateral that returns to the vault, in USDG.
    /// @return cancel Credit that paid the Governor's share (transfer that much less).
    /// @return unpaid Credit the bonus needed and free cash could not pay (pay that much less bonus).
    /// @return out USDG that left the credit.
    function seize(Held storage h, IODGovernor gov, uint256 toGovernor, uint256 surplus)
        external
        returns (uint256 cancel, uint256 unpaid, uint256 out)
    {
        uint256 held = h.usdg;
        if (held == 0) return (0, 0, 0);
        cancel = Math.min(held, toGovernor);
        uint256 keep = Math.min(held - cancel, surplus);
        uint256 want = held - cancel - keep;
        uint256 paid = gov.settleSaleCredit(want, cancel);
        if (paid < want) {
            unpaid = want - paid;
            gov.settleSaleCredit(0, unpaid);
        }
        h.usdg = keep;
        h.locked = 0;
        out = held - keep;
    }
}

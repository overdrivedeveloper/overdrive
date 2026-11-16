// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test double with the same function and error signatures as ODMinter, ODGovernor and ODBacker (exit calls only).
// It records what it decoded in events, so the test can prove the page's encoder produced the right bytes.
contract MockExit {
    error UseQueue();
    error ClaimBelowMin(uint256 paidUsdg, uint256 minAssetsOut);
    error HedgeStale();
    event SellSeen(bytes32 gearId, uint256 tokens, uint256 minOut, address recipient, uint64 deadline);
    event QueueSeen(bytes32 gearId, uint256 tokens, uint256 minOut, address recipient);
    event ClaimSeen(uint256 ticket, uint256 minAssetsOut);
    event RepaySeen(uint256 vaultId, uint256 tokens);
    event WithdrawSeen(uint256 vaultId, uint256 usdg, address to);

    function sell(bytes32 g, uint256 t, uint256 m, address r, uint64 d) external returns (uint256) {
        if (t == 999e18) revert UseQueue();
        emit SellSeen(g, t, m, r, d);
        return 1;
    }

    function queueSell(bytes32 g, uint256 t, uint256 m, address r) external returns (uint256) {
        emit QueueSeen(g, t, m, r);
        return 1;
    }

    function claim(uint256 ticket, uint256 minAssetsOut) external returns (uint256) {
        if (minAssetsOut == 0) revert HedgeStale(); // the hedge report is always late here
        if (minAssetsOut > 1000e6) revert ClaimBelowMin(5e6, minAssetsOut);
        emit ClaimSeen(ticket, minAssetsOut);
        return 5e6;
    }

    function previewRedeem(uint256) external pure returns (uint256) {
        return 5e6;
    }

    function freeCash() external pure returns (uint256) {
        return 1000e6;
    }

    function hedgeStale() external pure returns (bool) {
        return true;
    }

    function repay(uint256 v, uint256 t) external {
        emit RepaySeen(v, t);
    }

    function withdraw(uint256 v, uint256 u, address to) external {
        emit WithdrawSeen(v, u, to);
    }
}

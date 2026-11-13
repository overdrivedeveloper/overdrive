// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./ODTypes.sol";

interface IODMinter {
    event Bought(
        bytes32 indexed gearId,
        address indexed payer,
        address indexed recipient,
        uint256 usdgIn,
        uint256 tokensOut,
        uint256 valuePerTokenWad,
        uint16 spreadBps,
        bool viaHook
    );
    event Sold(
        bytes32 indexed gearId,
        address indexed seller,
        address indexed recipient,
        uint256 tokensIn,
        uint256 usdgOut,
        uint256 valuePerTokenWad,
        uint16 spreadBps,
        bool viaHook,
        Session session
    );
    event SellQueued(
        uint256 indexed ticket, bytes32 indexed gearId, address indexed owner, uint256 tokens, uint256 minUsdgOut
    );
    event QueueFilled(uint256 indexed ticket, uint256 usdgOut, uint256 valuePerTokenWad);
    event QueueCancelled(uint256 indexed ticket);
    event Accrued(bytes32 indexed gearId, uint256 nf, int256 tollPerSecWad, uint256 dt, uint256 tollValueUsdWad);
    event GearSettled(bytes32 indexed gearId, uint256 finalValuePerTokenWad);
    error Expired();
    error Slippage(uint256 got, uint256 limit);
    error BuysClosed(bytes32 gearId, bytes32 reason);
    error BelowMinimum();
    error UseQueue(); // sell cannot be paid now (closed with no reference, payout failed): call queueSell
    error NotHook();
    error NotTicketOwner(uint256 ticket);
    error NotFillable(uint256 ticket);
    function buy(bytes32 gearId, uint256 usdgIn, uint256 minTokensOut, address recipient, uint64 deadline)
        external
        returns (uint256 tokensOut);
    function buyExactTokens(bytes32 gearId, uint256 tokensOut, uint256 maxUsdgIn, address recipient, uint64 deadline)
        external
        returns (uint256 usdgIn);
    function sell(bytes32 gearId, uint256 tokensIn, uint256 minUsdgOut, address recipient, uint64 deadline)
        external
        returns (uint256 usdgOut);
    function sellForExactUsdg(bytes32 gearId, uint256 usdgOut, uint256 maxTokensIn, address recipient, uint64 deadline)
        external
        returns (uint256 tokensIn);
    function queueSell(bytes32 gearId, uint256 tokens, uint256 minUsdgOut, address recipient)
        external
        returns (uint256 ticket);
    function fillQueued(uint256 ticket) external returns (uint256 usdgOut); // anyone, at the next fresh price
    function cancelQueued(uint256 ticket) external; // ticket owner, never blocked
    // hook path: the hook has already moved currencies with the PoolManager; see todo 06a for the sequence
    function hookSwap(bytes32 gearId, bool isBuy, bool exactIn, uint256 amount, address tokenSink)
        external
        returns (uint256 amountIn, uint256 amountOut);
    function quote(bytes32 gearId, bool isBuy, bool exactIn, uint256 amount) external view returns (Quote memory);
    function accrue(bytes32 gearId) external returns (uint256 nf);
    function accrueMany(bytes32[] calldata gearIds) external;
    function settleGear(bytes32 gearId) external; // admin (timelock): feed halted >= 30 days or index out of domain
    function valuePerToken(bytes32 gearId) external view returns (uint256 valueWad, bool inDomain);
    function normState(bytes32 gearId) external view returns (NormState memory);
    function tollPerDay(bytes32 gearId) external view returns (int256 tollWad);
    function queuedSell(uint256 ticket)
        external
        view
        returns (bytes32 gearId, address owner, address recipient, uint256 tokens, uint256 minUsdgOut);
}

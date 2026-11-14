// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {GearStatus, NormState, Quote, Session} from "../interfaces/ODTypes.sol";
import {IODMinter} from "../interfaces/IODMinter.sol";
import {IODGear} from "../interfaces/IODGear.sol";
import {IODGovernor} from "../interfaces/IODGovernor.sol";
import {IODGearRegistry} from "../interfaces/IODGearRegistry.sol";
import {IODOracleGuard} from "../interfaces/IODOracleGuard.sol";
import {IODVolOracle} from "../interfaces/IODVolOracle.sol";
import {IODFees} from "../interfaces/IODFees.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";
import {ODMinterPricing as P} from "./ODMinterPricing.sol";

/// @title ODMinter
/// @notice Buys and sells gear tokens against the Governor's house book at value +/- spread, accrues each gear's
/// normalisation factor (the toll), queues sells that cannot be paid now and settles a gear after a long halt.
/// @dev Rules (todo 05b): every trade accrues first (R2); buys need a live, fresh, in-band reading, an in-domain
/// index, a usable vol post and the Governor's gate (R3); sells are never gated by status, pause or session (R6) but
/// never price off one source alone: no reference means `UseQueue` (R8, ORC-FAILCLOSED). One pricing path
/// (ODMinterPricing) serves quote and execution, so a quote equals execution to the wei (QUOTE-1).
/// Money order: buys move USDG payer -> Governor, mint, then `onBuy` (which checks the USDG arrived); sells check
/// `canPay`, burn, `onSell`, then `pay` (false reverts `UseQueue`, undoing the burn). Fees are booked and paid by the
/// Governor (it notifies ODFees only after the USDG moved).
contract ODMinter is AccessControl, ReentrancyGuardTransient, IODMinter {
    using SafeERC20 for IERC20;

    uint256 private constant STAKE_READ_GAS = 50_000;
    uint256 private constant BPS = 10_000;

    IERC20 public immutable usdg;
    IODGearRegistry public immutable registry;
    IODOracleGuard public immutable guard;
    IODVolOracle public immutable vol;
    IODGovernor public immutable governor;
    address public immutable fees;

    address public hook;
    address public poolManager;
    address public stake;
    uint256 public ticketCount;

    TradeParams private _tp;
    mapping(bytes32 gearId => NormState) private _norm;
    mapping(bytes32 gearId => uint64) private _sigma;
    mapping(bytes32 gearId => uint256) private _settled;

    struct Ticket {
        bytes32 gearId;
        address owner;
        address recipient;
        uint128 tokens;
        uint128 minUsdgOut;
    }

    mapping(uint256 => Ticket) private _tickets;

    constructor(
        IERC20 usdg_,
        address admin,
        address guardian,
        IODGearRegistry registry_,
        IODOracleGuard guard_,
        IODVolOracle vol_,
        IODGovernor governor_,
        address fees_
    ) {
        if (
            address(usdg_) == address(0) || admin == address(0) || guardian == address(0)
                || address(registry_) == address(0) || address(guard_) == address(0) || address(vol_) == address(0)
                || address(governor_) == address(0) || fees_ == address(0)
        ) revert ZeroAddress();
        usdg = usdg_;
        registry = registry_;
        guard = guard_;
        vol = vol_;
        governor = governor_;
        fees = fees_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ODRoles.GUARDIAN_ROLE, guardian);
        _tp = TradeParams({
            extendedSpreadMultBps: 15_000,
            closedSellExtraBps: 50,
            inventorySlopeBps: 100,
            maxSkewBps: 150,
            maxTotalSpreadBps: 500,
            minTradeUsdg: 1e6,
            usageMaxWad: 0.05e18,
            settleAfterHalt: 30 days,
            lagBandBps: 50
        });
    }

    // ================================================================================================ admin

    /// @inheritdoc IODMinter
    function setHook(address hook_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (hook != address(0)) revert AlreadySet();
        if (hook_ == address(0)) revert ZeroAddress();
        (bool ok, bytes memory data) = hook_.staticcall(abi.encodeWithSignature("poolManager()"));
        if (!ok || data.length < 32) revert ZeroAddress();
        address pm = abi.decode(data, (address));
        if (pm == address(0)) revert ZeroAddress();
        hook = hook_;
        poolManager = pm;
        emit HookSet(hook_, pm);
    }

    /// @inheritdoc IODMinter
    function setStake(address stake_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        stake = stake_;
        emit StakeSet(stake_);
    }

    /// @inheritdoc IODMinter
    function setTradeParams(TradeParams calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            p.extendedSpreadMultBps < BPS || p.extendedSpreadMultBps > 3 * BPS || p.closedSellExtraBps > 500
                || p.maxSkewBps > 500 || p.maxTotalSpreadBps > 1000 || p.maxTotalSpreadBps == 0 || p.minTradeUsdg == 0
                || p.minTradeUsdg > 1_000e6 || p.usageMaxWad > 0.2e18 || p.settleAfterHalt < 7 days
                || p.settleAfterHalt > 365 days || p.lagBandBps == 0 || p.lagBandBps > 300
        ) revert InvalidParams();
        _tp = p;
        emit TradeParamsSet(p);
    }

    // ================================================================================================ trades

    /// @inheritdoc IODMinter
    function buy(bytes32 gearId, uint256 usdgIn, uint256 minTokensOut, address recipient, uint64 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        _checkCall(recipient, deadline);
        tokensOut = _buy(gearId, true, usdgIn, minTokensOut, msg.sender, recipient, msg.sender).tokens;
    }

    /// @inheritdoc IODMinter
    function buyExactTokens(bytes32 gearId, uint256 tokensOut, uint256 maxUsdgIn, address recipient, uint64 deadline)
        external
        nonReentrant
        returns (uint256 usdgIn)
    {
        _checkCall(recipient, deadline);
        usdgIn = _buy(gearId, false, tokensOut, maxUsdgIn, msg.sender, recipient, msg.sender).usdg;
    }

    /// @inheritdoc IODMinter
    function sell(bytes32 gearId, uint256 tokensIn, uint256 minUsdgOut, address recipient, uint64 deadline)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        _checkCall(recipient, deadline);
        P.Ctx memory c = _loadKnown(gearId);
        usdgOut = _sell(c, true, tokensIn, minUsdgOut, msg.sender, recipient, msg.sender, false, 0).usdg;
    }

    /// @inheritdoc IODMinter
    function sellForExactUsdg(bytes32 gearId, uint256 usdgOut, uint256 maxTokensIn, address recipient, uint64 deadline)
        external
        nonReentrant
        returns (uint256 tokensIn)
    {
        _checkCall(recipient, deadline);
        P.Ctx memory c = _loadKnown(gearId);
        tokensIn = _sell(c, false, usdgOut, maxTokensIn, msg.sender, recipient, msg.sender, false, 0).tokens;
    }

    /// @inheritdoc IODMinter
    /// @dev Any session, any status but NONE. The tokens move into this contract's escrow: supply is unchanged, so they
    /// still count as a Governor liability and keep paying the toll until filled or cancelled.
    function queueSell(bytes32 gearId, uint256 tokens, uint256 minUsdgOut, address recipient)
        external
        nonReentrant
        returns (uint256 ticket)
    {
        if (recipient == address(0)) revert ZeroAddress();
        address token = registry.gear(gearId).token;
        if (token == address(0)) revert UnknownGear(gearId);
        if (tokens == 0 || tokens > type(uint128).max) revert BelowMinimum();
        if (minUsdgOut > type(uint128).max) revert InvalidParams();
        IODGear(token).burn(msg.sender, tokens);
        IODGear(token).mint(address(this), tokens);
        ticket = ++ticketCount;
        _tickets[ticket] = Ticket({
            gearId: gearId,
            owner: msg.sender,
            recipient: recipient,
            tokens: uint128(tokens),
            minUsdgOut: uint128(minUsdgOut)
        });
        emit SellQueued(ticket, gearId, msg.sender, tokens, minUsdgOut);
    }

    /// @inheritdoc IODMinter
    /// @dev Anyone, only on a live fresh reading with a reference (or once settled), priced exactly as a live sell
    /// for the ticket's owner. Any failure reverts NotFillable and the ticket stays.
    function fillQueued(uint256 ticket) external nonReentrant returns (uint256 usdgOut) {
        Ticket memory t = _tickets[ticket];
        if (t.tokens == 0) revert NotFillable(ticket);
        P.Ctx memory c = _load(t.gearId);
        if (!c.settled && !(c.live && c.r.refP != 0)) revert NotFillable(ticket);
        delete _tickets[ticket];
        P.Trade memory tr = _sell(c, true, t.tokens, t.minUsdgOut, address(this), t.recipient, t.owner, false, ticket);
        usdgOut = tr.usdg;
        emit QueueFilled(ticket, usdgOut, tr.value);
    }

    /// @inheritdoc IODMinter
    function cancelQueued(uint256 ticket) external nonReentrant {
        Ticket memory t = _tickets[ticket];
        if (t.tokens == 0 || t.owner != msg.sender) revert NotTicketOwner(ticket);
        delete _tickets[ticket];
        address token = registry.gear(t.gearId).token;
        IODGear(token).burn(address(this), t.tokens);
        IODGear(token).mint(t.owner, t.tokens);
        emit QueueCancelled(ticket);
    }

    /// @inheritdoc IODMinter
    /// @dev Hook only. Buys mint to `tokenSink` (the PoolManager); the hook has already sent the USDG to the Governor
    /// (onBuy checks it). Sells burn from `tokenSink` (the hook) and pay the PoolManager. No discount, no limits (the
    /// PoolManager applies the swapper's).
    function hookSwap(bytes32 gearId, bool isBuy, bool exactIn, uint256 amount, address tokenSink)
        external
        nonReentrant
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (msg.sender != hook || hook == address(0)) revert NotHook();
        if (tokenSink == address(0)) revert ZeroAddress();
        if (isBuy) {
            P.Trade memory t =
                _buy(gearId, exactIn, amount, exactIn ? 0 : type(uint256).max, address(0), tokenSink, address(0));
            (amountIn, amountOut) = (t.usdg, t.tokens);
        } else {
            P.Ctx memory c = _loadKnown(gearId);
            P.Trade memory t =
                _sell(c, exactIn, amount, exactIn ? 0 : type(uint256).max, tokenSink, poolManager, address(0), true, 0);
            (amountIn, amountOut) = (t.tokens, t.usdg);
        }
    }

    // ================================================================================================ accrual

    /// @inheritdoc IODMinter
    /// @dev Permissionless, a no-op in the same second, never reverts (an unknown gear returns 0).
    function accrue(bytes32 gearId) external nonReentrant returns (uint256 nf) {
        P.Ctx memory c = _load(gearId);
        if (c.cfg.token == address(0)) return 0;
        _commit(c);
        nf = c.nfNew;
    }

    /// @inheritdoc IODMinter
    function accrueMany(bytes32[] calldata gearIds) external nonReentrant {
        for (uint256 i; i < gearIds.length; ++i) {
            P.Ctx memory c = _load(gearIds[i]);
            if (c.cfg.token != address(0)) _commit(c);
        }
    }

    /// @inheritdoc IODMinter
    /// @dev Admin (timelock): the market (either leg of a pair) halted for >= settleAfterHalt, or the index out of
    /// domain. Final value = value at the last good price, Floor; NF stops. The registry status is set to SETTLED in
    /// the same call when this contract may (else the timelock batch sets it); this contract treats the gear as
    /// settled either way.
    function settleGear(bytes32 gearId) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        P.Ctx memory c = _loadKnown(gearId);
        if (c.settled) revert NotSettleable(gearId);
        _commit(c);
        (uint256 v, bool inDomain) = P.valueAt(c.cfg, c.r.p, c.nfNew);
        if (inDomain && !_haltedLong(c.cfg.marketA, c.cfg.marketB)) revert NotSettleable(gearId);
        if (v == 0) v = 1;
        _settled[gearId] = v;
        emit GearSettled(gearId, v);
        try registry.setStatus(gearId, GearStatus.SETTLED) {} catch {}
    }

    // ================================================================================================ backer

    /// @inheritdoc IODMinter
    /// @dev The Governor's backer only (07a): tokens of a backer mint that the vault owner keeps.
    function backerMint(bytes32 gearId, address to, uint256 tokens) external nonReentrant {
        IODGear(_backerToken(gearId)).mint(to, tokens);
    }

    /// @inheritdoc IODMinter
    /// @dev The Governor's backer only (07a): burns a repayer's own tokens against a vault's debt.
    function backerBurn(bytes32 gearId, address from, uint256 tokens) external nonReentrant {
        IODGear(_backerToken(gearId)).burn(from, tokens);
    }

    function _backerToken(bytes32 gearId) private view returns (address token) {
        address b = governor.backer();
        if (msg.sender != b || b == address(0)) revert NotBacker();
        token = registry.gear(gearId).token;
        if (token == address(0)) revert UnknownGear(gearId);
    }

    // ================================================================================================ views

    /// @inheritdoc IODMinter
    /// @dev Simulates the trade's own accrual, the toll fee it settles and the Governor's buy gate and payout check.
    /// The staking discount is read for msg.sender: quote with `from` set to the trader. A blocked buy reverts with
    /// the same error as execution; a sell that would revert UseQueue returns queued = true.
    function quote(bytes32 gearId, bool isBuy, bool exactIn, uint256 amount) external view returns (Quote memory q) {
        P.Ctx memory c = _loadKnown(gearId);
        P.Trade memory t = P.trade(c, _tp, isBuy, exactIn, amount, _discount(msg.sender));
        if (isBuy) {
            bytes32 reason = P.buyGate(_deps(), c, t);
            if (reason != bytes32(0)) revert BuysClosed(gearId, reason);
            if (t.usdg < _tp.minTradeUsdg || t.tokens == 0) revert BelowMinimum();
            (q.amountIn, q.amountOut) = (t.usdg, t.tokens);
        } else {
            q.queued = t.queued || !governor.canPay(t.usdg + c.feeDrain);
            (q.amountIn, q.amountOut) = (t.tokens, t.usdg);
        }
        q.valuePerTokenWad = t.value;
        q.pricePerTokenWad = t.price;
        q.spreadBps = t.spreadBps;
        q.protocolFeeUsdg = t.spreadUsdg * _shareBps() / BPS;
        q.tollPerDayWad = c.rateNew * 1 days;
        q.session = c.r.session;
    }

    /// @inheritdoc IODMinter
    function valuePerToken(bytes32 gearId) external view returns (uint256 valueWad, bool inDomain) {
        uint256 s = _settled[gearId];
        if (s != 0) return (s, true);
        P.Ctx memory c = _load(gearId);
        if (c.cfg.token == address(0)) return (0, false);
        return P.valueAt(c.cfg, c.r.p, c.nfNew);
    }

    /// @inheritdoc IODMinter
    /// @dev nf, toll rate and cumulative toll AS IF accrued now (the stored state plus the pending accrual); the
    /// Governor values the book and runs its buy gate with this NF, so a quote (a view, before the trade's accrual)
    /// and its execution (after it) see the same NF (QUOTE-1). `lastAccrual` stays the last WRITTEN accrual: keepers
    /// age gears on it.
    function normState(bytes32 gearId) external view returns (NormState memory s) {
        s = _norm[gearId];
        if (s.nf == 0) s.nf = 1e18;
        if (_settled[gearId] != 0) return s;
        P.Ctx memory c = _load(gearId);
        if (!c.accrues) return s;
        s.nf = uint128(c.nfNew);
        s.tollPerSecWad = int128(c.rateNew);
        s.cumTollPerTokenWad += c.cumAdd;
    }

    /// @inheritdoc IODMinter
    function tollPerDay(bytes32 gearId) external view returns (int256) {
        if (_settled[gearId] != 0) return 0;
        P.Ctx memory c = _load(gearId);
        return c.rateNew * 1 days;
    }

    /// @inheritdoc IODMinter
    function queuedSell(uint256 ticket)
        external
        view
        returns (bytes32 gearId, address owner, address recipient, uint256 tokens, uint256 minUsdgOut)
    {
        Ticket memory t = _tickets[ticket];
        return (t.gearId, t.owner, t.recipient, t.tokens, t.minUsdgOut);
    }

    /// @inheritdoc IODMinter
    function settledValue(bytes32 gearId) external view returns (uint256) {
        return _settled[gearId];
    }

    /// @inheritdoc IODMinter
    function tradeParams() external view returns (TradeParams memory) {
        return _tp;
    }

    /// @notice The last sigma (bps) the toll used for `gearId` (kept while the vol post is stale).
    function lastSigmaBps(bytes32 gearId) external view returns (uint64) {
        return _sigma[gearId];
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == type(IODMinter).interfaceId || super.supportsInterface(id);
    }

    // ================================================================================================ internals

    function _buy(
        bytes32 gearId,
        bool exactIn,
        uint256 amount,
        uint256 limit,
        address payer,
        address recipient,
        address account
    ) private returns (P.Trade memory t) {
        P.Ctx memory c = _loadKnown(gearId);
        _commit(c);
        t = P.trade(c, _tp, true, exactIn, amount, _discount(account));
        bytes32 reason = P.buyGate(_deps(), c, t);
        if (reason != bytes32(0)) revert BuysClosed(gearId, reason);
        if (t.usdg < _tp.minTradeUsdg || t.tokens == 0) revert BelowMinimum();
        if (exactIn ? t.tokens < limit : t.usdg > limit) revert Slippage(exactIn ? t.tokens : t.usdg, limit);
        if (payer != address(0)) usdg.safeTransferFrom(payer, address(governor), t.usdg);
        IODGear(c.cfg.token).mint(recipient, t.tokens);
        governor.onBuy(gearId, t.tokens, t.usdg, t.spreadUsdg);
        emit Bought(gearId, payer, recipient, t.usdg, t.tokens, t.value, t.spreadBps, payer == address(0));
    }

    /// `from` gives the tokens (burned), `to` gets the USDG. `ticket` != 0 maps every refusal to NotFillable.
    function _sell(
        P.Ctx memory c,
        bool exactIn,
        uint256 amount,
        uint256 limit,
        address from,
        address to,
        address account,
        bool viaHook,
        uint256 ticket
    ) private returns (P.Trade memory t) {
        _commit(c);
        t = P.trade(c, _tp, false, exactIn, amount, _discount(account));
        if (t.queued || !governor.canPay(t.usdg)) _refuse(ticket);
        if (t.tokens == 0) revert BelowMinimum();
        if (exactIn ? t.usdg < limit : t.tokens > limit) {
            if (ticket != 0) revert NotFillable(ticket);
            revert Slippage(exactIn ? t.usdg : t.tokens, limit);
        }
        IODGear(c.cfg.token).burn(from, t.tokens);
        governor.onSell(c.id, t.tokens, t.spreadUsdg);
        if (!governor.pay(to, t.usdg)) _refuse(ticket);
        emit Sold(c.id, from, to, t.tokens, t.usdg, t.value, t.spreadBps, viaHook, c.r.session);
    }

    function _refuse(uint256 ticket) private pure {
        if (ticket != 0) revert NotFillable(ticket);
        revert UseQueue();
    }

    /// Writes the accrual `c` simulated (R1) and reports the toll to the Governor. Never reverts.
    function _commit(P.Ctx memory c) private {
        if (!c.accrues) return;
        NormState storage s = _norm[c.id];
        s.nf = uint128(c.nfNew);
        s.tollPerSecWad = int128(c.rateNew);
        s.lastAccrual = uint64(block.timestamp);
        if (c.cumAdd != 0) s.cumTollPerTokenWad += c.cumAdd;
        _sigma[c.id] = c.sigma;
        if (c.tollValue != 0) {
            try governor.onToll(c.id, c.tollValue) {} catch {}
        }
        uint256 absToll = c.tollValue >= 0 ? uint256(c.tollValue) : uint256(-c.tollValue);
        emit Accrued(c.id, c.nfNew, c.rateNew, c.dt, absToll);
    }

    function _load(bytes32 gearId) private view returns (P.Ctx memory) {
        return P.context(_deps(), gearId, _norm[gearId], _sigma[gearId], _settled[gearId], _tp.usageMaxWad);
    }

    function _loadKnown(bytes32 gearId) private view returns (P.Ctx memory c) {
        c = _load(gearId);
        if (c.cfg.token == address(0) || c.cfg.status == GearStatus.NONE) revert UnknownGear(gearId);
    }

    function _deps() private view returns (P.Deps memory) {
        return P.Deps({registry: registry, guard: guard, vol: vol, governor: governor, fees: fees});
    }

    function _checkCall(address recipient, uint64 deadline) private view {
        if (block.timestamp > deadline) revert Expired();
        if (recipient == address(0)) revert ZeroAddress();
    }

    function _haltedLong(bytes32 a, bytes32 b) private view returns (bool) {
        uint256 wait = _tp.settleAfterHalt;
        uint64 ha = guard.haltedSince(a);
        if (ha != 0 && block.timestamp - ha >= wait) return true;
        if (b == bytes32(0)) return false;
        uint64 hb = guard.haltedSince(b);
        return hb != 0 && block.timestamp - hb >= wait;
    }

    /// Staking spread discount for `account`: a gas-capped read, 0 when unset or on any failure (R5).
    function _discount(address account) private view returns (uint16) {
        address s = stake;
        if (s == address(0) || account == address(0)) return 0;
        (bool ok, bytes memory data) =
            s.staticcall{gas: STAKE_READ_GAS}(abi.encodeWithSignature("feeDiscountOf(address)", account));
        if (!ok || data.length < 32) return 0;
        uint256 v = abi.decode(data, (uint256));
        return v > BPS ? uint16(BPS) : uint16(v);
    }

    function _shareBps() private view returns (uint256) {
        try IODFees(fees).protocolSpreadShareBps() returns (uint16 b) {
            if (b <= BPS) return b;
        } catch {}
        return 1000;
    }
}

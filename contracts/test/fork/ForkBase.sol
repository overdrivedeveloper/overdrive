// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {HookFixture} from "../hook/HookFixture.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// The deployed V4Quoter on Robinhood Chain, called by ABI (the vendored periphery source does not compile against the
/// vendored v4-core). Selectors checked against the deployed bytecode: 0xaa9d21cb and 0x58733073.
interface IDeployedV4Quoter {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function poolManager() external view returns (address);
    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
    function quoteExactOutputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountIn, uint256 gasEstimate);
}

interface IDeployedUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IDeployedPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// Pays the input BEFORE calling swap (sync, transfer, settle, then swap, then take), so the PoolManager physically
/// holds the input when the hook takes it. Needs no seed in the singleton.
contract SettleFirstRouter is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function swapExactIn(PoolKey memory key, IPoolManager.SwapParams memory p) external returns (BalanceDelta d) {
        d = abi.decode(pm.unlock(abi.encode(msg.sender, key, p)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (address payer, PoolKey memory key, IPoolManager.SwapParams memory p) =
            abi.decode(data, (address, PoolKey, IPoolManager.SwapParams));
        require(p.amountSpecified < 0, "exact in only");
        (Currency cin, Currency cout) = p.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        pm.sync(cin);
        IERC20(Currency.unwrap(cin)).transferFrom(payer, address(pm), uint256(-p.amountSpecified));
        pm.settle();
        BalanceDelta d = pm.swap(key, p, "");
        int128 out = p.zeroForOne ? d.amount1() : d.amount0();
        pm.take(cout, payer, uint256(uint128(out)));
        return abi.encode(d);
    }
}

/// HookFixture on a fork of Robinhood Chain mainnet (pinned block, ForkPin): the hook binds to the DEPLOYED PoolManager and is
/// quoted through the DEPLOYED V4Quoter and routed through the DEPLOYED Universal Router. The Overdrive system itself
/// (minter, Governor, registry, oracle guard) is deployed fresh on the fork with the SystemFixture mocks for USDG,
/// feeds and Stock Tokens: the quoter, the PoolManager and the router never read those, so parity is unaffected.
/// Skips without RHC_RPC_URL.
abstract contract ForkBase is HookFixture {
    address internal constant RHC_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant RHC_V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address internal constant RHC_UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant RHC_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 internal constant SPY = "SPY";

    IDeployedV4Quoter internal quoter = IDeployedV4Quoter(RHC_V4_QUOTER);
    SettleFirstRouter internal settleFirst;
    bytes32 internal nvdaCruise;
    bytes32 internal spySport;
    bool internal forked;

    function setUp() public virtual override {
        if (bytes(vm.envOr("RHC_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        forkOrSkip();
        forked = true;
        super.setUp();
        assertEq(address(pm), RHC_POOL_MANAGER, "real PoolManager");
        assertEq(quoter.poolManager(), RHC_POOL_MANAGER, "quoter bound to the real PoolManager");
        settleFirst = new SettleFirstRouter(IPoolManager(RHC_POOL_MANAGER));
        // the two gears the fork suite needs beyond the fixture's set
        _market(SPY, 600e18, false);
        _postVol(SPY, 2000);
        nvdaCruise = _list(NVDA, NONE, Gear.CRUISE);
        spySport = _list(SPY, NONE, Gear.SPORT);
        vm.startPrank(admin);
        hook.initializeGearPool(nvdaCruise);
        hook.initializeGearPool(spySport);
        vm.stopPrank();
        if (_seedPoolManager()) {
            address seeder = makeAddr("pmSeeder");
            _seedGear(seeder, nvdaCruise, 20_000e6);
            _seedGear(seeder, spySport, 20_000e6);
            _seedGear(seeder, ethSport, 20_000e6);
        }
    }

    function _newPoolManager() internal view override returns (PoolManager) {
        require(RHC_POOL_MANAGER.code.length > 0, "no PoolManager on the fork");
        return PoolManager(RHC_POOL_MANAGER);
    }

    function _usdgIs0(PoolKey memory key) internal view returns (bool) {
        return Currency.unwrap(key.currency0) == address(usdg);
    }

    function _qp(bytes32 id, bool isBuy, uint256 amount)
        internal
        view
        returns (IDeployedV4Quoter.QuoteExactSingleParams memory q)
    {
        q.poolKey = hook.poolKeyOf(id);
        q.zeroForOne = isBuy == _usdgIs0(q.poolKey);
        q.exactAmount = uint128(amount);
    }

    /// Real V4Quoter: (amountIn, amountOut) for the mode.
    function _v4Quote(bytes32 id, bool isBuy, bool exactIn, uint256 amount)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (exactIn) {
            (amountOut,) = quoter.quoteExactInputSingle(_qp(id, isBuy, amount));
            amountIn = amount;
        } else {
            (amountIn,) = quoter.quoteExactOutputSingle(_qp(id, isBuy, amount));
            amountOut = amount;
        }
    }

    function _gearToken(bytes32 id) internal view returns (IERC20) {
        return _token(id);
    }
}

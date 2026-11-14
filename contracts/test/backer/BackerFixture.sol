// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {ODBacker} from "overdrive/backer/ODBacker.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODMarketHours} from "overdrive/interfaces/IODMarketHours.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {GearConfig, PriceReading, Session} from "overdrive/interfaces/ODTypes.sol";
import {ODIndex} from "overdrive/math/ODIndex.sol";

/// Market hours with a settable session kind and next long close (the uplift suite also runs the real calendar).
contract MockHours {
    Session public kind = Session.OPEN;
    uint64 public closeAt;
    uint64 public reopenAt;

    function set(Session k, uint64 c, uint64 r) external {
        kind = k;
        closeAt = c;
        reopenAt = r;
    }

    function kindAt(uint256) external view returns (Session) {
        return kind;
    }

    function nextLongClose(uint256, uint256) external view returns (uint64, uint64) {
        return (closeAt, reopenAt);
    }
}

/// ODBacker plus a way to put a vault in a sealed batch before 07b exists.
contract ODBackerHarness is ODBacker {
    constructor(
        IERC20 u,
        address admin,
        address guardian,
        IODGearRegistry r,
        IODMinter m,
        IODGovernor g,
        IODOracleGuard o,
        IODMarketHours h,
        IODInsurance i,
        address f
    ) ODBacker(u, admin, guardian, r, m, g, o, h, i, f) {}

    function harnessSeal(uint256 vaultId) external returns (uint256 id) {
        id = ++batchCount;
        Batch storage b = _batches[id];
        b.gearId = _vaults[vaultId].gearId;
        b.sealedAt = uint64(block.timestamp);
        b.vaultIds.push(vaultId);
        _vaults[vaultId].batchId = id;
    }

    /// Test-only: takes `amount` off a vault's collateral books; the fixture's `_drain` moves the USDG out (kept out
    /// of the harness so it stays under the code size limit), to reach states such as a vault whose collateral
    /// cannot even pay the executor's minimum reward.
    function harnessDrain(uint256 vaultId, uint256 amount) external {
        _vaults[vaultId].collateralUsdg -= amount;
        totalCollateral -= amount;
    }
}

/// A stake that pays what it holds on slash (or nothing, emitting SlashFailed, when `fail`).
contract MockSlashStake {
    IERC20 internal immutable u;
    bool public fail;
    uint256 public asked;

    event SlashFailed(uint256 usdgRequested);

    constructor(IERC20 u_) {
        u = u_;
    }

    function setFail(bool f) external {
        fail = f;
    }

    function slash(uint256 need) external returns (uint256 sent) {
        asked += need;
        if (fail) {
            emit SlashFailed(need);
            return 0;
        }
        uint256 bal = u.balanceOf(address(this));
        sent = need < bal ? need : bal;
        if (sent != 0) u.transfer(msg.sender, sent);
    }
}

abstract contract BackerFixture is SystemFixture {
    ODBackerHarness internal backer;
    MockHours internal hrs;
    address internal carol = makeAddr("carol");

    function _deployBacker() internal override returns (address) {
        hrs = new MockHours();
        backer = new ODBackerHarness(
            IERC20(address(usdg)),
            admin,
            guardian,
            IODGearRegistry(address(reg)),
            IODMinter(address(minter)),
            IODGovernor(address(gov)),
            IODOracleGuard(address(guard)),
            IODMarketHours(address(hrs)),
            IODInsurance(address(ins)),
            address(fees)
        );
        return address(backer);
    }

    function _open(address who, bytes32 id, uint256 amount) internal returns (uint256 vaultId) {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(backer), type(uint256).max);
        vaultId = backer.openVault(id, amount);
        vm.stopPrank();
    }

    function _mint(address who, uint256 vaultId, uint256 tokens, bool sell) internal returns (uint256) {
        vm.prank(who);
        return backer.mint(vaultId, tokens, sell, 0);
    }

    /// Takes `amount` of a vault's collateral out to `to` (books kept).
    function _drain(uint256 vaultId, uint256 amount, address to) internal {
        backer.harnessDrain(vaultId, amount);
        vm.prank(address(backer));
        usdg.transfer(to, amount);
    }

    function _coll(uint256 vaultId) internal view returns (uint256 c) {
        (,, c,,) = backer.vault(vaultId);
    }

    function _debt(uint256 vaultId) internal view returns (uint256 d) {
        (,,, d,) = backer.vault(vaultId);
    }

    function _ratio(uint256 vaultId) internal view returns (uint256 r) {
        (,, r,,) = backer.health(vaultId);
    }

    function _reading(bytes32 id) internal view returns (PriceReading memory) {
        GearConfig memory c = reg.gear(id);
        return c.marketB == NONE ? guard.read(c.marketA) : guard.readRatio(c.marketA, c.marketB);
    }

    /// Value per token at price `p` with the minter's current NF.
    function _valueAt(bytes32 id, uint256 p, Math.Rounding rnd) internal view returns (uint256 v) {
        GearConfig memory c = reg.gear(id);
        (v,) = ODIndex.value(c.gear, p, c.p0, minter.normState(id).nf, c.unitWad, rnd);
    }

    /// Sport vault at a 200% ratio: 1000 USDG, 500 tokens (500 USD of debt at 250, one token = 1 USD at p0).
    function _sportVault(address who) internal returns (uint256 id) {
        id = _open(who, sport, 1_000e6);
        _mint(who, id, 500e18, false);
    }

    function _seal(bytes32 g, uint256 id) internal returns (uint256) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        return backer.sealBatch(g, ids);
    }

    function _uplift(bool on) internal {
        uint64 t = uint64(vm.getBlockTimestamp());
        if (on) hrs.set(Session.OPEN, t + 1 hours, t + 60 hours);
        else hrs.set(Session.OPEN, 0, 0);
    }
}

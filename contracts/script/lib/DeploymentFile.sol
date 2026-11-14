// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemDeployer} from "./SystemDeployer.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";
import {GearConfig} from "overdrive/interfaces/ODTypes.sol";

/// @title DeploymentFile
/// @notice Writes and reads `app/deployments/<network>.json` in the 01 schema (the one source of addresses).
abstract contract DeploymentFile is SystemDeployer {
    function _q(string memory s) private pure returns (string memory) {
        return string.concat('"', s, '"');
    }

    function _kv(string memory k, string memory v) private pure returns (string memory) {
        return string.concat(_q(k), ": ", v);
    }

    function _a(address a) private pure returns (string memory) {
        return _q(vm.toString(a));
    }

    function _aOrNull(address a) private pure returns (string memory) {
        return a == address(0) ? "null" : _a(a);
    }

    function _power(uint8 g) private pure returns (string memory) {
        string[5] memory p = ["1.5", "2", "3", "0.5", "-1"];
        return p[g];
    }

    function renderDeployment(Config memory c, Deployed memory d, address deployer, string memory commit)
        public
        view
        returns (string memory s)
    {
        s = string.concat(
            "{\n  ",
            _kv("chainId", vm.toString(block.chainid)),
            ",\n  ",
            _kv("network", _q(c.network)),
            ",\n  ",
            _kv("commit", _q(commit)),
            ",\n  ",
            _kv("deployedAt", _q(_isoNow())),
            ",\n  ",
            _kv("startBlock", vm.toString(d.startBlock)),
            ",\n  ",
            _kv("deployer", _a(deployer)),
            ",\n  "
        );
        s = string.concat(
            s,
            _kv(
                "admin",
                string.concat(
                    "{",
                    _kv("ownerSafe", _a(c.roles.ownerSafe)),
                    ", ",
                    _kv("timelock", _a(d.timelock)),
                    ", ",
                    _kv("guardianSafe", _a(c.roles.guardianSafe)),
                    ", ",
                    _kv("minDelaySec", vm.toString(c.minDelay)),
                    "}"
                )
            ),
            ",\n  ",
            _externals(c, d),
            ",\n  ",
            _contracts(d),
            ",\n  ",
            _marketsJson(c),
            ",\n  ",
            _gearsJson(d),
            "\n}\n"
        );
    }

    function _externals(Config memory c, Deployed memory d) private pure returns (string memory) {
        return _kv(
            "external",
            string.concat(
                "{",
                string.concat(
                    _kv("usdg", _a(d.usdg)),
                    ", ",
                    _kv("poolManager", _a(d.poolManager)),
                    ", ",
                    _kv("stateView", _a(c.ext.stateView)),
                    ", ",
                    _kv("v4Quoter", _a(c.ext.v4Quoter)),
                    ", "
                ),
                string.concat(
                    _kv("pythCore", _a(c.ext.pythCore)),
                    ", ",
                    _kv("permit2", _a(c.ext.permit2)),
                    ", ",
                    _kv("entryPoint", _a(c.ext.entryPoint)),
                    ", ",
                    _kv("v3Factory", _a(c.ext.v3Factory)),
                    "}"
                )
            )
        );
    }

    function _contracts(Deployed memory d) private pure returns (string memory) {
        string memory a = string.concat(
            _kv("ODMarketHours", _a(d.marketHours)),
            ", ",
            _kv("ODOracleGuard", _a(d.guard)),
            ", ",
            _kv("ODVolOracle", _a(d.vol)),
            ", ",
            _kv("ODGearRegistry", _a(d.registry)),
            ", ",
            _kv("ODGearFactory", _a(d.factory)),
            ", ",
            _kv("ODMinter", _a(d.minter)),
            ", ",
            _kv("ODGovernor", _a(d.governor))
        );
        string memory b = string.concat(
            _kv("ODInsurance", _a(d.insurance)),
            ", ",
            _kv("ODHook", _a(d.hook)),
            ", ",
            _kv("ODBacker", _a(d.backer)),
            ", ",
            _kv("ODFees", _a(d.fees)),
            ", ",
            _kv("ODStake", _a(d.stake)),
            ", ",
            _kv("ODAgentRouter", _a(d.agentRouter)),
            ", ",
            _kv("ODPaymaster", _a(d.paymaster))
        );
        return _kv("contracts", string.concat("{", a, ", ", b, "}"));
    }

    function _marketsJson(Config memory c) private pure returns (string memory s) {
        s = '"markets": [';
        for (uint256 i; i < c.markets.length; ++i) {
            MarketCfg memory m = c.markets[i];
            s = string.concat(
                s,
                i == 0 ? "\n    {" : ",\n    {",
                string.concat(
                    _kv("id", _q(vm.toString(m.id))),
                    ", ",
                    _kv("symbol", _q(m.symbol)),
                    ", ",
                    _kv("kind", m.crypto ? '"crypto"' : '"stock"'),
                    ", ",
                    _kv("feed", _a(m.cfg.feed)),
                    ", "
                ),
                string.concat(
                    _kv("stockToken", _aOrNull(m.cfg.stockToken)),
                    ", ",
                    _kv("multiplierEmbedded", m.cfg.multiplierEmbedded ? "true" : "false"),
                    ", ",
                    _kv("pythId", m.cfg.pythId == bytes32(0) ? "null" : _q(vm.toString(m.cfg.pythId))),
                    ", ",
                    _kv("twapPool", _aOrNull(m.cfg.twapPool)),
                    ", ",
                    _kv("alwaysOpen", m.cfg.alwaysOpen ? "true" : "false"),
                    "}"
                )
            );
        }
        s = string.concat(s, c.markets.length == 0 ? "]" : "\n  ]");
    }

    function _gearsJson(Deployed memory d) private view returns (string memory s) {
        ODGearRegistry reg = ODGearRegistry(d.registry);
        uint256 n = reg.gearCount();
        s = '"gears": [';
        for (uint256 i; i < n; ++i) {
            bytes32 id = reg.gearIdAt(i);
            GearConfig memory g = reg.gear(id);
            s = string.concat(
                s,
                i == 0 ? "\n    {" : ",\n    {",
                string.concat(
                    _kv("id", _q(vm.toString(id))),
                    ", ",
                    _kv("symbol", _q(_tokenSymbol(g.token))),
                    ", ",
                    _kv("gear", _q(gearName(g.gear))),
                    ", ",
                    _kv("power", _q(_power(uint8(g.gear)))),
                    ", ",
                    _kv("marketA", _q(symbolOf(g.marketA))),
                    ", "
                ),
                string.concat(
                    _kv("marketB", g.marketB == bytes32(0) ? "null" : _q(symbolOf(g.marketB))),
                    ", ",
                    _kv("token", _a(g.token)),
                    ", ",
                    _kv("poolId", _q(vm.toString(ODHook(d.hook).poolIdOf(id)))),
                    ", ",
                    _kv("capUsd", _q(vm.toString(uint256(g.capUsdWad) / 1e18))),
                    ", ",
                    _kv("spreadBps", vm.toString(uint256(g.spreadBps))),
                    ", ",
                    _kv("unitUsd", _q(vm.toString(uint256(g.unitWad) / 1e18))),
                    "}"
                )
            );
        }
        s = string.concat(s, n == 0 ? "]" : "\n  ]");
    }

    function _tokenSymbol(address t) private view returns (string memory) {
        (bool ok, bytes memory r) = t.staticcall(abi.encodeWithSignature("symbol()"));
        return ok ? abi.decode(r, (string)) : "?";
    }

    function _isoNow() private view returns (string memory) {
        uint256 t = block.timestamp;
        uint256 z = t / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 day = doy - (153 * mp + 2) / 5 + 1;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        uint256 year = yoe + era * 400 + (month <= 2 ? 1 : 0);
        uint256 sod = t % 86400;
        return string.concat(
            vm.toString(year),
            "-",
            _2(month),
            "-",
            _2(day),
            "T",
            _2(sod / 3600),
            ":",
            _2(sod / 60 % 60),
            ":",
            _2(sod % 60),
            "Z"
        );
    }

    function _2(uint256 v) private pure returns (string memory) {
        return v < 10 ? string.concat("0", vm.toString(v)) : vm.toString(v);
    }

    /// Reads a deployments json back into `Deployed` (timelock from admin, ovrd from the stake contract).
    function readDeployment(string memory j) public view returns (Deployed memory d) {
        d.timelock = vm.parseJsonAddress(j, ".admin.timelock");
        d.usdg = vm.parseJsonAddress(j, ".external.usdg");
        d.poolManager = vm.parseJsonAddress(j, ".external.poolManager");
        d.marketHours = vm.parseJsonAddress(j, ".contracts.ODMarketHours");
        d.guard = vm.parseJsonAddress(j, ".contracts.ODOracleGuard");
        d.vol = vm.parseJsonAddress(j, ".contracts.ODVolOracle");
        d.registry = vm.parseJsonAddress(j, ".contracts.ODGearRegistry");
        d.factory = vm.parseJsonAddress(j, ".contracts.ODGearFactory");
        d.insurance = vm.parseJsonAddress(j, ".contracts.ODInsurance");
        d.fees = vm.parseJsonAddress(j, ".contracts.ODFees");
        d.governor = vm.parseJsonAddress(j, ".contracts.ODGovernor");
        d.minter = vm.parseJsonAddress(j, ".contracts.ODMinter");
        d.backer = vm.parseJsonAddress(j, ".contracts.ODBacker");
        d.hook = vm.parseJsonAddress(j, ".contracts.ODHook");
        d.stake = vm.parseJsonAddress(j, ".contracts.ODStake");
        d.agentRouter = vm.parseJsonAddress(j, ".contracts.ODAgentRouter");
        d.paymaster = vm.parseJsonAddress(j, ".contracts.ODPaymaster");
        d.startBlock = vm.parseJsonUint(j, ".startBlock");
        if (d.stake.code.length != 0) d.ovrd = address(ODStake(d.stake).ovrd());
    }
}

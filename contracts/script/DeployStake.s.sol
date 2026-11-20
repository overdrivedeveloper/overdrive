// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockBatch} from "./ListGears.s.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODBacker} from "overdrive/backer/ODBacker.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";

/// @title DeployStake
/// @notice Phase 2 of a system deployed without $OVRD (phase 1, `external.ovrd` zero). Reads the deployments json and
/// the token address (`OD_OVRD`, else `external.ovrd` in the config), deploys ODStake(ovrd, usdg, deployer, governor,
/// backer) with the roles the one-phase deploy gives it (FEES_ROLE to ODFees, GUARDIAN_ROLE to the guardian Safe,
/// deposits paused), hands its admin to the timelock and renounces the deployer's, records it in the deployments json
/// and writes ONE timelock batch for the owner Safe: fees.setRecipient(STAKERS, stake), minter.setStake(stake),
/// backer.setStake(stake), stake.setDepositsPaused(false). Idempotent: a recorded stake with code is not redeployed;
/// only the batch is written again. On 4663/46630 it refuses to broadcast unless armed (ODScript).
/// Usage: OD_NETWORK=mainnet OD_OVRD=0x... forge script script/DeployStake.s.sol --rpc-url $RPC
///        --account overdrive-deployer --broadcast
contract DeployStake is TimelockBatch {
    error StakeRefused(string why);

    function run() external returns (address stake, bytes32 id) {
        string memory network = _network();
        Config memory c = loadConfig(network);
        string memory path = vm.envOr("OD_DEPLOYMENT_FILE", _deploymentPath(network));
        string memory j = vm.readFile(path);
        Deployed memory d = readDeployment(j);
        address ovrd = vm.envOr("OD_OVRD", c.ext.ovrd);
        if (vm.parseJsonAddress(j, ".admin.guardianSafe") != c.roles.guardianSafe) {
            revert StakeRefused("guardian Safe in the config differs from the deployments json");
        }
        if (d.stake == address(0)) {
            d = deploy(c, d, ovrd, msg.sender);
            vm.writeFile(path, recordStake(j, d.stake));
            console2.log("deployments json:", path);
        } else if (d.stake.code.length == 0) {
            revert StakeRefused("recorded ODStake has no code");
        }
        string[] memory f = checkStakeDeployed(c, d, msg.sender);
        for (uint256 i; i < f.length; ++i) {
            console2.log("FAIL", f[i]);
        }
        if (f.length != 0) revert StakeRefused("the new stake fails its checks");
        stake = d.stake;
        Batch memory b = stakeBatch(d);
        id = batchId(b);
        string memory name = string.concat(network, "-wire-stake");
        console2.log("ODStake:", stake);
        console2.log("wire-stake batch:", writeBatch(name, d.timelock, b, c.minDelay));
        console2.log("batch params:", writeBatchParams(name, b, c.minDelay));
    }

    /// Validates, guards, deploys the stake, sets its roles and hands its admin to the timelock, as `deployer`.
    function deploy(Config memory c, Deployed memory d, address ovrd, address deployer)
        public
        returns (Deployed memory)
    {
        if (ovrd == address(0)) {
            revert StakeRefused("no $OVRD address (set OD_OVRD or external.ovrd)");
        }
        if (ovrd.code.length == 0) revert StakeRefused("no code at the $OVRD address");
        if (d.stake != address(0)) revert StakeRefused("a stake is already recorded");
        if (ODMinter(d.minter).stake() != address(0) || ODBacker(d.backer).stake() != address(0)) {
            revert StakeRefused("the minter or backer already names a stake");
        }
        if (!IAccessControl(d.fees).hasRole(0x00, d.timelock)) revert StakeRefused("timelock is not admin of ODFees");
        d.ovrd = ovrd;
        _guardRealBroadcast();
        vm.startBroadcast(deployer);
        d.stake = newStake(d, deployer);
        setupStake(d, c.roles.guardianSafe);
        ODStake st = ODStake(d.stake);
        st.grantRole(0x00, d.timelock);
        st.renounceRole(0x00, deployer);
        vm.stopBroadcast();
        return d;
    }

    /// The deployments json with its empty ODStake entry filled; every other byte is kept.
    function recordStake(string memory j, address stake) public pure returns (string memory body) {
        body = vm.replace(j, '"ODStake": ""', string.concat('"ODStake": "', vm.toString(stake), '"'));
        if (keccak256(bytes(body)) == keccak256(bytes(j))) revert StakeRefused("no empty ODStake entry to fill");
    }

    /// The one 48 h batch: point the STAKERS share at the stake, name it in the minter and the backer, open deposits.
    function stakeBatch(Deployed memory d) public pure returns (Batch memory b) {
        b.targets = new address[](4);
        b.values = new uint256[](4);
        b.payloads = new bytes[](4);
        b.targets[0] = d.fees;
        b.payloads[0] = abi.encodeCall(ODFees.setRecipient, (bytes32("STAKERS"), d.stake));
        b.targets[1] = d.minter;
        b.payloads[1] = abi.encodeCall(ODMinter.setStake, (d.stake));
        b.targets[2] = d.backer;
        b.payloads[2] = abi.encodeCall(ODBacker.setStake, (d.stake));
        b.targets[3] = d.stake;
        b.payloads[3] = abi.encodeCall(ODStake.setDepositsPaused, (false));
        b.salt = keccak256(abi.encode("overdrive-wire-stake", d.stake));
    }

    /// The raw scheduleBatch arguments next to the Safe files: targets, values, calldatas, predecessor, salt, delay.
    function writeBatchParams(string memory name, Batch memory b, uint256 delay) internal returns (string memory path) {
        string memory dir = vm.envOr("OD_BATCH_DIR", string.concat(vm.projectRoot(), "/../.batches"));
        vm.createDir(dir, true);
        path = string.concat(dir, "/", name, ".params.json");
        string memory t;
        string memory v;
        string memory p;
        for (uint256 i; i < b.targets.length; ++i) {
            string memory sep = i == 0 ? "" : ", ";
            t = string.concat(t, sep, '"', vm.toString(b.targets[i]), '"');
            v = string.concat(v, sep, '"', vm.toString(b.values[i]), '"');
            p = string.concat(p, sep, '"', vm.toString(b.payloads[i]), '"');
        }
        vm.writeFile(
            path,
            string.concat(
                '{"targets": [',
                t,
                '], "values": [',
                v,
                '], "calldatas": [',
                p,
                '], "predecessor": "',
                vm.toString(bytes32(0)),
                '", "salt": "',
                vm.toString(b.salt),
                '", "delay": "',
                vm.toString(delay),
                '", "batchId": "',
                vm.toString(batchId(b)),
                '"}\n'
            )
        );
    }
}

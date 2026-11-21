# Live deployment check (LIVE-CHECK): PENDING

Status: **pending, nothing is deployed on mainnet yet.** This file is a placeholder; it is replaced by the release
gate right after the mainnet deploy, never written by hand.

What fills it (all read-only, public RPC, no key):

1. `forge script script/PostDeployCheck.s.sol` with `OD_NETWORK=mainnet` writes `post-deploy-mainnet.txt` here:
   wiring, roles, timelock delay, owner and guardian Safes (proxy codehash, singleton, threshold, no module, no
   guard, fallback handler), Safe, Multicall3 and CreateX codehashes, no sequencer feed, markets, gears, seed.
2. `bash contracts/script/verify-deployment.sh mainnet` compares the code at every recorded address with this
   tree's build (immutables and linked libraries masked); its PASS/FAIL lines are added below.
3. `bash contracts/script/sourcify-verify.sh` (deploy stage `stage_sourcify`) writes `sourcify-mainnet.txt` here;
   every contract must read `exact_match` or `match` (a partial match: bytecode equal, metadata hash not; the stage
   warns on it).

Until all three are committed here with the deploy commit, treat the deployment as unverified.

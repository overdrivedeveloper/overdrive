#!/bin/bash
# Deploys Overdrive to a LOCAL anvil fork of Robinhood Chain (never a real chain), then hands off, checks and writes
# the list-gears batch. Safe to run twice: every finished stage is skipped (app/scripts/deploy.test.sh proves it).
# Usage: anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8547 &
#        OD_DEPLOYER=0x... ANVIL_URL=http://127.0.0.1:8547 /bin/bash app/scripts/deploy-fork.sh
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/deploy/lib.sh"
RPC_URL="${ANVIL_URL:-http://127.0.0.1:8547}"
od_init fork "$RPC_URL" "${OD_OUT:-$BACKEND/app/deployments/local/fork.json}"
# An anvil fork keeps the forked chain id (4663): the node must say it is anvil, or this refuses.
case "$("$CAST" rpc web3_clientVersion --rpc-url "$RPC_URL")" in *anvil/*) ;; *) die "deploy-fork.sh only runs on a local anvil node" ;; esac
stage_deploy
stage_handoff
stage_check
stage_batch
say "deploy-fork: finished"

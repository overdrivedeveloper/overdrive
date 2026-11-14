#!/bin/bash
# Deploys Overdrive to Robinhood Chain TESTNET 46630. The owner runs it; agents never do. Refuses unless armed
# (OVERDRIVE_ALLOW_REAL_DEPLOY=1 and the OVERDRIVE_ALLOW_FILE file) and script/config/testnet.json has no placeholder.
# Usage: OD_DEPLOYER=0x... OVERDRIVE_ALLOW_REAL_DEPLOY=1 OVERDRIVE_ALLOW_FILE=~/.overdrive-armed /bin/bash app/scripts/deploy-testnet.sh
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/deploy/lib.sh"
od_init testnet "${TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}" "$BACKEND/app/deployments/testnet.json"
[ "$CHAIN_ID" = "46630" ] || die "the RPC is chain $CHAIN_ID, not 46630"
[ "${OVERDRIVE_ALLOW_REAL_DEPLOY:-}" = "1" ] || die "OVERDRIVE_ALLOW_REAL_DEPLOY is not 1"
[ -n "${OVERDRIVE_ALLOW_FILE:-}" ] && [ -f "$OVERDRIVE_ALLOW_FILE" ] || die "the arming file OVERDRIVE_ALLOW_FILE is missing"
stage_deploy
stage_handoff
stage_check
stage_batch
say "deploy-testnet: finished"

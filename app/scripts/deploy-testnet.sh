#!/bin/bash
# Deploys Overdrive to Robinhood Chain TESTNET 46630. The owner runs it; agents never do. Refuses unless armed
# (OVERDRIVE_ALLOW_REAL_DEPLOY=1 and the OVERDRIVE_ALLOW_FILE file) and script/config/testnet.json has no placeholder.
# Usage: OD_DEPLOYER=0x... OVERDRIVE_ALLOW_REAL_DEPLOY=1 OVERDRIVE_ALLOW_FILE="$PWD/.batches/.overdrive-armed" \
#          /bin/bash app/scripts/deploy-testnet.sh   (from backend/, after: mkdir -p .batches && touch .batches/.overdrive-armed)
# The arming file must sit inside a path forge may read (contracts/foundry.toml fs_permissions: .batches/ is the one
# meant for it, git-ignored); the script refuses any other path before it touches the network.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/deploy/lib.sh"
od_init testnet "${TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}" "$BACKEND/app/deployments/testnet.json"
[ "$CHAIN_ID" = "46630" ] || die "the RPC is chain $CHAIN_ID, not 46630"
[ "${OVERDRIVE_ALLOW_REAL_DEPLOY:-}" = "1" ] || die "OVERDRIVE_ALLOW_REAL_DEPLOY is not 1"
check_allow_file # before any network step: inside a forge-readable path, see lib.sh
stage_deploy
stage_handoff
stage_check
stage_sourcify
stage_batch
say "deploy-testnet: finished"

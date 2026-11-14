#!/bin/bash
# Deploys Overdrive to Robinhood Chain MAINNET 4663. Only the owner runs it, after the release gate and his "go".
# Refuses unless: OVERDRIVE_ALLOW_REAL_DEPLOY=1, the OVERDRIVE_ALLOW_FILE file exists, script/config/mainnet.json has
# no placeholder and the owner approved the hook seed figures, a dry run on a local anvil fork at the deployer's REAL nonce
# passes PostDeployCheck, and the owner types the chain id at the prompt.
# Usage: OD_DEPLOYER=0x... OVERDRIVE_ALLOW_REAL_DEPLOY=1 OVERDRIVE_ALLOW_FILE=~/.overdrive-armed /bin/bash app/scripts/deploy-mainnet.sh
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/deploy/lib.sh"
MAINNET_RPC="${MAINNET_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
[ "${OVERDRIVE_ALLOW_REAL_DEPLOY:-}" = "1" ] || die "OVERDRIVE_ALLOW_REAL_DEPLOY is not 1"
[ -n "${OVERDRIVE_ALLOW_FILE:-}" ] && [ -f "$OVERDRIVE_ALLOW_FILE" ] || die "the arming file OVERDRIVE_ALLOW_FILE is missing"
[ -z "${OD_KEYSTORE:-}" ] || die "OD_KEYSTORE is for the self-test only"
python3 - "$CONTRACTS/script/config/mainnet.json" <<'PY' || die "script/config/mainnet.json is not ready"
import json, sys
c = json.load(open(sys.argv[1]))
zero = "0x" + "0" * 40
bad = [k for k, v in c["roles"].items() if v == zero]
bad += [k for k in ("usdg", "poolManager", "pythCore", "entryPoint", "createX", "ovrd") if c["external"][k] == zero]
if not c["hookSeed"]["approvedByOwner"]:
    bad.append("hookSeed.approvedByOwner")
if bad:
    print("placeholders: " + ", ".join(bad), file=sys.stderr)
    sys.exit(1)
PY
mkdir -p "$BACKEND/.audit-grade"
# Dry run: a local anvil fork at the deployer's real nonce, the same script and config, then PostDeployCheck.
PORT="${OD_DRY_PORT:-8590}"
"$HOME/.foundry/bin/anvil" --fork-url "$MAINNET_RPC" --port "$PORT" >"$BACKEND/.audit-grade/mainnet-dry-anvil.log" 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT
DRY="http://127.0.0.1:$PORT"
i=0; until "$CAST" chain-id --rpc-url "$DRY" >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 60 ] || die "dry-run anvil did not start"; sleep 1; done
case "$("$CAST" rpc web3_clientVersion --rpc-url "$DRY")" in *anvil/*) ;; *) die "the dry-run node is not anvil" ;; esac
"$CAST" rpc anvil_impersonateAccount "$OD_DEPLOYER" --rpc-url "$DRY" >/dev/null
DRY_OUT="$BACKEND/.audit-grade/mainnet-dry.json"
(cd "$CONTRACTS" && OD_NETWORK=mainnet OD_DEPLOYMENTS_OUT="$DRY_OUT" \
  "$FORGE" script script/DeploySystem.s.sol --rpc-url "$DRY" --sender "$OD_DEPLOYER" --unlocked --broadcast --slow -q >/dev/null) \
  || die "dry run on the fork failed"
(cd "$CONTRACTS" && OD_NETWORK=mainnet OD_DEPLOYMENT_FILE="$DRY_OUT" \
  "$FORGE" script script/PostDeployCheck.s.sol --rpc-url "$DRY" -q >/dev/null) || die "PostDeployCheck failed on the dry run"
echo "stage dry-run: PASS on a fork at the deployer's real nonce"
kill "$ANVIL_PID" 2>/dev/null || true
trap - EXIT
od_init mainnet "$MAINNET_RPC" "$BACKEND/app/deployments/mainnet.json"
[ "$CHAIN_ID" = "4663" ] || die "the RPC is chain $CHAIN_ID, not 4663"
printf 'Type the chain id to deploy to mainnet: '
read -r typed
[ "$typed" = "4663" ] || die "chain id not confirmed"
stage_deploy
stage_handoff
stage_check
stage_batch
say "deploy-mainnet: finished. Next: the owner's deposit (D8), the hook seeds (D26), then schedule the list-gears batch."

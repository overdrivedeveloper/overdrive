#!/bin/bash
# Shared stages for deploy-{fork,testnet,mainnet}.sh. macOS bash 3.2: no mapfile, no negative indexes, no empty-array
# expansion under set -u. Tools by absolute path. Signing: an encrypted Foundry keystore only (`--account NAME`, the
# password is asked at forge's hidden prompt); OD_KEYSTORE + OD_PASSWORD_FILE exist for the self-test's throwaway
# wallet and are refused on chains 4663 and 46630. Never --private-key; nothing secret is echoed.
set -euo pipefail

FORGE="$HOME/.foundry/bin/forge"
CAST="$HOME/.foundry/bin/cast"
BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONTRACTS="$BACKEND/contracts"

say() { printf '%s\n' "$*"; }
die() { printf 'refused: %s\n' "$*" >&2; exit 1; }

# od_init NETWORK RPC OUTFILE: checks tools, the chain id and the deployer address (public, no secret).
od_init() {
  NETWORK="$1"; RPC="$2"; OUT="$3"
  [ -x "$FORGE" ] || die "forge not found at $FORGE"
  [ -x "$CAST" ] || die "cast not found at $CAST"
  [ -n "${OD_DEPLOYER:-}" ] || die "set OD_DEPLOYER to the deployer's public address"
  mkdir -p "$(dirname "$OUT")" "$BACKEND/.audit-grade" "$BACKEND/.batches"
  CHAIN_ID="$("$CAST" chain-id --rpc-url "$RPC")"
  SIGN_ARGS="--account ${OD_ACCOUNT:-overdrive-deployer}"
  if [ -n "${OD_KEYSTORE:-}" ]; then
    case "$("$CAST" rpc web3_clientVersion --rpc-url "$RPC")" in *anvil/*) ;; *) die "a test keystore is only used on a local anvil node" ;; esac
    [ -n "${OD_PASSWORD_FILE:-}" ] || die "OD_KEYSTORE needs OD_PASSWORD_FILE"
    SIGN_ARGS="--keystore $OD_KEYSTORE --password-file $OD_PASSWORD_FILE"
  fi
  export OD_NETWORK="$NETWORK" OD_DEPLOYMENTS_OUT="$OUT" OD_DEPLOYMENT_FILE="$OUT"
  OD_COMMIT="$(git -C "$BACKEND" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  export OD_COMMIT
  say "stage init: network $NETWORK chain $CHAIN_ID deployer $OD_DEPLOYER"
}

has_code() { local c; c="$("$CAST" code "$1" --rpc-url "$RPC" 2>/dev/null || echo 0x)"; [ "$c" != "0x" ] && [ -n "$c" ]; }
addr_of() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["contracts"][sys.argv[2]])' "$OUT" "$1"; }
timelock_of() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["admin"]["timelock"])' "$OUT"; }

run_script() { # run_script <Script path[:Contract]> [--broadcast]
  # shellcheck disable=SC2086
  (cd "$CONTRACTS" && "$FORGE" script "$@" --rpc-url "$RPC" --sender "$OD_DEPLOYER" $SIGN_ARGS --slow -q)
}

stage_deploy() {
  if [ -f "$OUT" ] && has_code "$(addr_of ODGovernor)" && has_code "$(addr_of ODHook)"; then
    say "stage deploy: skip (code found at the recorded addresses)"
    return 0
  fi
  OD_START_BLOCK="$("$CAST" block-number --rpc-url "$RPC")"
  export OD_START_BLOCK
  run_script script/DeploySystem.s.sol --broadcast >/dev/null
  [ -f "$OUT" ] || die "DeploySystem wrote no deployments json"
  say "stage deploy: done ($OUT)"
}

stage_handoff() {
  local pending=0 core tl ADMIN_ROLE
  ADMIN_ROLE="0x$(printf '%064d' 0)"
  tl="$(timelock_of)"
  for core in ODMarketHours ODOracleGuard ODVolOracle ODGearRegistry ODInsurance ODFees ODGovernor ODMinter ODBacker ODHook ODStake; do
    a="$(addr_of "$core")"
    if [ "$("$CAST" call "$a" 'hasRole(bytes32,address)(bool)' "$ADMIN_ROLE" "$tl" --rpc-url "$RPC")" != "true" ]; then pending=1; fi
    if [ "$("$CAST" call "$a" 'hasRole(bytes32,address)(bool)' "$ADMIN_ROLE" "$OD_DEPLOYER" --rpc-url "$RPC")" = "true" ]; then pending=1; fi
  done
  if [ "$pending" -eq 0 ]; then
    say "stage handoff: skip (timelock is admin everywhere, deployer holds nothing)"
    return 0
  fi
  run_script script/TimelockHandoff.s.sol --broadcast >/dev/null
  say "stage handoff: done"
}

stage_check() {
  if (cd "$CONTRACTS" && "$FORGE" script script/PostDeployCheck.s.sol --rpc-url "$RPC" -q >/dev/null 2>&1); then
    say "stage check: PASS (read-only, .audit-grade/post-deploy-$NETWORK.txt)"
  else
    cat "$BACKEND/.audit-grade/post-deploy-$NETWORK.txt" 2>/dev/null || true
    die "post-deploy check failed"
  fi
}

stage_batch() {
  local f="$BACKEND/.batches/$NETWORK-list-gears.json"
  if [ -f "$f" ]; then
    say "stage list-gears batch: skip ($f exists)"
    return 0
  fi
  OD_BATCH_DIR="$BACKEND/.batches" run_script script/ListGears.s.sol:ListGears >/dev/null
  if [ -f "$f" ]; then say "stage list-gears batch: written ($f)"; else say "stage list-gears batch: none needed (every gear listed)"; fi
}

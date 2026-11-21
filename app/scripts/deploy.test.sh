#!/bin/bash
# Self-test of the owner deploy script (todo 11 R10): runs deploy-fork.sh twice against a local anvil fork with
# /bin/bash and shows the second run skips every finished stage. The wallet is a throwaway created here
# (`cast wallet new` into a temp keystore, generated password), funded with anvil_setBalance on the LOCAL node only.
# It also shows deploy-fork.sh refuses a non-anvil RPC and deploy-mainnet.sh refuses unarmed or with an unreadable arming file.
# Usage: ANVIL_URL=http://127.0.0.1:8547 /bin/bash app/scripts/deploy.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
CAST="$HOME/.foundry/bin/cast"
: "${ANVIL_URL:?set ANVIL_URL to a local anvil fork}"
case "$("$CAST" rpc web3_clientVersion --rpc-url "$ANVIL_URL")" in *anvil/*) ;; *) echo "not an anvil node" >&2; exit 1 ;; esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/keys"
openssl rand -hex 24 >"$TMP/pw"
ADDR="$("$CAST" wallet new "$TMP/keys" --unsafe-password "$(cat "$TMP/pw")" 2>/dev/null | grep -Eo '0x[0-9a-fA-F]{40}' | tail -n 1)"
KEY="$(ls "$TMP/keys" | head -n 1)"
[ -n "$ADDR" ] && [ -n "$KEY" ] || { echo "wallet creation failed" >&2; exit 1; }
"$CAST" rpc anvil_setBalance "$ADDR" 0x56BC75E2D63100000 --rpc-url "$ANVIL_URL" >/dev/null

export OD_DEPLOYER="$ADDR" OD_KEYSTORE="$TMP/keys/$KEY" OD_PASSWORD_FILE="$TMP/pw" ANVIL_URL
export OD_OUT="$BACKEND/app/deployments/local/fork.json"
rm -f "$OD_OUT" "$BACKEND/.batches/fork-list-gears.json" "$BACKEND/.batches/fork-list-gears.execute.json"

pass=0; fail=0
ok() { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }

/bin/bash "$HERE/deploy-fork.sh" >"$TMP/run1.txt" 2>&1 || { cat "$TMP/run1.txt"; bad "first run"; }
cat "$TMP/run1.txt"
grep -q "stage deploy: done" "$TMP/run1.txt" && ok "first run deploys" || bad "first run deploys"
grep -q "stage handoff: skip" "$TMP/run1.txt" && ok "DeploySystem already handed off" || bad "handoff after deploy"
grep -q "stage check: PASS" "$TMP/run1.txt" && ok "post-deploy check passes" || bad "post-deploy check"

/bin/bash "$HERE/deploy-fork.sh" >"$TMP/run2.txt" 2>&1 || { cat "$TMP/run2.txt"; bad "second run"; }
cat "$TMP/run2.txt"
grep -q "stage deploy: skip" "$TMP/run2.txt" && ok "second run skips deploy" || bad "second run skips deploy"
grep -q "stage handoff: skip" "$TMP/run2.txt" && ok "second run skips handoff" || bad "second run skips handoff"
grep -q "stage list-gears batch: skip\|stage list-gears batch: none needed" "$TMP/run2.txt" && ok "second run skips the batch" || bad "second run skips the batch"
if grep -q ": done" "$TMP/run2.txt"; then bad "second run did a stage again"; else ok "second run did nothing again"; fi

# a non-anvil RPC is refused before anything is signed
if OD_DEPLOYER="$ADDR" ANVIL_URL=https://rpc.mainnet.chain.robinhood.com /bin/bash "$HERE/deploy-fork.sh" >"$TMP/real.txt" 2>&1; then
  bad "deploy-fork.sh ran against a real RPC"
else
  grep -q "only .*local anvil node" "$TMP/real.txt" && ok "real RPC refused" || { cat "$TMP/real.txt"; bad "real RPC refused"; }
fi
# deploy-mainnet.sh refuses unarmed, before any network step
if env -u OVERDRIVE_ALLOW_REAL_DEPLOY OD_DEPLOYER="$ADDR" /bin/bash "$HERE/deploy-mainnet.sh" </dev/null >"$TMP/m.txt" 2>&1; then
  bad "deploy-mainnet.sh ran unarmed"
else
  grep -q "OVERDRIVE_ALLOW_REAL_DEPLOY is not 1" "$TMP/m.txt" && ok "mainnet refused unarmed" || bad "mainnet refused unarmed"
fi
# deploy-mainnet.sh refuses an arming file forge cannot read (outside fs_permissions), before any network step.
# (The old "refused with config placeholders" case is gone: script/config/mainnet.json is filled since the deploy, and
# an armed run with a readable file would start the fork dry run. lib.test.sh covers the arming checks offline.)
touch "$TMP/armed"
if OVERDRIVE_ALLOW_REAL_DEPLOY=1 OVERDRIVE_ALLOW_FILE="$TMP/armed" OD_KEYSTORE= OD_DEPLOYER="$ADDR" /bin/bash "$HERE/deploy-mainnet.sh" </dev/null >"$TMP/m2.txt" 2>&1; then
  bad "deploy-mainnet.sh ran with an unreadable arming file"
else
  grep -q "outside the paths forge may read" "$TMP/m2.txt" && ok "mainnet refused an arming file outside fs_permissions" || { cat "$TMP/m2.txt"; bad "mainnet arming path"; }
fi

echo "deploy.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

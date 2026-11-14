#!/bin/bash
# Tests verify-deployment.sh against a fork deploy: every contract PASSes, then one contract's code is swapped on the
# LOCAL anvil node (anvil_setCode) and the script must FAIL it and exit 1. Needs ANVIL_URL and the fork deploy written
# by app/scripts/deploy.test.sh (app/deployments/local/fork.json).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/../../.." && pwd)"
CAST="$HOME/.foundry/bin/cast"
: "${ANVIL_URL:?set ANVIL_URL to the local anvil fork}"
case "$("$CAST" rpc web3_clientVersion --rpc-url "$ANVIL_URL")" in *anvil/*) ;; *) echo "not an anvil node" >&2; exit 1 ;; esac
FILE="$BACKEND/app/deployments/local/fork.json"
[ -f "$FILE" ] || { echo "run app/scripts/deploy.test.sh first (no $FILE)" >&2; exit 1; }
out="$(bash "$HERE/../verify-deployment.sh" fork "$ANVIL_URL")" || { echo "$out"; echo "FAIL clean deploy should pass"; exit 1; }
echo "$out"
n="$(echo "$out" | grep -c '^PASS')"
[ "$n" -ge 14 ] || { echo "FAIL expected 14 PASS lines, got $n"; exit 1; }
router="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contracts"]["ODAgentRouter"])' "$FILE")"
orig="$("$CAST" code "$router" --rpc-url "$ANVIL_URL")"
"$CAST" rpc anvil_setCode "$router" 0x6000 --rpc-url "$ANVIL_URL" >/dev/null
if out2="$(bash "$HERE/../verify-deployment.sh" fork "$ANVIL_URL")"; then
  echo "$out2"; echo "FAIL tampered code passed"; "$CAST" rpc anvil_setCode "$router" "$orig" --rpc-url "$ANVIL_URL" >/dev/null; exit 1
fi
"$CAST" rpc anvil_setCode "$router" "$orig" --rpc-url "$ANVIL_URL" >/dev/null
echo "$out2" | grep -q "^FAIL ODAgentRouter" || { echo "$out2"; echo "FAIL tampered contract not named"; exit 1; }
echo "verify-deployment.test: ok ($n PASS on the clean deploy, tampered ODAgentRouter FAILed)"

#!/bin/bash
# Rule R9 (todo 11): for every contract in app/deployments/<network>.json, compares the code on chain (`cast code`) with
# this checkout's build (`deployedBytecode`, immutables and linked library addresses masked) and prints PASS/FAIL per contract. Exit 1 on any FAIL.
# Usage: verify-deployment.sh <network> [rpc-url]     (fork/anvil files live in app/deployments/local/)
#        OD_DEPLOYMENT_FILE overrides the file. Run `forge build` first (it is run when out/ is missing).
set -euo pipefail
NETWORK="${1:?usage: verify-deployment.sh <network> [rpc-url]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS="$(cd "$HERE/.." && pwd)"
BACKEND="$(cd "$CONTRACTS/.." && pwd)"
CAST="$HOME/.foundry/bin/cast"
FORGE="$HOME/.foundry/bin/forge"
case "$NETWORK" in
  mainnet) DEF_RPC=https://rpc.mainnet.chain.robinhood.com; FILE="$BACKEND/app/deployments/mainnet.json" ;;
  testnet) DEF_RPC=https://rpc.testnet.chain.robinhood.com; FILE="$BACKEND/app/deployments/testnet.json" ;;
  *) DEF_RPC="${ANVIL_URL:-http://127.0.0.1:8545}"; FILE="$BACKEND/app/deployments/local/$NETWORK.json" ;;
esac
RPC="${2:-$DEF_RPC}"
FILE="${OD_DEPLOYMENT_FILE:-$FILE}"
[ -f "$FILE" ] || { echo "no deployments file $FILE" >&2; exit 1; }
[ -d "$CONTRACTS/out" ] || (cd "$CONTRACTS" && "$FORGE" build -q)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
python3 -c 'import json,sys
for k, v in json.load(open(sys.argv[1]))["contracts"].items():
    if v: print(k, v)' "$FILE" >"$TMP/list"
fails=0
while read -r name addr; do
  "$CAST" code "$addr" --rpc-url "$RPC" >"$TMP/chain.hex"
  art="$CONTRACTS/out/$name.sol/$name.json"
  if [ ! -f "$art" ]; then echo "FAIL $name $addr (no build artifact)"; fails=$((fails + 1)); continue; fi
  if python3 - "$art" "$TMP/chain.hex" <<'PY'
import json, re, sys
art = json.load(open(sys.argv[1]))["deployedBytecode"]
# linked library addresses (placeholders in the build) and immutables are masked on both sides
local = bytearray.fromhex(re.sub(r"__\$[0-9a-fA-F]{34}\$__", "0" * 40, art["object"][2:]))
chain = bytearray.fromhex(open(sys.argv[2]).read().strip()[2:])
if len(local) != len(chain) or not local:
    sys.exit(1)
links = [r for lib in (art.get("linkReferences") or {}).values() for refs in lib.values() for r in refs]
for refs in list((art.get("immutableReferences") or {}).values()) + [links]:
    for r in refs:
        s, n = r["start"], r["length"]
        local[s:s + n] = b"\0" * n
        chain[s:s + n] = b"\0" * n
sys.exit(0 if local == chain else 1)
PY
  then echo "PASS $name $addr"; else echo "FAIL $name $addr"; fails=$((fails + 1)); fi
done <"$TMP/list"
echo "verify-deployment $NETWORK: $fails failed"
[ "$fails" -eq 0 ]

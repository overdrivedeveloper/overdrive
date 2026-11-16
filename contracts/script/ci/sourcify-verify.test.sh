#!/bin/bash
# Dry-run test of sourcify-verify.sh on a fixture broadcast: it lists every created contract (transactions and
# constructor-created), passes the linked library, flags an unnamed inner contract, and never runs forge or the
# network in DRY mode (a forge stub that fails the test if called). Nothing is broadcast or uploaded.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat >"$T/run.json" <<'J'
{"transactions":[
 {"transactionType":"CREATE","contractName":"ODMarketHours","contractAddress":"0x00000000000000000000000000000000000000a1"},
 {"transactionType":"CALL","contractName":"ODGovernor","contractAddress":"0x00000000000000000000000000000000000000a2"},
 {"transactionType":"CREATE2","contractName":"ODHook","contractAddress":"0x00000000000000000000000000000000000000a3",
  "additionalContracts":[{"contractName":null,"address":"0x00000000000000000000000000000000000000a4"}]}],
 "libraries":["src/governor/ODMinterPricing.sol:ODMinterPricing:0x00000000000000000000000000000000000000b1"]}
J
printf '#!/bin/sh\necho called >"%s/forge-called"; exit 1\n' "$T" >"$T/forge"; chmod +x "$T/forge"
out="$(DRY=1 FORGE="$T/forge" bash "$HERE/../sourcify-verify.sh" "$T/run.json" 46630 "$T/report")"
echo "$out"
fail() { echo "sourcify-verify.test: FAIL $1"; exit 1; }
echo "$out" | grep -q "would verify ODMarketHours 0x00000000000000000000000000000000000000a1 as src/oracle/ODMarketHours.sol:ODMarketHours --libraries src/governor/ODMinterPricing.sol:ODMinterPricing:0x0" || fail "CREATE not listed with its library"
echo "$out" | grep -q "would verify ODHook 0x00000000000000000000000000000000000000a3 as src/hook/ODHook.sol:ODHook" || fail "CREATE2 not listed"
echo "$out" | grep -q "ODGovernor" && fail "a CALL was listed as a creation"
echo "$out" | grep -q "^MANUAL 0x00000000000000000000000000000000000000a4" || fail "unnamed inner contract not flagged"
[ ! -e "$T/forge-called" ] || fail "DRY mode ran forge"
if bash "$HERE/../sourcify-verify.sh" "$T/run.json" 31337 >/dev/null 2>&1; then fail "a local chain id was accepted"; fi
echo "sourcify-verify.test: ok"

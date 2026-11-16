#!/bin/bash
# DEP-1: publishes the source of every contract a forge broadcast created to Sourcify and checks each one reads
# exact_match. Read-only for the chain (no key, no transaction): it only uploads source and metadata to Sourcify.
# Addresses and linked libraries come from the REAL broadcast file, never from predictions. macOS bash 3.2.
# Usage (any folder): bash script/sourcify-verify.sh <broadcast/<Script>.s.sol/<chain>/run-latest.json> <chain-id> [report]
#   DRY=1 ...   print what would be verified; no forge, no network (the CI test runs this way)
# Writes the per-contract result to [report] when given. Exit 0 only when every created contract is exact_match.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: $0 <broadcast run json> <chain-id> [report]" >&2; exit 2; }
RUN="$1"; CHAIN="$2"; REPORT="${3:-/dev/null}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS="$(cd "$HERE/.." && pwd)"
FORGE="${FORGE:-$HOME/.foundry/bin/forge}"
SOURCIFY="${SOURCIFY:-https://sourcify.dev/server}"
[ -f "$RUN" ] || { echo "no broadcast file at $RUN (has the deploy run?)" >&2; exit 1; }
case "$CHAIN" in 4663|46630) ;; *) [ "${DRY:-0}" = 1 ] || { echo "Sourcify verification is for chains 4663 and 46630, not $CHAIN" >&2; exit 2; } ;; esac
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sourcify.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
with_timeout() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$s" "$@"; }

# name address kind (kind tx = created by a transaction, inner = created inside another constructor)
python3 - "$RUN" >"$WORK/list" <<'PY'
import json, sys
run = json.load(open(sys.argv[1]))
for t in run.get("transactions", []):
    if t.get("transactionType") in ("CREATE", "CREATE2") and t.get("contractAddress"):
        print(t.get("contractName") or "UNKNOWN", t["contractAddress"], "tx")
    for a in t.get("additionalContracts") or []:
        print(a.get("contractName") or "UNKNOWN", a.get("address", "?"), "inner")
PY
LIBS="$(python3 -c 'import json,sys
print(" ".join("--libraries " + l for l in (json.load(open(sys.argv[1])).get("libraries") or [])))' "$RUN")"
[ -s "$WORK/list" ] || { echo "the broadcast created no contracts" >&2; exit 1; }

bad=0
: >"$REPORT"
while read -r name addr kind; do
  if [ "$name" = UNKNOWN ]; then
    echo "MANUAL $addr created inside a constructor ($kind), name unknown: verify by hand" | tee -a "$REPORT"; bad=1; continue
  fi
  pat="^[[:space:]]*(abstract[[:space:]]+)?(contract|library)[[:space:]]+$name([[:space:]]|\{|$)"
  file="$(cd "$CONTRACTS" && grep -rlE "$pat" src script 2>/dev/null | head -1 || true)"
  # Vendored contracts (the OpenZeppelin TimelockController): the copy the remappings resolve, never a test copy.
  [ -n "$file" ] || file="$(cd "$CONTRACTS" && grep -rlE "$pat" lib/openzeppelin-contracts/contracts 2>/dev/null | head -1 || true)"
  if [ -z "$file" ]; then echo "MANUAL $name $addr: no source file declares it" | tee -a "$REPORT"; bad=1; continue; fi
  if [ "${DRY:-0}" = 1 ]; then echo "would verify $name $addr as $file:$name $LIBS"; continue; fi
  # shellcheck disable=SC2086
  (cd "$CONTRACTS" && with_timeout 300 "$FORGE" verify-contract --chain "$CHAIN" --verifier sourcify "$addr" "$file:$name" $LIBS) \
    >"$WORK/out" 2>&1 || { echo "submit failed for $name (last lines):"; tail -3 "$WORK/out"; }
  m=None
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    m="$(curl -s --max-time 20 "$SOURCIFY/v2/contract/$CHAIN/$addr" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("match"))
except Exception: print("None")')"
    [ "$m" != None ] && break
    sleep 10
  done
  echo "$name $addr $m" | tee -a "$REPORT"
  [ "$m" = exact_match ] || bad=1
done <"$WORK/list"
[ "${DRY:-0}" = 1 ] && exit 0
if [ "$bad" = 0 ]; then echo "ALL exact_match" | tee -a "$REPORT"; else echo "NOT all exact_match" | tee -a "$REPORT"; exit 1; fi

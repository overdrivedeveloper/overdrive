#!/bin/bash
# Offline test of the deploy lib's guards (no forge, no network, no key): the arming file must exist and sit inside a
# forge-readable path, the mainnet keystore account default, and the Sourcify verdict per sourcify-verify.sh exit code.
# Usage: /bin/bash app/scripts/deploy/lib.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
T="$(mktemp -d)"
mkdir -p "$BACKEND/.batches"
ARM="$BACKEND/.batches/.lib-test-armed.$$"
trap 'rm -rf "$T" "$ARM"' EXIT
pass=0; fail=0
ok() { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
# expect <label> <0|1> <grep pattern or empty> <command...>: runs the command in a subshell, checks rc and stderr.
expect() {
  local label="$1" want="$2" pat="$3" rc=0; shift 3
  ( "$@" ) >"$T/out" 2>&1 || rc=$?
  if [ "$want" = 0 ] && [ "$rc" != 0 ]; then bad "$label (exit $rc: $(cat "$T/out"))"; return; fi
  if [ "$want" = 1 ] && [ "$rc" = 0 ]; then bad "$label (passed)"; return; fi
  if [ -n "$pat" ] && ! grep -q -- "$pat" "$T/out"; then bad "$label (no '$pat' in: $(cat "$T/out"))"; return; fi
  ok "$label"
}
arm() { OVERDRIVE_ALLOW_FILE="$1" check_allow_file; }

touch "$T/armed" "$ARM"
expect "unset arming file refused" 1 "is missing" env -u OVERDRIVE_ALLOW_FILE bash -c ". '$HERE/lib.sh'; check_allow_file"
expect "missing arming file refused" 1 "is missing" arm "$T/nope"
expect "arming file outside fs_permissions refused" 1 "outside the paths forge may read" arm "$T/armed"
expect "arming file in .batches accepted" 0 "" arm "$ARM"
expect "relative path into .batches accepted" 0 "" bash -c "cd '$BACKEND' && . '$HERE/lib.sh' && OVERDRIVE_ALLOW_FILE=.batches/$(basename "$ARM") check_allow_file"
ESC="$BACKEND/.batches/$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$T/armed" "$BACKEND/.batches")"
expect "dot-dot escape from .batches refused" 1 "outside" arm "$ESC"
[ "$(default_account mainnet)" = overdrive-main-deployer ] && ok "mainnet signs with overdrive-main-deployer" || bad "mainnet account default"
[ "$(default_account testnet)" = overdrive-deployer ] && ok "testnet signs with overdrive-deployer" || bad "testnet account default"
expect "sourcify exact_match passes" 0 "ALL exact_match" sourcify_result 0 security/sourcify-test.txt
expect "sourcify partial match passes with a warning" 0 "WARNING" sourcify_result 3 security/sourcify-test.txt
expect "sourcify unverified stops the run" 1 "not verified" sourcify_result 1 security/sourcify-test.txt
grep -q 'check_allow_file' "$HERE/../deploy-mainnet.sh" && ok "deploy-mainnet.sh checks the arming file" || bad "deploy-mainnet.sh arming check"
# the check runs before the dry run starts anvil (the first network step)
awk '/check_allow_file/ { c = NR } /anvil" --fork-url/ { a = NR } END { exit !(c && a && c < a) }' "$HERE/../deploy-mainnet.sh" \
  && ok "arming check comes before the dry run" || bad "arming check after the dry run"
echo "lib.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

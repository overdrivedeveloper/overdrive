#!/usr/bin/env bash
# Tests .github/scripts/quiet-run.sh: passing and failing commands keep their exit code and leave a log file.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
qr="$here/quiet-run.sh"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$3' got '$2'"; fail=1; fi; }

out="$("$qr" qrtest-pass -- bash -c 'echo hello-pass; exit 0')"; code=$?
check "passing command exits 0" "$code" 0
echo "$out" | grep -q 'hello-pass' && r=yes || r=no
check "passing output shows tail" "$r" yes
logf="$(echo "$out" | sed -n 's/^log: //p')"
[ -f "$logf" ] && r=yes || r=no
check "passing log file exists" "$r" yes

out="$("$qr" qrtest-fail -- bash -c 'echo Suite result: FAILED; echo boom >&2; exit 7')"; code=$?
check "failing command keeps exit code 7" "$code" 7
echo "$out" | grep -q 'exit code: 7' && r=yes || r=no
check "failing exit code printed" "$r" yes
echo "$out" | grep -q 'Suite result: FAILED' && r=yes || r=no
check "forge failure line surfaced" "$r" yes
logf="$(echo "$out" | sed -n 's/^log: //p')"
[ -f "$logf" ] && r=yes || r=no
check "failing log file exists" "$r" yes

"$qr" qrtest-usage >/dev/null 2>&1; check "missing -- is a usage error" "$?" 2
rm -f "$here"/../../.logs/qrtest-*.log
exit "$fail"

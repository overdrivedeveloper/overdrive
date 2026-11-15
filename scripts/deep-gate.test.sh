#!/usr/bin/env bash
# Tests scripts/deep-gate.sh with a fake deep-invariants.sh (no forge): sums calls over seeds and enforces the floor.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir -p "$t/scripts" "$t/contracts/script/ci"; cp "$here/deep-gate.sh" "$t/scripts/"
cat > "$t/contracts/script/ci/deep-invariants.sh" <<'F'
#!/usr/bin/env bash
echo "deep-invariants: system campaign handler calls ${FAKE_CALLS:-50000}"
[ -z "${FAKE_FAIL:-}" ] || exit 1
F
pass=0; fail=0; ok() { echo "ok   $1"; pass=$((pass + 1)); }; bad() { echo "FAIL $1"; fail=$((fail + 1)); }
out="$(bash "$t/scripts/deep-gate.sh" 2>&1)"; rc=$?; [ "$rc" = 0 ] && echo "$out" | grep -q 'total system handler calls 100000' && ok "two seeds of 50,000 reach the floor" || bad "floor met ($rc)"
out="$(bash "$t/scripts/deep-gate.sh" 2>&1)"; rc=$?; [ "$rc" = 0 ] && ok "second run same" || bad "rerun"
DEEP_SEEDS=1 bash "$t/scripts/deep-gate.sh" >/dev/null 2>&1; [ $? = 1 ] && ok "one seed (50,000) is below the floor and fails" || bad "below floor passed"
FAKE_FAIL=1 bash "$t/scripts/deep-gate.sh" >/dev/null 2>&1; [ $? = 1 ] && ok "a failing campaign fails the gate" || bad "failure ignored"
echo "deep-gate.test: $pass passed, $fail failed"; [ "$fail" = 0 ]

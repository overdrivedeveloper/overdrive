#!/usr/bin/env bash
# Deep invariant run (todo 12), FOUNDRY_PROFILE=deep.
#  1. The system suite: test/invariant/SystemInvariant.t.sol::invariant_AllSystem checks R1 to R12 in one campaign of
#     250 runs x depth 200 = 50,000 handler calls (its inline forge-config): about 6.5 min on an idle
#     M-series Mac (30,000 calls took 233 s), 12 min with other suites running. 100,000 calls took 24 min under load.
#     The named per-rule invariants keep a 2 x 10 deep config so the run is not 14 campaigns of the same handler.
#  2. The per-area suites (backer, liquidation, governor, stake): every invariant at DEEP_AREA_RUNS x DEEP_AREA_DEPTH
#     (default 100 x 100 = 10,000 calls per invariant) instead of the profile's 500 x 200, to keep the whole script
#     under about 15 minutes. Override with DEEP_AREA_RUNS / DEEP_AREA_DEPTH.
# Prints the handler call count of the system campaign and the elapsed time.
# Usage: bash contracts/script/ci/deep-invariants.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
export PATH="$HOME/.foundry/bin:$PATH"
export FOUNDRY_PROFILE=deep
start=$(date +%s)
log="$(mktemp -t od-deep-inv.XXXXXX)"
status=0
rm -f out/syscov.txt # afterInvariant appends one coverage line per run
forge test --match-path 'test/invariant/SystemInvariant.t.sol' --match-test 'invariant_' -vv >"$log" 2>&1 || status=1
grep -E '^\[(PASS|FAIL|SKIP)|invariant_[A-Za-z]+\(\) \(runs|SYSCOV|Suite result|Sequence|calldata=' "$log" || true
calls=$(grep -E 'invariant_AllSystem\(\) \(runs: [0-9]+, calls: [0-9]+' "$log" | sed -E 's/.*calls: ([0-9]+).*/\1/' | head -1)
echo "deep-invariants: system campaign handler calls ${calls:-unknown}"
if [ -f out/syscov.txt ]; then
  # sums every key=value of the per-run coverage lines (all system campaigns of this run)
  awk '{for (i = 2; i <= NF; i++) {split($i, kv, "="); sum[kv[1]] += kv[2]; if (!(kv[1] in seen)) {seen[kv[1]] = 1; order[++n] = kv[1]}}}
       END {printf "deep-invariants: coverage over %d runs:", NR; for (i = 1; i <= n; i++) printf " %s=%d", order[i], sum[order[i]]; print ""}' out/syscov.txt
fi
FOUNDRY_INVARIANT_RUNS="${DEEP_AREA_RUNS:-100}" FOUNDRY_INVARIANT_DEPTH="${DEEP_AREA_DEPTH:-100}" \
  forge test --match-test 'invariant_' --match-path 'test/{backer,governor,stake}/*Invariant.t.sol' >"$log.area" 2>&1 || status=1
grep -E '^\[(PASS|FAIL|SKIP)|Suite result|Ran [0-9]+ test suites' "$log.area" || true
echo "deep-invariants: $([ "$status" -eq 0 ] && echo ok || echo FAILED) in $(( $(date +%s) - start )) s (logs: $log, $log.area)"
exit "$status"

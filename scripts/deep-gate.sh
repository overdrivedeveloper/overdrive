#!/usr/bin/env bash
# Deep invariant gate at the skill's floor of 100,000 handler calls (crypto-release-gate / audit-lessons TEST-2).
# The system campaign in contracts/script/ci/deep-invariants.sh is 250 runs x depth 200 = 50,000 calls, so this runs it
# with DEEP_SEEDS different fuzz seeds (default 2) and requires the summed calls to reach DEEP_MIN_CALLS (default 100000).
# Not part of the default ci-local jobs (about 15 to 25 minutes per seed): `scripts/ci-local.sh --only deep` or the manual
# GitHub workflow `deep-invariants`. Usage: bash scripts/deep-gate.sh
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
min="${DEEP_MIN_CALLS:-100000}"; seeds="${DEEP_SEEDS:-2}"
total=0; status=0; i=0
while [ "$i" -lt "$seeds" ]; do
  i=$((i + 1))
  seed="$(printf '0x%04x5eed' "$((i * 7919))")"
  echo "deep-gate: seed $seed ($i of $seeds)"
  out="$(FOUNDRY_FUZZ_SEED="$seed" bash contracts/script/ci/deep-invariants.sh 2>&1)" || status=1
  printf '%s\n' "$out" | grep -E 'deep-invariants:|^\[(PASS|FAIL)' || true
  c="$(printf '%s\n' "$out" | sed -n 's/.*system campaign handler calls \([0-9][0-9]*\).*/\1/p' | head -1)"
  total=$((total + ${c:-0}))
done
echo "deep-gate: total system handler calls $total (floor $min)"
[ "$total" -ge "$min" ] || { echo "deep-gate: FAILED, fewer than $min calls"; status=1; }
[ "$status" -eq 0 ] && echo "deep-gate: ok" || echo "deep-gate: FAILED"
exit "$status"

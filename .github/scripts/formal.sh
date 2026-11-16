#!/usr/bin/env bash
# FORMAL: Halmos symbolic checks (contracts/test/halmos), run SEPARATELY from ci-local (a full run took over an hour
# per contract on this machine). Bounded: FORMAL_TIMEOUT seconds in all (default 540), after which the run FAILS.
# FORMAL_ONLY (default check_StepNeverBelowMin) picks the check functions. --record writes security/halmos.md.
# Needs halmos on PATH (pipx install halmos). Usage: bash .github/scripts/formal.sh [--record]
# Nightly (unbounded, hours): FORMAL_TIMEOUT=0 is not supported; run halmos directly:
#   halmos --root contracts --contract NormSymbolic && halmos --root contracts --contract SystemSymbolic
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
command -v halmos >/dev/null || { echo "halmos: not on PATH (pipx install halmos)" >&2; exit 1; }
log="$(mktemp)"; trap 'rm -f "$log"' EXIT
fail=0
only="${FORMAL_ONLY:-check_StepNeverBelowMin}"
if ! (cd "$root" && perl -e 'alarm shift; exec @ARGV' "${FORMAL_TIMEOUT:-540}" \
    halmos --root contracts --contract NormSymbolic --function "$only" --solver-timeout-assertion 60s) >>"$log" 2>&1; then
  echo "[TIMEOUT] or error: the bounded run did not finish cleanly" >>"$log"; fail=1
fi
# halmos colours its result tags; strip ANSI escapes so the [PASS]/[FAIL] greps below see them.
perl -pi -e 's/\e\[[0-9;]*m//g' "$log"
# A check that did not prove (counterexample, timeout, error) prints [FAIL], [TIMEOUT] or [ERROR].
grep -qE '^\[(FAIL|TIMEOUT|ERROR)\]' "$log" && fail=1
npass="$(grep -cE '^\[PASS\]' "$log" || true)"
[ "$npass" -gt 0 ] || fail=1
grep -E '^\[(PASS|FAIL|TIMEOUT|ERROR)\]|^Symbolic test result' "$log"
if [ "${1:-}" = "--record" ]; then
  {
    printf '# Halmos symbolic checks (FORMAL)\n\nRun %s on commit `%s` with %s. Rerun: `bash .github/scripts/formal.sh`.\n' \
      "$(date -u +%Y-%m-%d)" "$(git -C "$root" rev-parse --short HEAD)" "$(halmos --version 2>&1 | tail -1)"
    printf 'Result: %s, %s checks proved.\n\n```\n' "$([ "$fail" = 0 ] && echo PASS || echo FAIL)" "$npass"
    grep -E '^\[(PASS|FAIL|TIMEOUT|ERROR)\]|^Symbolic test result|^Running' "$log"
    # A loop-bound WARNING means the proof covers paths up to the unrolling bound only (a bounded proof).
    grep -A2 '^WARNING' "$log" | sed 's/[[:space:]]*$//'
    printf '```\n'
    cat <<'TABLE'

## Every symbolic check: proved here, or which fuzz/invariant test covers the property instead

Only the check above runs inside the 540 s bound, and it is a BOUNDED proof (loop unrolling bound 2, see the WARNING).
The others did not finish in the bound on this machine (2026-11-16: check_StepNeverIncreasesForPositiveToll alone
ran past 540 s; an earlier unbounded run took about 61 min for NormSymbolic and was stopped at 1h42m for
SystemSymbolic). No proof is claimed for them; the property is held by the named fuzz or invariant test in the gate,
and the unbounded run stays a nightly command (header of .github/scripts/formal.sh).

| Check | In the 540 s run | Property also held by (gate) |
|---|---|---|
| NormSymbolic.check_StepNeverBelowMin | proved, bounded | test/math/NormFuzz.t.sol testFuzz_StepBounds |
| NormSymbolic.check_StepNeverIncreasesForPositiveToll | timed out at 540 s | NormFuzz testFuzz_StepBounds (positive toll: non-increasing); invariant/SystemInvariant.t.sol invariant_NfMonotone |
| SystemSymbolic.check_IndexMonotone_SPORT, _RACE, _CRUISE, _ECO, _REVERSE | not run (over an hour) | test/math/IndexFuzz.t.sol testFuzz_Monotone, testFuzz_ValueMonotoneInPrice |
| SystemSymbolic.check_TollSignMatchesGear | not run | test/math/Toll.t.sol testFuzz_TollClampNeverReverts (+-400%/yr bound), test_SpecExamples |
| SystemSymbolic.check_GapRateIsWorseOf | not run | Toll.t.sol testFuzz_GapRateIsMax, test_GapRateNeverFavoursCaller |
| SystemSymbolic.check_NormStepBounds | not run | NormFuzz testFuzz_StepBounds |
TABLE
  } >"$root/security/halmos.md"
fi
exit "$fail"

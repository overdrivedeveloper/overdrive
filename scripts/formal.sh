#!/usr/bin/env bash
# FORMAL: Halmos symbolic checks (contracts/test/halmos), run SEPARATELY from ci-local (a full run took over an hour
# per contract on this machine). Bounded: FORMAL_TIMEOUT seconds in all (default 540), after which the run FAILS.
# FORMAL_ONLY (default check_StepNeverBelowMin) picks the check functions. --record writes .audit-grade/halmos.md.
# Needs halmos on PATH (pipx install halmos). Usage: bash scripts/formal.sh [--record]
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
command -v halmos >/dev/null || { echo "halmos: not on PATH (pipx install halmos)" >&2; exit 1; }
log="$(mktemp)"; trap 'rm -f "$log"' EXIT
fail=0
only="${FORMAL_ONLY:-check_StepNeverBelowMin}"
if ! (cd "$root" && perl -e 'alarm shift; exec @ARGV' "${FORMAL_TIMEOUT:-540}" \
    halmos --root contracts --contract NormSymbolic --function "$only" --solver-timeout-assertion 60s) >>"$log" 2>&1; then
  echo "[TIMEOUT] or error: the bounded run did not finish cleanly" >>"$log"; fail=1
fi
# A check that did not prove (counterexample, timeout, error) prints [FAIL], [TIMEOUT] or [ERROR].
grep -qE '^\[(FAIL|TIMEOUT|ERROR)\]' "$log" && fail=1
npass="$(grep -cE '^\[PASS\]' "$log" || true)"
[ "$npass" -gt 0 ] || fail=1
grep -E '^\[(PASS|FAIL|TIMEOUT|ERROR)\]|^Symbolic test result' "$log"
if [ "${1:-}" = "--record" ]; then
  {
    printf '# Halmos symbolic checks (FORMAL)\n\nRun %s on commit `%s` with %s. Rerun: `bash scripts/formal.sh`.\n' \
      "$(date -u +%Y-%m-%d)" "$(git -C "$root" rev-parse --short HEAD)" "$(halmos --version 2>&1 | tail -1)"
    printf 'Result: %s, %s checks proved.\n\n```\n' "$([ "$fail" = 0 ] && echo PASS || echo FAIL)" "$npass"
    grep -E '^\[(PASS|FAIL|TIMEOUT|ERROR)\]|^Symbolic test result|^Running' "$log"
    printf '```\n'
  } >"$root/.audit-grade/halmos.md"
fi
exit "$fail"

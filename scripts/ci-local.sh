#!/usr/bin/env bash
# Local CI: runs the same jobs, with the same commands, as .github/workflows/ci.yml.
# The workflow skips itself on a private repository, so this script is the CI for the private repo.
# Usage: scripts/ci-local.sh [--only job[,job...]] [--list]     jobs: hygiene semgrep contracts app guard scripts
# Logs: .ci-local/logs/<timestamp>/<job>.log. Exit status 0 only if no job failed. Fork tests skip without RHC_RPC_URL.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-experimental-webstorage"
JOBS="hygiene semgrep contracts app guard scripts"
only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) only="$2"; shift 2 ;;
    --list) for j in $JOBS; do echo "$j"; done; exit 0 ;;
    *) echo "ci-local: unknown argument $1" >&2; exit 2 ;;
  esac
done
logdir="$root/.ci-local/logs/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$logdir"

# Oracle rule R7: a missing reference must never skip a check ("if (ref != 0) x = worseOf(x, ref)" is banned).
check_no_failopen_pattern() {
  if grep -rnE '!= 0\) .*worse' contracts/src/oracle; then
    echo "check_no_failopen_pattern: fail-open shape found in contracts/src/oracle" >&2
    return 1
  fi
}
# Stake rule R9: outside src/stake and src/interfaces, no contract reads stake beyond feeDiscountOf and slash
# (votes are on markets and caps only; they never move toll maths, NF or pricing).
check_stake_usage() {
  local bad
  bad=$(grep -rlE 'votingPower|IODStake[ ;}(]' contracts/src --include='*.sol' | grep -vE '^contracts/src/(stake|interfaces)/' \
    | xargs grep -nE 'votingPower|\.(coverValueUsdg|stake|requestUnstake|unstake|claimRewards)\(' 2>/dev/null)
  if [ -n "$bad" ]; then
    echo "check_stake_usage: a core contract reads stake beyond feeDiscountOf/slash:" >&2
    echo "$bad" >&2
    return 1
  fi
}
# hygiene and semgrep need gitleaks and semgrep on PATH (brew install gitleaks; pipx install semgrep); a missing tool fails.
job_hygiene() {
  python3 .github/scripts/check-hygiene.py && python3 .github/scripts/readme-deployments.py --check \
    && gitleaks git . --config .github/gitleaks.toml --redact --no-banner
}
job_semgrep() { bash .github/scripts/semgrep.sh; }
job_contracts() { check_no_failopen_pattern && check_stake_usage && (cd contracts && forge fmt --check && forge build && forge test); }
job_app() { (cd app && bun install --frozen-lockfile && bun test && bunx tsc --noEmit); }
job_guard() { .githooks/public-guard.sh && bash scripts/guard.test.sh; }
job_scripts() { node --test exit/test/exit.test.mjs && bash scripts/quiet-run.test.sh && scripts/export-abis.sh && bash app/scripts/server/deploy-local.test.sh; }

failed=0
for j in $JOBS; do
  if [ -n "$only" ]; then case ",$only," in *",$j,"*) ;; *) continue ;; esac; fi
  if "job_$j" >"$logdir/$j.log" 2>&1; then echo "ci-local: $j ok"; else echo "ci-local: $j FAILED (see $logdir/$j.log)"; tail -15 "$logdir/$j.log"; failed=1; fi
done
if [ "$failed" -eq 0 ]; then echo "ci-local: all jobs green"; fi
exit "$failed"

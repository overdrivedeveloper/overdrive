#!/usr/bin/env bash
# Local CI: runs the same jobs, with the same commands, as .github/workflows/ci.yml.
# The workflow skips itself on a private repository, so this script is the CI for the private repo.
# Usage: scripts/ci-local.sh [--only job[,job...]] [--list]     jobs: hygiene semgrep contracts app guard scripts python web sdk slither
# On an all-green run on a clean tree it writes .ci-local/green/<sha>.json; .githooks/pre-push refuses a push without it.
# Logs: .ci-local/logs/<timestamp>/<job>.log. Exit status 0 only if no job failed. Fork tests skip without RHC_RPC_URL.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-experimental-webstorage"
# Private RPC (owner-saved, chmod 600, never printed): loaded only when the env var is not already set.
if [ -z "${RHC_RPC_URL:-}" ] && [ -f "$HOME/.config/overdrive/rpc.env" ]; then set -a; . "$HOME/.config/overdrive/rpc.env"; set +a; fi
# slither runs last: it does a forge clean, and the app ABI test would then rebuild everything inside its 120 s limit.
# One shared RPC (Alchemy free tier or public) answers 429 in bursts: throttle forge (retry flags need --rpc-url, so none).
FORK_FLAGS="--compute-units-per-second 100"
JOBS="hygiene semgrep contracts app guard scripts python web sdk slither"
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
# Todo 11 R5: contracts/privileged-functions.json equals the guarded functions found in the sources.
check_privileged_functions() { (cd contracts && python3 script/ci/privileged-functions.py --check); }
# Todo 11 R11: every src contract stays under the 24,576-byte EIP-170 limit (reads the forge build output).
check_code_size() { (cd contracts && python3 script/ci/code-size.py out >/dev/null); }
# hygiene and semgrep need gitleaks and semgrep on PATH (brew install gitleaks; pipx install semgrep); a missing tool fails.
job_hygiene() {
  python3 .github/scripts/check-hygiene.py && python3 .github/scripts/readme-deployments.py --check \
    && gitleaks git . --config .github/gitleaks.toml --redact --no-banner
}
job_semgrep() { bash .github/scripts/semgrep.sh; }
job_contracts() { check_no_failopen_pattern && check_stake_usage && check_privileged_functions && (cd contracts && forge fmt --check && forge build) && check_code_size && (cd contracts && forge test $FORK_FLAGS); }
job_slither() { bash scripts/slither.sh; }
job_app() { (cd app && bun install --frozen-lockfile && bun test && bunx tsc --noEmit); }
job_guard() { .githooks/public-guard.sh && bash scripts/guard.test.sh && bash scripts/pre-push.test.sh; }
job_scripts() { node --test exit/test/exit.test.mjs && bash scripts/quiet-run.test.sh && scripts/export-abis.sh && bash app/scripts/server/deploy-local.test.sh; }
job_web() { (cd web && npm ci --ignore-scripts && npx tsc --noEmit && npm run build && bun test); }
job_sdk() { (cd sdk && bun install --frozen-lockfile && bun run generate:check && bun test && bunx tsc --noEmit -p tsconfig.json); }
job_python() { bash scripts/check-python-locks.sh; }

failed=0
ran=""
for j in $JOBS; do
  if [ -n "$only" ]; then case ",$only," in *",$j,"*) ;; *) continue ;; esac; fi
  ran="$ran $j"
  if "job_$j" >"$logdir/$j.log" 2>&1; then echo "ci-local: $j ok"; else echo "ci-local: $j FAILED (see $logdir/$j.log)"; tail -15 "$logdir/$j.log"; failed=1; fi
done
if [ "$failed" -eq 0 ]; then
  echo "ci-local: all jobs green"
  # Stamp: proof that these jobs passed on this exact tree. Only a clean tracked tree can be stamped (else the
  # run tested something the commit does not contain). The pre-push hook matches on the tree hash.
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "ci-local: tracked files are modified, no stamp written (commit first, then rerun)"
  elif [ -n "$ran" ]; then
    sha="$(git rev-parse HEAD)"; tree="$(git rev-parse 'HEAD^{tree}')"
    mkdir -p "$root/.ci-local/green"
    jobs_json="$(printf '%s\n' $ran | sed 's/.*/"&"/' | paste -sd, -)"
    {
      printf '{\n  "commit": "%s",\n  "tree": "%s",\n  "jobs": [%s],\n  "utc": "%s",\n' "$sha" "$tree" "$jobs_json" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '  "tools": {"bun": "%s", "node": "%s", "forge": "%s", "python": "%s"}\n}\n' \
        "$(bun --version 2>/dev/null)" "$(node --version 2>/dev/null)" "$(forge --version 2>/dev/null | head -1)" "$(python3 --version 2>/dev/null)"
    } > "$root/.ci-local/green/$sha.json"
    echo "ci-local: stamp .ci-local/green/$sha.json"
  fi
fi
exit "$failed"

#!/usr/bin/env bash
# Local CI: runs the same jobs, with the same commands, as .github/workflows/ci.yml.
# The workflow skips itself on a private repository, so this script is the CI for the private repo.
# Usage: .github/scripts/ci-local.sh [--only job[,job...]] [--list]     jobs: hygiene semgrep contracts app guard scripts python web sdk slither
# On an all-green run on a clean tree it writes .ci-local/green/<sha>.json with the list of jobs that ran and
# "scope": "full" or "subset". .githooks/pre-push refuses a push unless a stamp for the tree lists every required job
# (all of them, contracts and slither included), so an --only run never opens the gate by itself.
# Logs: .ci-local/logs/<timestamp>/<job>.log. Exit status 0 only if no job failed. Fork tests skip without RHC_RPC_URL.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-experimental-webstorage"
# Private RPC (owner-saved, chmod 600, never printed): loaded only when the env var is not already set.
if [ -z "${RHC_RPC_URL:-}" ] && [ -f "$HOME/.config/overdrive/rpc.env" ]; then set -a; . "$HOME/.config/overdrive/rpc.env"; set +a; fi
# slither runs last: it does a forge clean, and the app ABI test would then rebuild everything inside its 120 s limit.
# One shared RPC (Alchemy free tier or public) answers 429 in bursts: throttle forge (retry flags need --rpc-url, so none).
FORK_FLAGS="--compute-units-per-second 100"
JOBS="hygiene semgrep contracts app guard scripts python web sdk slither"
# deep is manual (15 to 25 min per seed, 100,000 handler calls): `.github/scripts/ci-local.sh --only deep`; never in the default run.
# coverage is manual too (`--only coverage`, floor in security/audit-grade/coverage.md). Halmos is NOT in ci-local: .github/scripts/formal.sh.
RUNJOBS="$JOBS"
only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) only="$2"; RUNJOBS="$JOBS deep coverage"; shift 2 ;;
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
# Audit scope: contracts/AUDIT-SCOPE.md lists every file under contracts/src (the list the audit tag freezes).
check_audit_scope() { (cd contracts && python3 script/ci/audit-scope.py --check); }
# NatSpec: every public or external function under contracts/src has a NatSpec comment (@inheritdoc counts).
# Slither inline exceptions: every slither-disable in contracts/src has a justified row in contracts/SLITHER.md.
check_slither_exceptions() { (cd contracts && python3 script/ci/slither-exceptions.py --check); }
# PRIV-2: contracts/ROLES.md and the deploy configs agree with the published role holders.
check_roles_table() { (cd contracts && python3 script/ci/roles-table.py --check); }
check_natspec() { (cd contracts && python3 script/ci/natspec.py --self-test && python3 script/ci/natspec.py --check); }
# Todo 11 R11: every src contract stays under the 24,576-byte EIP-170 limit (reads the forge build output).
check_code_size() { (cd contracts && python3 script/ci/code-size.py out >/dev/null); }
# hygiene and semgrep need gitleaks and semgrep on PATH (brew install gitleaks; pipx install semgrep); a missing tool fails.
job_hygiene() {
  python3 .github/scripts/check-hygiene.py && python3 .github/scripts/readme-deployments.py --check \
    && gitleaks git . --config .github/gitleaks.toml --redact --no-banner
}
job_semgrep() { bash .github/scripts/semgrep.sh; }
job_contracts() { check_no_failopen_pattern && check_stake_usage && check_privileged_functions && check_audit_scope && check_natspec && check_slither_exceptions && check_roles_table && (cd contracts && forge fmt --check && forge build) && check_code_size && (cd contracts && forge test $FORK_FLAGS); }
job_slither() { bash .github/scripts/slither.sh; }
job_app() { (cd app && bun install --frozen-lockfile && bun test && bunx tsc --noEmit); }
job_guard() { .githooks/public-guard.sh && bash .github/scripts/guard.test.sh && bash .github/scripts/pre-push.test.sh; }
job_scripts() { node --test web/exit/test/exit.test.mjs && bash .github/scripts/quiet-run.test.sh && bash .github/scripts/deep-gate.test.sh && .github/scripts/export-abis.sh && bash app/scripts/server/deploy-local.test.sh && bash contracts/script/ci/sourcify-verify.test.sh; }
job_web() { (cd web && npm ci --ignore-scripts && npx tsc --noEmit && npm run build && bun test); }
job_sdk() { (cd sdk && bun install --frozen-lockfile && bun run generate:check && bun test && bunx tsc --noEmit -p tsconfig.json); }
job_deep() { bash .github/scripts/deep-gate.sh; }
job_coverage() { bash .github/scripts/coverage.sh && python3 .github/scripts/coverage-floor.py contracts/coverage/summary.md security/audit-grade/coverage.md; }
job_python() { bash .github/scripts/check-python-locks.sh; }

failed=0
ran=""
for j in $RUNJOBS; do
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
      scope=full; [ "$(echo $ran)" = "$JOBS" ] || scope=subset
      printf '{\n  "commit": "%s",\n  "tree": "%s",\n  "scope": "%s",\n  "jobs": [%s],\n  "utc": "%s",\n' "$sha" "$tree" "$scope" "$jobs_json" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '  "tools": {"bun": "%s", "node": "%s", "forge": "%s", "python": "%s"}\n}\n' \
        "$(bun --version 2>/dev/null)" "$(node --version 2>/dev/null)" "$(forge --version 2>/dev/null | head -1)" "$(python3 --version 2>/dev/null)"
    } > "$root/.ci-local/green/$sha.json"
    echo "ci-local: stamp .ci-local/green/$sha.json ($scope:$ran)"
    [ "$scope" = full ] || echo "ci-local: a subset stamp does not open the push gate (run without --only)"
  fi
fi
exit "$failed"

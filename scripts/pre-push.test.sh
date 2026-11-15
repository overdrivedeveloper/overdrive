#!/usr/bin/env bash
# Tests .githooks/pre-push in a throwaway repo: refused without a stamp, refused with an incomplete stamp,
# accepted with a full stamp for the same tree, accepted (and logged) with the override, and a deletion is not gated.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
hook="$root/.githooks/pre-push"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0
cd "$tmp" && git init -q . && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false
echo a > a && git add a && git commit -qm "test: one"
sha="$(git rev-parse HEAD)"; tree="$(git rev-parse 'HEAD^{tree}')"
run() { printf 'refs/heads/main %s refs/heads/main 0000000000000000000000000000000000000000\n' "$sha" | "$@" bash "$hook" >"$tmp/out" 2>&1; }
check() { # name want-exit
  if [ "$rc" -eq "$2" ]; then echo "ok   $1"; else echo "FAIL $1 (exit $rc, wanted $2)"; cat "$tmp/out"; fail=1; fi
}
run env; rc=$?; check "refuses without a stamp" 1
grep -q "no all-green" "$tmp/out" || { echo "FAIL message missing"; fail=1; }
mkdir -p .ci-local/green
printf '{"commit":"x",\n "tree": "%s",\n "jobs": ["hygiene"]}\n' "$tree" > .ci-local/green/x.json
run env; rc=$?; check "refuses an incomplete stamp" 1
printf '{"commit":"x",\n "tree": "%s",\n "jobs": ["hygiene","semgrep","contracts","app","guard","scripts","python","web","sdk","slither"]}\n' "$tree" > .ci-local/green/x.json
run env; rc=$?; check "accepts a full stamp for the tree" 0
# the old required set (no contracts, no slither) is a subset now
printf '{"commit":"x",\n "tree": "%s",\n "scope": "subset",\n "jobs": ["hygiene","semgrep","app","guard","scripts","python","web","sdk"]}\n' "$tree" > .ci-local/green/x.json
run env; rc=$?; check "refuses a subset stamp without contracts and slither" 1
grep -q "subset does not count" "$tmp/out" || { echo "FAIL subset message missing"; fail=1; }
# tool names in the stamp ("forge", "python") never stand in for a job; nor does "contracts" outside the jobs line
printf '{"commit":"contracts slither",\n "tree": "%s",\n "jobs": ["hygiene","semgrep","app","guard","scripts","web","sdk"],\n "tools": {"python": "3", "forge": "1", "contracts": "x", "slither": "x"}}\n' "$tree" > .ci-local/green/x.json
run env; rc=$?; check "refuses a stamp that names jobs only outside the jobs list" 1
printf '{"commit":"x",\n "tree": "%s",\n "jobs": ["hygiene","semgrep","contracts","app","guard","scripts","python","web","sdk","slither"]}\n' "$tree" > .ci-local/green/x.json
run env; rc=$?; check "accepts the full stamp again" 0
printf '{"commit":"x",\n "tree": "%s",\n "jobs": ["hygiene","semgrep","contracts","app","guard","scripts","python","web","sdk","slither"]}\n' "0000" > .ci-local/green/x.json
run env; rc=$?; check "refuses a stamp for another tree" 1
printf '{"commit":"x",\n "tree": "%s",\n "jobs": ["hygiene"]}\n' "$tree" > .ci-local/green/x.json
run env OD_REQUIRED_JOBS="hygiene"; rc=$?; check "a narrowed required set is honoured" 0
grep -q "dropped: semgrep contracts" .ci-local/overrides.log && echo "ok   narrowed set logged" || { echo "FAIL narrowed set not logged"; fail=1; }
run env OD_SKIP_CI_GATE="test emergency"; rc=$?; check "override allows" 0
grep -q "test emergency" .ci-local/overrides.log && echo "ok   override logged" || { echo "FAIL override not logged"; fail=1; }
printf 'refs/heads/gone 0000000000000000000000000000000000000000 refs/heads/gone %s\n' "$sha" | rm -f .ci-local/green/x.json
printf 'refs/heads/gone 0000000000000000000000000000000000000000 refs/heads/gone %s\n' "$sha" | bash "$hook" >/dev/null 2>&1; rc=$?; check "deleting a ref is not gated" 0
[ "$fail" -eq 0 ] && echo "pre-push.test: all ok"
exit "$fail"

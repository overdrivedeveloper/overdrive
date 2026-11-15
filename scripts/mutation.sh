#!/usr/bin/env bash
# Mutation testing of the money and safety contracts (macOS bash 3.2).
#
# 1. gen.py asks the slither-mutate mutators (RR, CR, ROR, LOR, AOR, ASOR, BOR, UOR, LIR, MIA, MVIE,
#    MVIV, MWA, FHR, SBR) for every mutant of each target contract, read from a src-only forge build-info.
# 2. run.py samples MUTATION_SAMPLE mutants per contract (fixed seed) and runs them in MUTATION_JOBS private
#    copies of contracts/ against the owning suites (narrow scope), hermetic: RHC_RPC_URL is unset, so
#    fork suites are not even compiled.
# 3. Survivors are re-run against every hermetic suite that reaches the contract (broad scope).
# 4. summary.py writes the per-contract table to $OUT/summary.md.
#
# Env: MUTATION_JOBS (default 4), MUTATION_SAMPLE (default 35, 0 = all), MUTATION_SEED (default 1115),
#      MUTATION_TIMEOUT seconds per mutant (default 900), MUTATION_OUT (default .mutation/), MUTATION_ONLY
#      (comma-separated mutant ids: rerun just those, e.g. to show a new test kills them).
#      MUTATION_EXCLUDE (regex of test files to leave out, e.g. MutationKills to score the tree before the
#      tests that mutation testing added).
# Verdicts in $OUT/cache-narrow.jsonl and cache-broad.jsonl (an earlier run, same tree) are reused, not rerun.
# Usage: scripts/mutation.sh [ContractName ...]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
unset RHC_RPC_URL
command -v slither-mutate >/dev/null || { echo "mutation: slither-analyzer not installed" >&2; exit 1; }
slither_py="$(head -1 "$(command -v slither-mutate)" | sed 's/^#!//')"

jobs="${MUTATION_JOBS:-4}"
sample="${MUTATION_SAMPLE:-35}"
seed="${MUTATION_SEED:-1115}"
timeout="${MUTATION_TIMEOUT:-900}"
out="${MUTATION_OUT:-$root/.mutation}"
only="${MUTATION_ONLY:-}"
exclude="${MUTATION_EXCLUDE:-}"
mkdir -p "$out/work"

if [ "$#" -gt 0 ]; then targets="$*"; else targets="ODMinter ODBacker ODGovernor ODOracleGuard ODMarketHours ODHook"; fi

if [ ! -s "$out/mutants.jsonl" ]; then
  # src-only build with full build-info (what slither reads); seconds with the optimiser off
  gen="$out/work/gen"
  rm -rf "$gen"; mkdir -p "$gen"
  cp -R "$root/contracts/src" "$gen/src"
  ln -s "$root/contracts/lib" "$gen/lib"
  cp "$root/contracts/foundry.toml" "$root/contracts/remappings.txt" "$gen/"
  (cd "$gen" && FOUNDRY_OPTIMIZER=false forge build --build-info >/dev/null)
  # shellcheck disable=SC2086
  "$slither_py" "$root/scripts/mutation/gen.py" "$gen" "$out/mutants.jsonl" $targets
fi

cargs=""
for t in $targets; do cargs="$cargs --contract $t"; done

if [ -n "$only" ]; then
  # shellcheck disable=SC2086
  python3 "$root/scripts/mutation/run.py" --contracts "$root/contracts" --mutants "$out/mutants.jsonl" \
    --out "$out/rerun.jsonl" --work "$out/work" --jobs "$jobs" --timeout "$timeout" --scope broad \
    --no-optimizer --only "$only" $cargs
  python3 "$root/scripts/mutation/summary.py" "$out/rerun.jsonl" > "$out/rerun-summary.md"
  cat "$out/rerun-summary.md"
  exit 0
fi

# shellcheck disable=SC2086
python3 "$root/scripts/mutation/run.py" --contracts "$root/contracts" --mutants "$out/mutants.jsonl" \
  --out "$out/narrow.jsonl" --work "$out/work" --jobs "$jobs" --sample "$sample" --seed "$seed" \
  --timeout "$timeout" --scope narrow --no-optimizer --exclude "$exclude" --cache "$out/cache-narrow.jsonl" $cargs

survivors="$(python3 -c 'import json,sys
print(",".join(r["id"] for r in map(json.loads, open(sys.argv[1])) if r["verdict"] == "survived"))' "$out/narrow.jsonl")"
if [ -n "$survivors" ]; then
  # shellcheck disable=SC2086
  python3 "$root/scripts/mutation/run.py" --contracts "$root/contracts" --mutants "$out/mutants.jsonl" \
    --out "$out/broad.jsonl" --work "$out/work" --jobs "$jobs" --timeout "$timeout" --scope broad \
    --no-optimizer --exclude "$exclude" --only "$survivors" --cache "$out/cache-broad.jsonl" $cargs
fi

python3 "$root/scripts/mutation/summary.py" "$out/narrow.jsonl" "$out/broad.jsonl" > "$out/summary.md"
cat "$out/summary.md"

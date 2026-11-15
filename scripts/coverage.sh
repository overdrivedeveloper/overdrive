#!/usr/bin/env bash
# Line, branch and function coverage of contracts/src from the hermetic Foundry suite (no fork RPC).
# Writes contracts/coverage/lcov.info (raw), contracts/coverage/forge-summary.txt (forge table) and
# contracts/coverage/summary.md (src/ totals and one row per file, from the lcov). Output is gitignored.
#
# Why the flags:
# - `--ir-minimum`: the code needs via_ir, and the unoptimised legacy pipeline coverage normally uses hits
#   stack too deep. Source mappings under via_ir are approximate, so the numbers are a floor, not exact.
# - `--skip SystemInvariant --skip SystemHandler`: test/invariant/SystemHandler.sol (the stateful system
#   handler, the only file that fails) is stack too deep under --ir-minimum. It is test code, so it is left out
#   of the coverage build; it still runs in the normal `forge test`. No file under src/ is excluded.
# - `--no-match-test GasBound`: the gas ceiling tests, named `..._GasBound` (test_DiscountGasBound, 30k gas;
#   test_FallbackCalendar_GasBound, test_R8_2_ListLength_GasBound, test_R8_2_GuardMidWeek_FullList_GasBound
#   and test_QuietFeed70Hours_GasBound, the calendar walk against the guard's 300,000 gas read). The coverage build is unoptimised and instrumented,
#   so they fail only here. They run and pass in the normal `forge test`. Nothing else is left out by this flag:
#   a test must have the suffix to be skipped.
# - `--no-match-coverage`: report only contracts/src (tests, scripts and libraries are not counted).
# - RHC_RPC_URL is unset, so every fork test skips itself and the run is reproducible offline.
# Usage: bash scripts/coverage.sh        (about 10 to 15 minutes; the coverage build is not cached)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$root/contracts"
out="coverage"
mkdir -p "$out"
unset RHC_RPC_URL

FOUNDRY_PROFILE=coverage forge coverage --ir-minimum \
    --skip SystemInvariant --skip SystemHandler \
    --no-match-test GasBound \
    --no-match-coverage '(^|/)(test|script|lib)/' \
    --report summary --report lcov --report-file "$out/lcov.info" \
    > "$out/forge-summary.txt" 2>&1 || { tail -n 40 "$out/forge-summary.txt" >&2; exit 1; }

[ -s "$out/lcov.info" ] || { echo "coverage: no lcov written" >&2; exit 1; }

# Totals and per-file rows for src/ only, straight from the lcov records.
awk -v date="$(date -u +%Y-%m-%d)" -v sha="$(git rev-parse --short HEAD)" '
function pct(h, f) { return f == 0 ? "n/a" : sprintf("%.2f%%", 100 * h / f) }
/^SF:/ { file = substr($0, 4); sub(/^.*contracts\//, "", file); keep = (file ~ /^src\//) }
keep && /^LF:/  { lf[file] += substr($0, 4) }
keep && /^LH:/  { lh[file] += substr($0, 4) }
keep && /^BRF:/ { bf[file] += substr($0, 5) }
keep && /^BRH:/ { bh[file] += substr($0, 5) }
keep && /^FNF:/ { ff[file] += substr($0, 5) }
keep && /^FNH:/ { fh[file] += substr($0, 5) }
keep && /^end_of_record/ { seen[file] = 1 }
END {
    n = 0
    for (f in seen) { names[++n] = f }
    for (i = 2; i <= n; i++) { v = names[i]; j = i - 1; while (j > 0 && names[j] > v) { names[j + 1] = names[j]; j-- } names[j + 1] = v }
    printf "# Coverage of contracts/src (%s, %s)\n\n", date, sha
    printf "| File | Lines | Branches | Functions |\n|---|---|---|---|\n"
    for (i = 1; i <= n; i++) {
        f = names[i]
        if (lf[f] == 0 && ff[f] == 0) continue
        printf "| %s | %s (%d/%d) | %s (%d/%d) | %s (%d/%d) |\n", f, pct(lh[f], lf[f]), lh[f], lf[f], pct(bh[f], bf[f]), bh[f], bf[f], pct(fh[f], ff[f]), fh[f], ff[f]
        LH += lh[f]; LF += lf[f]; BH += bh[f]; BF += bf[f]; FH += fh[f]; FF += ff[f]
    }
    printf "| **src/ total** | **%s** (%d/%d) | **%s** (%d/%d) | **%s** (%d/%d) |\n", pct(LH, LF), LH, LF, pct(BH, BF), BH, BF, pct(FH, FF), FH, FF
}' "$out/lcov.info" > "$out/summary.md"

tail -n 1 "$out/summary.md"
echo "coverage: wrote $out/lcov.info, $out/forge-summary.txt, $out/summary.md"

#!/usr/bin/env bash
# Tests the public guard: a temp untracked file holding one banned word must make it fail; removing it must pass.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
guard="$root/.githooks/public-guard.sh"
fail=0
tmp="$root/guardtest-tmp.txt"
trap 'rm -f "$tmp"' EXIT

# Words are built by concatenation so this file never contains them.
w1="ren""t"; w2="car""ry"; w3="writ""ers"; w4="yie""ld"; w5="ap""y"; w6="guarantee""d"; w7="risk""-free"; w8="squa""red"; w9="cr""ab"; w10="divid""ends"; w11="divid""end"; w12="revenue"" share"
for w in "$w1" "$w2" "$w3" "$w4" "$w5" "$w6" "$w7" "$w8" "$w9" "$w10" "$w11" "$w12"; do
  echo "the $w here" > "$tmp"
  if "$guard" >/dev/null 2>&1; then echo "FAIL denylist_catches_vocab: '$w' not caught"; fail=1; else echo "ok   caught '$w'"; fi
done
# whole word only: a longer word containing the banned letters must not trip it
echo "current parent carrying" > "$tmp"
if "$guard" >/dev/null 2>&1; then echo "ok   whole-word match only"; else echo "FAIL whole-word: longer words tripped the guard"; fail=1; fi
rm -f "$tmp"
if "$guard" >/dev/null 2>&1; then echo "ok   tree clean after removing the temp file"; else echo "FAIL tree not clean"; "$guard" | head -5; fail=1; fi
exit "$fail"

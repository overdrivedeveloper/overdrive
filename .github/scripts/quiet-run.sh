#!/usr/bin/env bash
# Usage: .github/scripts/quiet-run.sh <name> -- <command...>
# Runs the command, saves the full output to .logs/<name>-<UTC timestamp>.log, prints only the command, the exit
# code, the last 25 lines and (for forge output) every line matching the failure patterns. Exits with the command's code.
# macOS bash 3.2 safe: no mapfile, no negative array index, no empty-array expansion under set -u.
set -u
if [ $# -lt 3 ] || [ "$2" != "--" ]; then
  echo "usage: quiet-run.sh <name> -- <command...>" >&2
  exit 2
fi
name="$1"
shift 2
root="$(cd "$(dirname "$0")/../.." && pwd)"
logdir="$root/.logs"
mkdir -p "$logdir"
log="$logdir/$name-$(date -u +%Y%m%dT%H%M%SZ).log"
"$@" >"$log" 2>&1
code=$?
echo "command: $*"
echo "exit code: $code"
echo "log: $log"
echo "--- matches (Suite result|FAIL|Error|panicked) ---"
grep -E 'Suite result|FAIL|Error|panicked' "$log" | sed 's/\x1b\[[0-9;]*m//g' | head -60 || true
echo "--- last 25 lines ---"
tail -25 "$log" | sed 's/\x1b\[[0-9;]*m//g'
exit "$code"

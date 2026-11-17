#!/usr/bin/env bash
# CI only (Linux runner): `forge "$@"` from contracts/, printing memory and swap use every minute, so a compile that
# the runner kills for memory names its cause in the log. Exits with forge's exit code.
# Usage (from contracts/): bash ../.github/scripts/forge-logged.sh build src script
set -u
(
  while sleep 60; do
    free -m | awk -v t="$SECONDS" '/^Mem:/{m=$3"/"$2} /^Swap:/{print "forge t=" t "s mem used " m " MB, swap used " $3 "/" $2 " MB"}'
  done
) &
monitor=$!
rc=0
forge "$@" || rc=$?
kill "$monitor" 2>/dev/null
free -m
exit "$rc"

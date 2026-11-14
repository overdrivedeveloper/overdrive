#!/usr/bin/env bash
# Python installs must be frozen: every package in every lock file is an exact pin with sha256 hashes, and the
# documented install command uses --require-hashes. Offline check; the real install is in each README.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
fail=0
for d in vol-engine risk-sim; do
  for f in "$d/requirements.lock" "$d/requirements-dev.lock"; do
    [ -f "$f" ] || { echo "check-python-locks: missing $f" >&2; fail=1; continue; }
    # A pin line is "name==version ..."; it must be followed (before the next pin) by at least one --hash line.
    awk -v f="$f" '
      /^[A-Za-z0-9_.-]+(\[[^]]*\])?==/ { if (pkg != "" && hashes == 0) { print f ": no hash for " pkg; bad = 1 } pkg = $1; hashes = 0; next }
      /^[ \t]*--hash=sha256:/ { hashes++ }
      /^[A-Za-z0-9_.-]+(\[[^]]*\])?[<>~!]/ { print f ": unpinned line " $0; bad = 1 }
      END { if (pkg != "" && hashes == 0) { print f ": no hash for " pkg; bad = 1 } exit bad }
    ' "$f" || fail=1
  done
  if ! grep -q -- '--require-hashes' "$d/README.md"; then echo "check-python-locks: $d/README.md does not document --require-hashes" >&2; fail=1; fi
done
[ "$fail" -eq 0 ] && echo "check-python-locks: ok"
exit "$fail"

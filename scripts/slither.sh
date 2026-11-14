#!/usr/bin/env bash
# Slither over contracts/src with the committed triage: contracts/slither.config.json (excluded detectors, each
# explained in contracts/SLITHER.md) and contracts/slither.db.json (every triaged result). Any result not in the db
# fails the run (fail_pedantic). Needs slither-analyzer (pip) and forge on PATH. Same command in CI and ci-local.sh.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
command -v slither >/dev/null || { echo "slither: not installed (pipx install slither-analyzer==0.11.6)" >&2; exit 1; }
cd "$root/contracts"
slither . --config-file slither.config.json

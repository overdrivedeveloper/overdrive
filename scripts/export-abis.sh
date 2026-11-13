#!/usr/bin/env bash
# Builds the contracts and writes the ABI (ABI only) of every IOD* interface to app/src/abi/<Name>.json.
# ABI_OUT_DIR overrides the output directory (the abi test uses a temp dir). bash 3.2 safe.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${ABI_OUT_DIR:-$root/app/src/abi}"
mkdir -p "$out"
forge build --root "$root/contracts" >/dev/null
count=0
for src in "$root"/contracts/src/interfaces/IOD*.sol; do
  name="$(basename "$src" .sol)"
  art="$root/contracts/out/$name.sol/$name.json"
  [ -f "$art" ] || { echo "export-abis: missing artifact $art" >&2; exit 1; }
  python3 - "$art" "$out/$name.json" <<'PY'
import json, sys
abi = json.load(open(sys.argv[1]))["abi"]
with open(sys.argv[2], "w") as f:
    json.dump(abi, f, indent=2)
    f.write("\n")
PY
  count=$((count + 1))
done
echo "export-abis: wrote $count ABIs to $out"

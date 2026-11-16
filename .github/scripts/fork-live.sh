#!/usr/bin/env bash
# Live-chain canary: runs every fork test against the LATEST Robinhood Chain block instead of the pinned one
# (contracts/test/utils/ForkPin.sol). Live state moves under the assertions (feeds age, Pyth updates, the US market
# opens and closes), so a failure here is a signal to read, not a broken build: this script is never part of ci.yml,
# ci-local.sh or the pre-push gate. Run it by hand before moving the pin forward, or on a schedule that only alerts.
# Usage: .github/scripts/fork-live.sh [forge test args...]   needs RHC_RPC_URL (loaded from ~/.config/overdrive/rpc.env).
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
if [ -z "${RHC_RPC_URL:-}" ] && [ -f "$HOME/.config/overdrive/rpc.env" ]; then set -a; . "$HOME/.config/overdrive/rpc.env"; set +a; fi
[ -n "${RHC_RPC_URL:-}" ] || { echo "fork-live: RHC_RPC_URL is not set" >&2; exit 2; }
cd "$root/contracts" || exit 2
RHC_FORK_BLOCK=0 forge test --match-path 'test/**/{*Fork*,OwnerSafeCheck,Drawdown}.t.sol' --compute-units-per-second 100 "$@"
rc=$?
echo "fork-live: latest block, forge exit $rc (not a gate)"
exit "$rc"

#!/bin/bash
# down.sh, then deletes the fork state, the pinned block, the deployment, the throwaway keystores, env files and the database
# cluster, so the next up.sh forks the latest block and deploys again. Keeps the rpc cache (block-pinned answers never go
# stale) and old logs. Also removes this stack's deploy-fork.sh outputs in the repo (.batches/fork-*, .audit-grade). bash 3.2.
set -euo pipefail
# shellcheck source=env.sh
. "$(cd "$(dirname "$0")" && pwd)/env.sh"
/bin/bash "$(cd "$(dirname "$0")" && pwd)/down.sh"
rm -rf "$FORK_DIR/state.json" "$FORK_DIR/fork-block" "$FORK_DIR/warmed" "$FORK_DIR/deployment.json" "$FORK_DIR/deploy-config.json" \
  "$FORK_DIR/relaxations.json" "$FORK_DIR/gears-listed.json" "$FORK_DIR/anvil-accounts.json" "$FORK_DIR/keys" "$FORK_DIR/env" "$FORK_DIR/pg" "$FORK_DIR/pids" \
  "$FORK_DIR/exercise"
rm -f "$APP/deployments/local/fork-stack.json" "$ROOT/.batches/fork-list-gears.json" "$ROOT/.batches/fork-list-gears.execute.json" "$ROOT/.audit-grade/post-deploy-fork.txt"
echo "fork: reset (next up.sh forks the latest block and deploys)"

#!/bin/bash
# Stops the fork stack started by up.sh: only processes whose pid files up.sh wrote (by PID, never by name pattern), then
# Postgres through pg_ctl on its own data folder. The anvil state (saved on exit), the deployment, the rpc cache and the
# database are kept, so the next up.sh resumes where this one stopped. macOS /bin/bash 3.2.
set -uo pipefail
# shellcheck source=env.sh
. "$(cd "$(dirname "$0")" && pwd)/env.sh"
rev=""
for name in $SERVICES; do rev="$name $rev"; done
for name in $rev; do stop "$name"; done
stop anvil
stop rpc-cache
if pg_running; then
  "$PG_BIN/pg_ctl" -D "$FORK_DIR/pg" -m fast -w stop >/dev/null 2>&1 && echo "fork: stopped postgres"
fi
echo "fork: down (state, deployment and database kept in $FORK_DIR)"

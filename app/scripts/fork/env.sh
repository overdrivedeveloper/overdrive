# Shared settings for the anvil mainnet-fork stack (sourced by up.sh, down.sh, reset.sh; never run alone).
# macOS /bin/bash 3.2: no mapfile, no declare -A, no negative array index, no empty-array expansion under set -u.
# PORT_OFFSET moves every port at once so two stacks (or another project's anvil) never collide:
#   anvil 8545+O (what MetaMask uses with O=0), rpc cache 9545+O, Postgres 5433+O, api 3101+O, mcp 3102+O, web 4291+O.
# FORK_DIR holds the state, logs, pids, env files, throwaway keystores and the database cluster. It defaults to
# ~/.overdrive/fork, outside the repository.
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$(cd "$APP/.." && pwd)"
FOUNDRY="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
ANVIL="$FOUNDRY/anvil"
CAST="$FOUNDRY/cast"
FORGE="$FOUNDRY/forge"
BUN="${BUN_BIN:-}"
if [ -z "$BUN" ]; then
  for b in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do [ -x "$b" ] && { BUN="$b"; break; }; done
fi
BUN="${BUN:-$HOME/.bun/bin/bun}"
export PATH="$FOUNDRY:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
PORT_OFFSET="${PORT_OFFSET:-0}"
FORK_DIR="${FORK_DIR:-$HOME/.overdrive/fork}"
ANVIL_PORT=$((8545 + PORT_OFFSET))
CACHE_PORT=$((9545 + PORT_OFFSET))
PG_PORT=$((5433 + PORT_OFFSET))
API_PORT=$((3101 + PORT_OFFSET))
MCP_PORT=$((3102 + PORT_OFFSET))
WEB_PORT=$((4291 + PORT_OFFSET))
# Private RPC (owner-saved, chmod 600, never printed): loaded only when the env var is not already set.
if [ -z "${RHC_MAINNET_RPC_URL:-}" ] && [ -f "$HOME/.config/overdrive/rpc.env" ]; then set -a; . "$HOME/.config/overdrive/rpc.env"; set +a; fi
UPSTREAM_RPC="${RHC_MAINNET_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
PG_BIN="${PG_BIN:-$(ls -d /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin 2>/dev/null | head -1 || true)}"
DB_NAME=od_fork
DATABASE_URL="postgres://$(whoami)@127.0.0.1:$PG_PORT/$DB_NAME"
ANVIL_URL="http://127.0.0.1:$ANVIL_PORT"
CACHE_URL="http://127.0.0.1:$CACHE_PORT"
export APP ROOT FOUNDRY ANVIL CAST FORGE BUN PORT_OFFSET FORK_DIR ANVIL_PORT CACHE_PORT PG_PORT API_PORT MCP_PORT WEB_PORT
export UPSTREAM_RPC PG_BIN DB_NAME DATABASE_URL ANVIL_URL CACHE_URL

# Services in start order (down.sh stops them in reverse, then anvil, the rpc cache and Postgres).
SERVICES="indexer api crank hedger liquidator mcp vol-engine web"

alive() { [ -f "$FORK_DIR/pids/$1.pid" ] && kill -0 "$(cat "$FORK_DIR/pids/$1.pid")" 2>/dev/null; }

# stop <name>: stops only a process this stack started (by the pid in its pid file), never anything else.
stop() {
  local name="$1" pid i
  if alive "$name"; then
    pid="$(cat "$FORK_DIR/pids/$name.pid")"
    kill "$pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 40 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.25; i=$((i + 1)); done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
    echo "fork: stopped $name"
  fi
  rm -f "$FORK_DIR/pids/$name.pid"
}

pg_running() { [ -n "$PG_BIN" ] && [ -f "$FORK_DIR/pg/PG_VERSION" ] && "$PG_BIN/pg_ctl" -D "$FORK_DIR/pg" status >/dev/null 2>&1; }

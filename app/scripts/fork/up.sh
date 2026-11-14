#!/bin/bash
# The whole Overdrive stack on a persistent anvil fork of Robinhood Chain mainnet (chain id 31337, never 4663).
#
#   /bin/bash scripts/fork/up.sh     rpc cache -> anvil fork (latest block on the first run, then pinned; saved state) ->
#                                    clear dev-account delegations -> Postgres od_fork -> deploy (app/scripts/deploy-fork.sh:
#                                    DeploySystem, handoff, post-deploy check, list-gears batch; skips finished stages) ->
#                                    fork relaxations -> env files -> migrate -> indexer, api, crank, hedger (mock venue),
#                                    liquidator, mcp (http), vol-engine (posts under the deployment's market ids) ->
#                                    Governor capital seed (once) -> web; health-checks each
#   /bin/bash scripts/fork/down.sh   stops what up.sh started (state, database and deployment kept)
#   /bin/bash scripts/fork/reset.sh  down + delete state, deployment and database
#
# Env: PORT_OFFSET (all ports, see env.sh), FORK_DIR (default ~/.overdrive/fork), RHC_MAINNET_RPC_URL (upstream, default the
# free public RPC), FORK_BLOCK (pin a block on the first run), VOL_ENGINE_PYTHON, UP_SERVICES (default all; "none" = chain,
# database and migrations only). macOS /bin/bash 3.2. One line per stage. Safe to run twice: every running service says
# "already running" and nothing is redeployed (fork.test.ts > bash32_lint_and_up_twice_is_idempotent).
set -euo pipefail
# shellcheck source=env.sh
. "$(cd "$(dirname "$0")" && pwd)/env.sh"
mkdir -p "$FORK_DIR/logs" "$FORK_DIR/pids" "$FORK_DIR/env" "$FORK_DIR/keys"

die() { echo "up: $*" >&2; exit 1; }
want() { case " ${UP_SERVICES:-all} " in *" all "*) return 0 ;; *" $1 "*) return 0 ;; *) return 1 ;; esac; }
for bin in "$ANVIL" "$CAST" "$FORGE" "$BUN"; do [ -x "$bin" ] || { echo "up: $bin not found" >&2; exit 69; }; done
command -v curl >/dev/null || die "curl not found"

# R1: the fork node, the cache and every service URL are loopback; the upstream is only ever read through the cache.
case "$ANVIL_URL" in http://127.0.0.1:*) ;; *) die "ANVIL_URL must be local, not $ANVIL_URL" ;; esac
case "$UPSTREAM_RPC" in http://127.0.0.1:*|http://localhost:*|https://*) ;; *) die "upstream must be https (or a local stub), not $UPSTREAM_RPC" ;; esac

# start <name> <health: http URL | any:URL (any HTTP answer) | rpc:URL | none> -- <command...>
# cwd app/, env from $FORK_DIR/env/<name>.env when present; a process that exits fails up.sh with its last log lines.
start() {
  local name="$1" health="$2" i
  shift 3
  if alive "$name"; then echo "up: $name already running (pid $(cat "$FORK_DIR/pids/$name.pid"))"; return 0; fi
  (
    cd "$APP"
    if [ -f "$FORK_DIR/env/$name.env" ]; then set -a; . "$FORK_DIR/env/$name.env"; set +a; fi
    nohup "$@" >>"$FORK_DIR/logs/$name.log" 2>&1 &
    echo $! >"$FORK_DIR/pids/$name.pid"
  )
  i=0
  while [ "$i" -lt 240 ]; do
    case "$health" in
      rpc:*) "$CAST" chain-id --rpc-url "${health#rpc:}" >/dev/null 2>&1 && { echo "up: $name healthy"; return 0; } ;;
      any:*) curl -s -m 2 -o /dev/null "${health#any:}" 2>/dev/null && { echo "up: $name healthy (${health#any:})"; return 0; } ;;
      http*) curl -fsS -m 2 -o /dev/null "$health" 2>/dev/null && { echo "up: $name healthy ($health)"; return 0; } ;;
      *) [ "$i" -ge 16 ] && alive "$name" && { echo "up: $name running"; return 0; } ;;
    esac
    if ! alive "$name"; then
      echo "up: $name exited; last lines of $FORK_DIR/logs/$name.log:" >&2
      tail -25 "$FORK_DIR/logs/$name.log" >&2
      rm -f "$FORK_DIR/pids/$name.pid"
      exit 1
    fi
    sleep 0.5
    i=$((i + 1))
  done
  die "$name not healthy after 120 s; see $FORK_DIR/logs/$name.log"
}

# A port used by something this stack did not start stops the run (pick another PORT_OFFSET).
pg_pid="$(head -1 "$FORK_DIR/pg/postmaster.pid" 2>/dev/null || true)"
for p in $ANVIL_PORT $CACHE_PORT $PG_PORT $API_PORT $MCP_PORT $WEB_PORT; do
  owner="$(lsof -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$owner" ] && ! grep -qs "^$owner\$" "$FORK_DIR"/pids/*.pid && [ "$owner" != "$pg_pid" ]; then
    die "port $p is used by another process (pid $owner); pick another PORT_OFFSET"
  fi
done

# 1. Caching proxy in front of the public RPC (about 10 minutes of history upstream; the cache keeps what we touched,
#    backs off on HTTP 429 and refuses every transaction and signing method).
start rpc-cache "$CACHE_URL/health" -- "$BUN" scripts/fork/rpc-cache.ts --port "$CACHE_PORT" --upstream "$UPSTREAM_RPC" --cache "$FORK_DIR/rpc-cache.jsonl"

# 2. anvil: latest block on the first run (recorded), the same block after that; state saved every minute and on exit.
if [ ! -s "$FORK_DIR/fork-block" ]; then
  up_chain="$("$CAST" chain-id --rpc-url "$CACHE_URL")"
  [ "$up_chain" = 4663 ] || die "upstream is chain $up_chain, not Robinhood Chain mainnet (4663)"
  echo "${FORK_BLOCK:-$("$CAST" block-number --rpc-url "$CACHE_URL")}" >"$FORK_DIR/fork-block"
fi
FORK_BLOCK="$(cat "$FORK_DIR/fork-block")"
start anvil "rpc:$ANVIL_URL" -- "$ANVIL" --host 127.0.0.1 --port "$ANVIL_PORT" --fork-url "$CACHE_URL" \
  --fork-block-number "$FORK_BLOCK" --chain-id 31337 --hardfork cancun --block-time 1 --accounts 20 --balance 10000 \
  --state "$FORK_DIR/state.json" --state-interval 60 --config-out "$FORK_DIR/anvil-accounts.json" --no-rate-limit
[ "$("$CAST" chain-id --rpc-url "$ANVIL_URL")" = 31337 ] || die "anvil is not chain 31337"
case "$("$CAST" rpc web3_clientVersion --rpc-url "$ANVIL_URL")" in *anvil/*) ;; *) die "the node on $ANVIL_URL is not anvil" ;; esac
chmod 600 "$FORK_DIR/anvil-accounts.json"
echo "up: fork of mainnet block $FORK_BLOCK on $ANVIL_URL (chain 31337)"
if [ ! -s "$FORK_DIR/warmed" ]; then
  (cd "$APP" && "$BUN" scripts/fork/warm.ts) 2>&1 | tail -1 | sed 's/^/up: /'
  date -u +%Y-%m-%dT%H:%M:%SZ >"$FORK_DIR/warmed"
else
  echo "up: warm skip (done $(cat "$FORK_DIR/warmed"))"
fi
(cd "$APP" && "$BUN" scripts/fork/setup.ts --clear-delegations --keystores) | sed 's/^setup: /up: /'

# 3. Postgres cluster of its own (port PG_PORT), database od_fork.
[ -n "$PG_BIN" ] && [ -x "$PG_BIN/pg_ctl" ] || { echo "up: Postgres 16 binaries not found (set PG_BIN)" >&2; exit 69; }
if [ ! -f "$FORK_DIR/pg/PG_VERSION" ]; then
  "$PG_BIN/initdb" -D "$FORK_DIR/pg" -U "$(whoami)" -A trust --no-locale -E UTF8 >"$FORK_DIR/logs/initdb.log"
fi
if pg_running; then
  echo "up: postgres already running"
else
  LC_ALL=C "$PG_BIN/pg_ctl" -D "$FORK_DIR/pg" -l "$FORK_DIR/logs/postgres.log" -o "-p $PG_PORT -k $FORK_DIR -c listen_addresses=127.0.0.1" -w start >/dev/null
fi
"$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -d postgres -tAc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1 \
  || "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" "$DB_NAME"
echo "up: Postgres on $PG_PORT, database $DB_NAME"

# 4. Deploy through todo 11's owner script (it skips every finished stage), signed by a throwaway keystore of anvil
#    account 0; the config is contracts/script/config/fork.json with the roles on anvil dev accounts.
# forge may only write under app/deployments (contracts/foundry.toml fs_permissions): the record lands in the git-ignored
# app/deployments/local/ and is copied to FORK_DIR/deployment.json, which the services and scripts read.
STACK_DEPLOYMENT="$APP/deployments/local/fork-stack.json"
[ -s "$FORK_DIR/deploy-config.json" ] || (cd "$APP" && "$BUN" scripts/fork/setup.ts --config) | sed 's/^setup: /up: /'
DEPLOYER="$("$BUN" -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).available_accounts[0]; console.log(a)' "$FORK_DIR/anvil-accounts.json")"
# After the fork relaxations the production post-deploy check would (rightly) fail on the relaxed oracle settings, so a
# relaxed deployment with code at its recorded addresses is not handed to deploy-fork.sh again; its PASS report from
# before the relaxations is kept in FORK_DIR/post-deploy-check.txt.
gov_code=""
if [ -s "$FORK_DIR/deployment.json" ]; then
  gov="$("$BUN" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).contracts.ODGovernor)' "$FORK_DIR/deployment.json")"
  gov_code="$("$CAST" code "$gov" --rpc-url "$ANVIL_URL" 2>/dev/null || true)"
fi
if [ -s "$FORK_DIR/relaxations.json" ] && [ -n "$gov_code" ] && [ "$gov_code" != "0x" ]; then
  echo "up: stage deploy: skip (deployed and relaxed; post-deploy check PASS kept in $FORK_DIR/post-deploy-check.txt)"
else
  # FOUNDRY_GAS_LIMIT: forge simulates the whole script inside one call; on chain id 31337 it caps that call at the default
  # gas limit and the deploy runs out of gas at ODGovernor (on 4663 it does not). Each broadcast transaction is still
  # estimated on its own against anvil.
  FOUNDRY_GAS_LIMIT=18446744073709551615 OD_DEPLOYER="$DEPLOYER" OD_KEYSTORE="$FORK_DIR/keys/deployer.json" OD_PASSWORD_FILE="$FORK_DIR/keys/password" \
    ANVIL_URL="$ANVIL_URL" OD_OUT="$STACK_DEPLOYMENT" OD_CONFIG_JSON="$(cat "$FORK_DIR/deploy-config.json")" \
    /bin/bash "$APP/scripts/deploy-fork.sh" >"$FORK_DIR/logs/deploy.log" 2>&1 || { tail -30 "$FORK_DIR/logs/deploy.log" >&2; die "deploy failed"; }
  cp "$STACK_DEPLOYMENT" "$FORK_DIR/deployment.json"
  grep '^stage' "$FORK_DIR/logs/deploy.log" | sed 's/^/up: /'
  cp "$ROOT/.audit-grade/post-deploy-fork.txt" "$FORK_DIR/post-deploy-check.txt"
fi

# 5. Env files (keystore form, FORK_DIR only), migrations, fork relaxations and the gear listing (once), services.
(cd "$APP" && "$BUN" scripts/fork/setup.ts --env) | sed 's/^setup: /up: /'
(cd "$APP" && "$BUN" scripts/fork/migrate.ts) 2>>"$FORK_DIR/logs/migrate.log" | sed 's/^migrate: /up: migrate: /' \
  || { tail -20 "$FORK_DIR/logs/migrate.log" >&2; die "migrations failed"; }
"$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "$APP/scripts/api-readonly-role.sql" >>"$FORK_DIR/logs/migrate.log" 2>&1 \
  || { tail -20 "$FORK_DIR/logs/migrate.log" >&2; die "API read-only role failed"; }
echo "up: API database role overdrive_api is SELECT-only"
# The indexer runs first: the crank (which feeds the session calendar the gear listing needs) waits for its chain clock.
if want indexer || [ ! -s "$FORK_DIR/gears-listed.json" ]; then start indexer none -- "$BUN" src/bin/indexer.ts; fi
(cd "$APP" && "$BUN" scripts/fork/setup.ts --relax --list-gears) 2>>"$FORK_DIR/logs/setup.log" | sed 's/^setup: /up: /' \
  || { tail -20 "$FORK_DIR/logs/setup.log" >&2; die "relaxations or gear listing failed"; }
# The deploy wrote `gears: []`; the API resolves gears only from this file, so fill it from the registry before the API starts.
# --env again after the fill: the vol engine keys pair gears from the filled record (setup.ts volEngineEnv).
(cd "$APP" && "$BUN" scripts/fork/setup.ts --fill-gears --env) 2>>"$FORK_DIR/logs/setup.log" | sed 's/^setup: /up: /' \
  || { tail -20 "$FORK_DIR/logs/setup.log" >&2; die "filling the deployment gears failed"; }

if want api; then start api "http://127.0.0.1:$API_PORT/health" -- "$BUN" src/bin/api.ts; fi
if want crank; then start crank none -- "$BUN" src/bin/crank.ts; fi
if want hedger; then start hedger none -- "$BUN" src/bin/hedger.ts; fi
if want liquidator; then start liquidator none -- "$BUN" src/bin/liquidator.ts; fi
if want mcp; then start mcp "any:http://127.0.0.1:$MCP_PORT/mcp" -- "$BUN" src/bin/mcp.ts --http; fi
if want vol-engine; then
  VOL_PY="${VOL_ENGINE_PYTHON:-$ROOT/vol-engine/.venv/bin/python}"
  if [ -x "$VOL_PY" ] && "$VOL_PY" -c "import vol_engine" 2>/dev/null; then
    start vol-engine none -- "$VOL_PY" -m vol_engine.cli post --loop --interval 60
  else
    echo "up: vol-engine not started: no Python with vol_engine installed (python3 -m venv vol-engine/.venv && vol-engine/.venv/bin/pip install -e vol-engine, or set VOL_ENGINE_PYTHON)"
  fi
fi
# Governor capital, once (its totalSupply is the marker): with no equity the cap is 0 and every buy closes with CAP.
(cd "$APP" && "$BUN" scripts/fork/setup.ts --seed-capital) 2>>"$FORK_DIR/logs/setup.log" | sed 's/^setup: /up: /' \
  || { tail -20 "$FORK_DIR/logs/setup.log" >&2; die "seeding Governor capital failed"; }
if want web; then
  if [ -f "$ROOT/web/package.json" ]; then
    # exec vite itself (not `bun run dev`, which forks it) so the pid file names the process that holds the port.
    start web "http://127.0.0.1:$WEB_PORT/" -- /bin/sh -c "cd '$ROOT/web' && exec ./node_modules/.bin/vite --host 127.0.0.1 --port $WEB_PORT --mode fork"
  else
    echo "up: web not started: no web/ in this checkout"
  fi
fi

echo "up: fork stack ready. RPC $ANVIL_URL (chain 31337), API http://127.0.0.1:$API_PORT (/v1/...), MCP http://127.0.0.1:$MCP_PORT/mcp, logs $FORK_DIR/logs"

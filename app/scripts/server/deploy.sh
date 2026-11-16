#!/usr/bin/env bash
# Deploys the Overdrive backend from the owner's machine to the shared server after provision.sh
# has prepared it. Overdrive shares that box with other services: this script only ever touches overdrive-* units,
# /opt/overdrive, /etc/overdrive, /var/lib/overdrive and the overdrive database. It never restarts Caddy, Postgres or
# any unit it did not install.
#
#   deploy.sh --ref <40-hex sha> <host>      deploy a commit
#   deploy.sh --provision [--preflight] <host>   first time: copy app/scripts/server up and run provision.sh
#                                            (--preflight only reports what it would do; changes nothing)
#   deploy.sh --check <host>                 health-check every service, change nothing
#   deploy.sh --local --repo <git dir> --ref <40-hex sha>   deploy ON the server (release runner), no ssh
#   deploy.sh --local --check                health-check this server, change nothing (no arming needed)
#
# --local is the real-deploy path: it refuses unless BOTH OVERDRIVE_ALLOW_REAL_DEPLOY=1 is set AND the file named by
# OVERDRIVE_ALLOW_FILE exists (created only when the launch is armed). --ref must be a full 40-hex sha; --repo is a git
# dir (bare is fine). <host> is a host name, an ~/.ssh/config alias or user@host (no "user@" means root). Nothing about
# the server (address, SSH key, password) is stored here.
#
# A deploy:
#   1. takes the build lock (builds on this box run ONE at a time, so a deploy never starves the other project);
#   2. ships the committed tree at <ref> (git archive of app/, which holds app/python/vol-engine and app/python/risk-sim; uncommitted changes never ship) plus
#      app/deployments/<chain id>.json (from OVERDRIVE_DEPLOYMENTS_SRC) to /opt/overdrive/releases/<UTC time>-<sha12>;
#   3. checks /etc/overdrive/overdrive.env (no CHANGE_ME left, NETWORK/CHAIN_ID/DEPLOYMENT_FILE agree, RPC answers that chain
#      id, oracle address matches the deployment file, no raw key in any env file) and every keystore in /etc/overdrive/keys
#      (readable by the one service that signs with it and by no other service user; tested for access, never read);
#   4. builds as the overdrive user inside a memory-capped scope (bun install --frozen-lockfile, two virtualenvs);
#      then `vol-engine check-keys` refuses the release unless the engine posts every market and pair gear of the
#      deployment file under the id its oracle reads (the padded bytes32 market id, never a keccak of the symbol);
#   5. points /opt/overdrive/current at the release and runs overdrive-migrate.service FIRST; if it fails the link goes back
#      and nothing is restarted;
#   6. restarts the services one by one (indexer, api, crank, vol-engine, hedger, liquidator, mcp) and checks each before
#      the next; the first failure puts the link back, restarts every service on the previous release and exits 1.
# The last 5 healthy releases are kept. Migrations are not reversed by a rollback (README.md, "Roll back").
#
# Network profile: NETWORK in /etc/overdrive/overdrive.env (mainnet 4663 or testnet 46630). The testnet profile has no
# hedger. A remote deploy takes the profile from OVERDRIVE_NETWORK (default mainnet); the server refuses a mismatch.
#
# Exit codes: 0 deployed and healthy (or --check healthy); 75 nothing was switched (a failure before the link moved: the
# running release is untouched, safe to try again later); 1 a failure after the switch (the link went back to the previous
# release), an unhealthy --check, or a refused command line; 2 usage.
#
# Env (all optional): SSH_OPTS (extra ssh options), OVERDRIVE_DEPLOYMENTS_SRC (folder holding <chain id>.json, default
# app/deployments of this checkout), OVERDRIVE_NETWORK, OVERDRIVE_PUBLIC_API_URL (also checked from here after the deploy),
# OVERDRIVE_ALLOW_REAL_DEPLOY and OVERDRIVE_ALLOW_FILE (the --local arming pair), DEPLOY_RETRY_WAITS (default "10 30"),
# OD_LOCK_WAIT (seconds to wait for the build lock, default 1800), OD_SETTLE (seconds a service must run without a
# restart, default 20).
# OD_TEST_ROOT (+ OD_TEST_BUILD_CMD): tests only, refused as root. Every server path moves under that folder and the
# real server steps run against stubbed systemctl/curl on PATH; no ssh, no network, never a real server.
set -euo pipefail
umask 022

EX_NOT_SWITCHED=75

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
die_unswitched() { printf 'deploy: %s (nothing switched)\n' "$*" >&2; exit "$EX_NOT_SWITCHED"; }
log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# retry <what> <command...>: up to 1 + the number of DEPLOY_RETRY_WAITS tries, waiting that long between them.
retry() {
  local what="$1" w waits rc=1
  shift
  read -r -a waits <<<"${DEPLOY_RETRY_WAITS:-10 30}"
  for w in ${waits[@]+"${waits[@]}"} last; do
    if "$@"; then return 0; else rc=$?; fi
    [[ "$w" == last ]] && break
    log "$what failed (exit $rc); trying again in ${w}s" >&2
    sleep "$w"
  done
  return "$rc"
}

# stage_release <git dir> <sha> <release dir> <folder with the deployment file> [<file name>, default 4663.json]
stage_release() {
  local root="$1" sha="$2" dir="$3" dep="$4" name="${5:-4663.json}"
  mkdir -m 0755 "$dir" || return 1
  chmod 0755 "$dir" || return 1
  git -C "$root" archive --format=tar "$sha" app LICENSE README.md 2>/dev/null | tar -xf - -C "$dir" --no-same-owner \
    || { git -C "$root" archive --format=tar "$sha" app | tar -xf - -C "$dir" --no-same-owner || return 1; }
  mkdir -p "$dir/app/deployments" && chmod 0755 "$dir/app/deployments" || return 1
  cat "$dep/$name" >"$dir/app/deployments/$name" || return 1
  chmod -R go-w,a+rX "$dir"
}

# ---------------------------------------------------------------- release dirs (shared by the server script and the tests)
IFS= read -r -d '' RELEASE_FNS <<'FNS' || true
current_release() { local l; l="$(readlink "$1/current" 2>/dev/null)" || return 0; basename "$l"; }
# previous_healthy_release <base>: the newest .healthy release older (by name) than the current one; empty if none
previous_healthy_release() {
  local base="$1" cur r out=""
  cur="$(current_release "$base")"
  while IFS= read -r r; do
    [[ -n "$r" && "$r" != "$cur" && -e "$base/releases/$r/.healthy" ]] || continue
    if [[ -z "$cur" || "$r" < "$cur" ]]; then out="$r"; fi
  done < <(ls -1 "$base/releases" 2>/dev/null | LC_ALL=C sort)
  printf '%s' "$out"
}
# abandon_release <base> <rel>: a staged release that never went live is removed (never the current one)
abandon_release() {
  local base="$1" rel="$2"
  [[ -n "$rel" && -d "$base/releases/$rel" && "$rel" != "$(current_release "$base")" ]] || return 0
  rm -rf "${base:?}/releases/$rel"
}
# prune_releases <base> <keep> [<previous rel>]: removes every release without .healthy and keeps <keep> healthy ones in
# all: the current one, the given previous one and the newest others
prune_releases() {
  local base="$1" keep="$2" prev="${3:-}" cur r healthy=()
  cur="$(current_release "$base")"
  while IFS= read -r r; do
    [[ -n "$r" && "$r" != "$cur" && "$r" != "$prev" ]] || continue
    if [[ -e "$base/releases/$r/.healthy" ]]; then healthy+=("$r"); else rm -rf "${base:?}/releases/$r"; fi
  done < <(ls -1 "$base/releases" 2>/dev/null | LC_ALL=C sort)
  local n="${#healthy[@]}" i
  for ((i = 0; i < n - (keep - 2); i++)); do rm -rf "${base:?}/releases/${healthy[$i]}"; done
  return 0
}
# vol_keys_check <vol-engine binary> <VOL_KEYS value> <deployment file>: exits non-zero unless the engine posts every market
# and pair gear of the record under the exact id its oracle reads (`vol-engine check-keys`; it reads only VOL_KEYS, never a
# key, a password or the database). A drift between the engine's key scheme and the chain's ids stops the deploy here.
vol_keys_check() { env -i PATH=/usr/bin:/bin VOL_KEYS="$2" "$1" check-keys "$3"; }
FNS
eval "$RELEASE_FNS"

# ---------------------------------------------------------------- the server side (runs as root on the server)
# One function library, eval'ed here (tests call it against a fake root) and sent ahead of `server_main` over ssh.
IFS= read -r -d '' SERVER_FNS <<'SRV' || true
# P is the test root ("" on a real server). Every path below goes through it.
s_log() { printf '[server %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
s_die() { printf 'deploy (server): %s\n' "$*" >&2; exit 1; }
s_retry() {
  local what="$1" w waits rc=1
  shift
  read -r -a waits <<<"${DEPLOY_RETRY_WAITS:-10 30}"
  for w in ${waits[@]+"${waits[@]}"} last; do
    if "$@"; then return 0; else rc=$?; fi
    [[ "$w" == last ]] && break
    s_log "$what failed (exit $rc); trying again in ${w}s" >&2
    sleep "$w"
  done
  return "$rc"
}
# Portable lock (no flock on a Mac): one build at a time on this shared box. A dead holder's lock is taken over.
lock_acquire() { # lock_acquire <dir> <wait seconds>
  local dir="$1" wait="$2" t=0 holder
  while ! mkdir "$dir" 2>/dev/null; do
    holder="$(cat "$dir/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$dir"; continue; fi
    if [[ "$t" -ge "$wait" ]]; then return 1; fi
    sleep 1; t=$((t + 1))
  done
  printf '%s\n' "$$" >"$dir/pid"
}
lock_release() { rm -rf "$1"; }
service_user() { printf 'overdrive-%s' "$1"; }
as_user() { # as_user <user> <command...>: runuser on a real server; plain exec under a test root
  local u="$1"; shift
  if [[ -n "$P" ]]; then "$@"; else runuser -u "$u" -- "$@"; fi
}
# Builds run niced and, where systemd-run exists, inside a scope capped at 768M (never the services' slice).
capped() {
  if [[ -z "$P" ]] && command -v systemd-run >/dev/null 2>&1; then systemd-run --scope --quiet -p MemoryMax=768M -p MemorySwapMax=0 nice -n 15 "$@"
  else nice -n 15 "$@"; fi
}

server_main() {
  set -euo pipefail
  umask 022
  local mode="$1" sha="${3:-}" want_net="${4:-}"
  # Globals (no local): the EXIT trap runs after this function has returned.
  rel="${2:-}"; SWITCHED=0
  BASE="$P/opt/overdrive" ETC="$P/etc/overdrive" KEYS="$P/etc/overdrive/keys"; ENVF="$P/etc/overdrive/overdrive.env"
  LOCKDIR="$P/var/lock/overdrive-build.lock.d"; HAVE_LOCK=0
  if [[ "$mode" == deploy ]]; then
    trap 'rc=$?; [[ "$HAVE_LOCK" == 1 ]] && lock_release "$LOCKDIR"; if [[ "$rc" != 0 && "$SWITCHED" == 0 ]]; then abandon_release "$BASE" "$rel"; printf "deploy (server): stopped before the switch (exit %s): nothing switched, current is unchanged\n" "$rc" >&2; exit 75; fi' EXIT
  fi
  local CORE=() NET CHAIN REQUIRED_KEYS=()
  envval() { sed -n "s/^$1=//p" "$ENVF" | tail -1; }
  lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

  if [[ -z "$P" ]]; then [[ "$(id -u)" == 0 ]] || s_die "connect as root"; fi
  { [[ -n "$P" ]] || id overdrive >/dev/null 2>&1; } && [[ -x "$BASE/bin/bun" && -f "$ETC/db.env" && -f "$ENVF" ]] \
    || s_die "server not provisioned: run deploy.sh --provision <host> first"
  command -v jq >/dev/null || s_die "jq missing: re-run provision.sh"

  NET="$(envval NETWORK)"
  case "${NET:-mainnet}" in
    mainnet) NET=mainnet; CHAIN=4663; CORE=(indexer api crank vol-engine hedger liquidator); REQUIRED_KEYS=(crank hedger liquidator vol-signer) ;;
    testnet) CHAIN=46630; CORE=(indexer api crank vol-engine liquidator); REQUIRED_KEYS=(crank liquidator vol-signer) ;;
    *) s_die "NETWORK must be mainnet or testnet in $ENVF (it is '$NET')" ;;
  esac
  local api_port; api_port="$(envval API_PORT)"; api_port="${api_port:-38101}"
  api_url() { printf 'http://127.0.0.1:%s/health' "$api_port"; }

  health_api() { # the API is the one service with an HTTP health route
    local timeout="$1" deadline body code
    deadline=$((SECONDS + timeout))
    while :; do
      body="$(curl -sS -m 15 -w '\n%{http_code}' "$(api_url)" 2>/dev/null)" || body=$'\n000'
      code="${body##*$'\n'}"; body="${body%$'\n'*}"
      if [[ "$code" == 200 ]] && jq -e '.ok == true' >/dev/null 2>&1 <<<"$body"; then
        printf '  ok    %-12s health route answers\n' api; return 0
      fi
      if ((SECONDS >= deadline)); then
        printf '  FAIL  %-12s HTTP %s %s\n' api "$code" "$(systemctl is-active overdrive-api.service 2>/dev/null || true)"
        journalctl -u overdrive-api.service -n 15 --no-pager -o cat 2>/dev/null | sed 's/^/        | /' || true
        return 1
      fi
      sleep 3
    done
  }
  # Services without a port: active, and the same process for a settle window (a crash loop moves
  # ActiveEnterTimestampMonotonic).
  health_unit() {
    local name="$1" settle="${2:-${OD_SETTLE:-20}}" unit="overdrive-$1.service" t0 t1
    sleep "${OD_PRE_SLEEP:-3}"
    t0="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$unit")"
    sleep "$settle"
    t1="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$unit")"
    if systemctl is-active --quiet "$unit" && [[ -n "$t0" && "$t0" == "$t1" ]]; then
      printf '  ok    %-12s running (%ss without a restart)\n' "$name" "$settle"; return 0
    fi
    printf '  FAIL  %-12s %s (restarted or stopped during the first %ss)\n' "$name" "$(systemctl is-active "$unit" 2>/dev/null || true)" "$settle"
    journalctl -u "$unit" -n 15 --no-pager -o cat 2>/dev/null | sed 's/^/        | /' || true
    return 1
  }
  service_list() {
    local s
    for s in "${CORE[@]}"; do printf '%s\n' "$s"; done
    if systemctl is-enabled --quiet overdrive-mcp.service 2>/dev/null; then printf 'mcp\n'; fi
    return 0
  }
  check_one() { case "$1" in api) health_api 120 ;; *) health_unit "$1" ;; esac; }

  if [[ "$mode" == check ]]; then
    local failed=0 s
    while IFS= read -r s; do check_one "$s" || failed=1; done < <(service_list)
    [[ "$failed" == 0 ]] || s_die "unhealthy services above"
    s_log "all healthy ($(cat "$BASE/current/REVISION" 2>/dev/null || echo "unknown revision"))"
    return 0
  fi

  local R="$BASE/releases/$rel"
  [[ -n "$rel" && -d "$R/app" ]] || s_die "release $rel was not uploaded"
  lock_acquire "$LOCKDIR" "${OD_LOCK_WAIT:-1800}" || s_die "another Overdrive build holds the lock (builds run one at a time on this shared box)"
  HAVE_LOCK=1

  # ---- preflight: overdrive.env
  local left v f
  left="$(grep -oE '^[A-Z0-9_]+=(CHANGE_ME|GENERATED_BY_PROVISION)$' "$ENVF" | cut -d= -f1 | tr '\n' ' ' || true)"
  [[ -z "$left" ]] || s_die "fill these in /etc/overdrive/overdrive.env first: $left"
  [[ "$(envval NETWORK)" == "$NET" ]] || s_die "NETWORK must be set to $NET in /etc/overdrive/overdrive.env"
  [[ -z "$want_net" || "$want_net" == "$NET" ]] || s_die "this deploy was started for $want_net but $ENVF says NETWORK=$NET: refusing"
  [[ "$(envval CHAIN_ID)" == "$CHAIN" ]] || s_die "CHAIN_ID must be $CHAIN ($NET) in /etc/overdrive/overdrive.env"
  [[ "$(envval DEPLOYMENT_FILE)" == "/opt/overdrive/current/app/deployments/$CHAIN.json" ]] \
    || s_die "DEPLOYMENT_FILE must be /opt/overdrive/current/app/deployments/$CHAIN.json"
  for f in "$ENVF" "$ETC"/*.env; do
    [[ -f "$f" ]] || continue
    for v in CRANK_PRIVATE_KEY HEDGER_PRIVATE_KEY LIQUIDATOR_PRIVATE_KEY VOL_SIGNER_KEY VOL_SENDER_KEY PAYMASTER_SIGNER_PRIVATE_KEY AGENT_PRIVATE_KEY AGENT_KEY; do
      if grep -qE "^$v=." "$f"; then s_die "$v is set in $f: remove it and use a keystore in $KEYS instead"; fi
    done
  done
  local rpc chain
  rpc="$(envval PUBLIC_RPC_URL)"; rpc="${rpc:-https://rpc.$NET.chain.robinhood.com}"
  chain_id() { curl -fsS -m 20 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$rpc" | jq -er '.result'; }
  chain="$(s_retry "eth_chainId" chain_id)" || s_die "PUBLIC_RPC_URL did not answer eth_chainId (tried 3 times)"
  [[ -n "$chain" && "$((chain))" == "$CHAIN" ]] || s_die "PUBLIC_RPC_URL answered chain id ${chain:-nothing}, not Robinhood Chain $NET $CHAIN: refusing"
  local dep="$R/app/deployments/$CHAIN.json" want have
  [[ -f "$dep" ]] || s_die "$CHAIN.json missing from the release"
  jq -e --argjson c "$CHAIN" --arg n "$NET" '.chainId == $c and .network == $n and (.forkProof == null)' "$dep" >/dev/null || s_die "$CHAIN.json is not a $NET ($CHAIN) deployment"
  want="$(jq -r '.contracts.volOracle // empty' "$dep")"
  have="$(envval VOL_ORACLE_ADDRESS)"
  [[ -z "$want" || "$(lower "$want")" == "$(lower "$have")" ]] || s_die "VOL_ORACLE_ADDRESS in overdrive.env is $have but $CHAIN.json says volOracle = $want"

  # ---- keystores: each readable by the one service that signs with it and by no other service user
  [[ -n "$P" ]] || bash "$R/app/scripts/server/provision.sh" --service-users
  local role owner other
  for role in "${REQUIRED_KEYS[@]}"; do
    [[ -e "$KEYS/$role.json" && -e "$KEYS/$role.password" ]] || s_die "$KEYS/$role.json and $role.password are missing (copy the $role keystore and password file in)"
  done
  if [[ "$(envval VOL_SEND)" == 1 ]]; then
    [[ -e "$KEYS/vol-sender.json" && -e "$KEYS/vol-sender.password" ]] || s_die "VOL_SEND=1 needs $KEYS/vol-sender.json and vol-sender.password"
  fi
  for f in "$KEYS"/*.json; do
    [[ -e "$f" ]] || continue
    role="$(basename "$f" .json)"
    case "$role" in
      crank) owner=crank ;; hedger) owner=hedger ;; liquidator) owner=liquidator ;; vol-signer | vol-sender) owner=vol-engine ;;
      *) s_die "$f is not a known keystore role (crank, hedger, liquidator, vol-signer, vol-sender)" ;;
    esac
    if [[ -z "$P" ]]; then
      runuser -u "overdrive-$owner" -- test -r "$f" && runuser -u "overdrive-$owner" -- test -r "$KEYS/$role.password" \
        || s_die "$KEYS/$role.json or $role.password is not readable by overdrive-$owner: run provision.sh --service-users"
      for other in api indexer crank hedger liquidator vol-engine mcp risk-sim; do
        [[ "$other" == "$owner" ]] && continue
        if runuser -u "overdrive-$other" -- test -r "$f" 2>/dev/null; then s_die "$f is readable by overdrive-$other, which does not sign with it: run provision.sh --service-users"; fi
      done
    fi
  done
  s_log "preflight ok: $NET chain $CHAIN, keystores readable only by their own service"

  # ---- units, ownership, build (one at a time, memory-capped)
  [[ -n "$P" ]] || bash "$R/app/scripts/server/provision.sh" --units-only
  printf '%s\n' "$sha" >"$R/REVISION"
  if [[ -n "$P" ]]; then
    [[ -z "${OD_TEST_BUILD_CMD:-}" ]] || (cd "$R" && bash -c "$OD_TEST_BUILD_CMD") || s_die "test build command failed"
  else
    local live_dir=""
    [[ -L "$BASE/current" ]] && live_dir="$(cd "$BASE/current" && pwd -P)"
    if [[ -n "$live_dir" && -d "$live_dir/app/node_modules" ]] && cmp -s "$live_dir/app/bun.lock" "$R/app/bun.lock" && cmp -s "$live_dir/app/package.json" "$R/app/package.json"; then
      cp -a "$live_dir/app/node_modules" "$R/app/node_modules" && s_log "reused node_modules of the running release (bun.lock unchanged)"
    fi
    chown -R overdrive:overdrive "$R"
    chmod -R go-w,a+rX "$R"
    s_log "bun install --frozen-lockfile"
    bun_install() { (cd "$R/app" && capped runuser -u overdrive -- env HOME=/var/lib/overdrive PATH=/opt/overdrive/bin:/usr/bin:/bin bun install --frozen-lockfile --production); }
    s_retry "bun install" bun_install || s_die "bun install failed (tried 3 times); /opt/overdrive/current is unchanged"
    local pyd
    for pyd in vol-engine risk-sim; do
      s_log "$pyd virtualenv (hash-pinned: requirements.lock, --require-hashes)"
      venv_build() { (cd "$R/app/python/$pyd" && capped runuser -u overdrive -- env HOME=/var/lib/overdrive PATH=/usr/bin:/bin \
        bash -c 'python3 -m venv .venv && ./.venv/bin/pip install --quiet --no-cache-dir --require-hashes --no-deps -r requirements.lock && ./.venv/bin/pip install --quiet --no-cache-dir --no-deps --no-build-isolation .'); }
      s_retry "$pyd virtualenv" venv_build || s_die "could not build the $pyd virtualenv (tried 3 times); /opt/overdrive/current is unchanged"
    done
    s_log "config check: every service's environment loads through loadConfig"
    (cd "$R/app" && set -a && . "$ENVF" && . "$ETC/db.env" && set +a && env HOME=/root PATH=/opt/overdrive/bin:/usr/bin:/bin \
      bun -e 'import { loadConfig } from "./src/config"; loadConfig(); console.log("config ok")') || s_die "the environment does not load through loadConfig (see above); /opt/overdrive/current is unchanged"
    chmod 0755 "$R"
    chmod -R go-w,a+rX "$R"
  fi
  local vbin="$R/app/python/vol-engine/.venv/bin/vol-engine"
  if [[ -z "$P" || -x "$vbin" ]]; then # a test root has no virtualenv unless its build command stubs one
    s_log "vol keys: every market and pair gear in $CHAIN.json is posted under the id its oracle reads"
    vol_keys_check "$vbin" "$(envval VOL_KEYS)" "$R/app/deployments/$CHAIN.json" \
      || s_die "the vol engine's market keys do not match $CHAIN.json (see above); /opt/overdrive/current is unchanged"
  fi
  lock_release "$LOCKDIR"; HAVE_LOCK=0

  # ---- switch, migrate (roll the link back on failure)
  local prev=""
  [[ -L "$BASE/current" ]] && prev="$(readlink "$BASE/current")"
  point() { # atomic on Linux (rename over the link); plain ln -sfn on a Mac test root
    if [[ "$(uname)" == Linux ]]; then ln -sfn "$1" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"; else ln -sfn "$1" "$BASE/current"; fi
  }
  [[ -n "$prev" && -d "$BASE/$prev" && ! -e "$BASE/$prev/.healthy" ]] && touch "$BASE/$prev/.healthy"
  SWITCHED=1
  point "releases/$rel"
  s_log "current -> releases/$rel; migrating"
  if ! systemctl start overdrive-migrate.service; then
    journalctl -u overdrive-migrate.service -n 30 --no-pager -o cat 2>/dev/null | sed 's/^/  | /' || true
    [[ -z "$prev" ]] || point "$prev"
    if [[ -n "$prev" && "$(systemctl show -p ExecMainStatus --value overdrive-migrate.service 2>/dev/null)" == 75 ]]; then
      SWITCHED=0   # the migrator gave up on a lock timeout and rolled back: nothing changed
      s_die "migrations kept hitting a lock timeout under load (nothing applied): current is back on $prev; try again later"
    fi
    s_die "migrations failed: current is back on ${prev:-nothing}; services were not restarted"
  fi
  # The API's SELECT-only role: grants cover the tables the migrations just made (idempotent).
  if [[ -z "$P" ]]; then
    local pgport dbname ropw
    dbname="$(sed -n 's#^DATABASE_URL=.*/\([A-Za-z0-9_]*\)$#\1#p' "$ETC/db.env" | tail -1)"
    pgport="$(sed -n 's#^DATABASE_URL=.*@127.0.0.1:\([0-9]*\)/.*#\1#p' "$ETC/db.env" | tail -1)"
    if [[ -n "$dbname" && -n "$pgport" ]]; then
      local pgmode; pgmode="$( { sed -n 's/^PG_MODE=//p' "$ETC/provision.conf" 2>/dev/null || true; } | tail -1)"
      if [[ "${pgmode:-docker}" == docker ]]; then
        docker exec -i overdrive-db-postgres psql -X -q -v ON_ERROR_STOP=1 -U overdrive -d "$dbname" <"$R/app/scripts/api-readonly-role.sql" || s_die "could not apply the read-only API role grants"
      else
        runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$pgport" -d "$dbname" -f "$R/app/scripts/api-readonly-role.sql" || s_die "could not apply the read-only API role grants"
      fi
    fi
    unset ropw
  fi

  # ---- restart one by one, check each; roll back on the first failure
  local s units=()
  while IFS= read -r s; do units+=("overdrive-$s.service"); done < <(service_list)
  systemctl enable --quiet overdrive.target "${units[@]}"
  local bad=""
  while IFS= read -r s; do
    s_log "restarting $s"
    systemctl restart "overdrive-$s.service"
    if ! check_one "$s"; then bad="$s"; break; fi
  done < <(service_list)

  if [[ -n "$bad" ]]; then
    if [[ -z "$prev" ]]; then
      printf '\n%s failed on the first release (nothing to roll back to). Logs: journalctl -u overdrive-%s -n 100\n' "$bad" "$bad" >&2
      exit 1
    fi
    s_log "$bad is unhealthy: rolling back to $prev"
    point "$prev"
    local back=0
    while IFS= read -r s; do systemctl restart "overdrive-$s.service" || true; done < <(service_list)
    while IFS= read -r s; do check_one "$s" || back=1; done < <(service_list)
    printf '\nRelease %s FAILED at %s and was rolled back to %s%s. Migrations were not reversed. Logs: journalctl -u overdrive-%s -n 100\n' \
      "$rel" "$bad" "$prev" "$([[ "$back" == 0 ]] && echo " (healthy)" || echo " (STILL UNHEALTHY: look now)")" "$bad" >&2
    exit 1
  fi
  touch "$R/.healthy"
  prune_releases "$BASE" 5 "$(basename "${prev:-none}")"
  s_log "release $rel ($sha) live and healthy"
}
SRV
eval "$SERVER_FNS"

# P is the test-root prefix; a real server has none, and server_main runs under set -u, so the remote script sets it empty.
remote_script() { printf 'P=""\n%s\n%s\nserver_main "$@" </dev/null\n' "$RELEASE_FNS" "$SERVER_FNS"; }

# Tests source this file with DEPLOY_SH_SOURCE_ONLY=1 to reach the functions above without running a deploy.
if [[ "${DEPLOY_SH_SOURCE_ONLY:-}" == 1 ]]; then return 0 2>/dev/null || exit 0; fi

MODE=deploy
REF=HEAD
HOST=""
LOCAL=0
REPO=""
PROV_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) [[ $# -ge 2 ]] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --provision) MODE=provision; shift ;;
    --preflight) PROV_ARG="--preflight"; shift ;;
    --check) MODE=check; shift ;;
    --local) LOCAL=1; shift ;;
    --repo) [[ $# -ge 2 ]] || die "--repo needs a value"; REPO="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1 (try --help)" ;;
    *) [[ -z "$HOST" ]] || die "one host only"; HOST="$1"; shift ;;
  esac
done
if [[ "$LOCAL" == 1 && "$MODE" == check ]]; then
  [[ -z "$HOST" ]] || die "--local takes no host"   # read-only: no arming needed
elif [[ "$LOCAL" == 1 ]]; then
  # Real-deploy guard: first thing, before any other check, so a refused run touches nothing.
  [[ "${OVERDRIVE_ALLOW_REAL_DEPLOY:-}" == 1 ]] || die "--local refused: OVERDRIVE_ALLOW_REAL_DEPLOY=1 is not set (the real-deploy guard)"
  [[ -n "${OVERDRIVE_ALLOW_FILE:-}" && -f "$OVERDRIVE_ALLOW_FILE" ]] \
    || die "--local refused: the arming file named by OVERDRIVE_ALLOW_FILE is missing (the real-deploy guard)"
  [[ -z "$HOST" ]] || die "--local takes no host"
  [[ "$MODE" != provision ]] || die "--local cannot --provision"
  if [[ "$MODE" == deploy ]]; then
    [[ -n "$REPO" && -d "$REPO" ]] || die "--local deploy needs --repo <git dir>"
    [[ "$REF" =~ ^[0-9a-f]{40}$ ]] || die "--local deploy needs --ref <40-hex sha>, got '$REF'"
  fi
else
  [[ -z "$REPO" ]] || die "--repo only goes with --local"
  [[ -n "$HOST" ]] || { usage >&2; exit 2; }
  [[ "$HOST" =~ ^([A-Za-z0-9._-]+@)?[A-Za-z0-9._:-]+$ ]] || die "'$HOST' does not look like a host or user@host"
  if [[ "$MODE" == deploy ]]; then [[ "$REF" =~ ^[0-9a-f]{40}$ ]] || die "a deploy needs --ref <40-hex sha>, got '$REF'"; fi
fi

for bin in git gzip curl; do command -v "$bin" >/dev/null || die "$bin not found"; done
[[ "$LOCAL" == 1 ]] || command -v ssh >/dev/null || die "ssh not found"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# tests only: every server path moves under a fake root and the server steps run here against stubs on PATH
TEST_ROOT=""
if [[ -n "${OD_TEST_ROOT:-}" ]]; then
  [[ "$(id -u)" != 0 ]] || die "OD_TEST_ROOT is for tests only and is refused as root"
  TEST_ROOT="$OD_TEST_ROOT"
fi
BASE_DIR="$TEST_ROOT/opt/overdrive"

# ---------------------------------------------------------------- ssh (one shared connection)
SSH_EXTRA=()
if [[ -n "${SSH_OPTS:-}" ]]; then read -r -a SSH_EXTRA <<<"$SSH_OPTS"; fi
[[ "$HOST" == *@* ]] || SSH_EXTRA+=(-l root)
CTL_DIR="$(mktemp -d)"
cleanup() {
  [[ "$LOCAL" == 1 ]] || ssh -o ControlPath="$CTL_DIR/c" -O exit "$HOST" >/dev/null 2>&1 || true
  rm -rf "$CTL_DIR"
}
trap cleanup EXIT
ssh_() {
  ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath="$CTL_DIR/c" -o ControlPersist=300 \
    -o ServerAliveInterval=30 ${SSH_EXTRA[@]+"${SSH_EXTRA[@]}"} "$HOST" "$@"
}

run_remote() {
  if [[ -n "$TEST_ROOT" ]]; then ( P="$TEST_ROOT"; server_main "$@" )
  elif [[ "$LOCAL" == 1 ]]; then remote_script | P="" bash -s -- "$@"; else remote_script | ssh_ bash -s -- "$@"; fi
}

if [[ "$MODE" == check ]]; then
  run_remote check
  exit 0
fi

if [[ "$LOCAL" == 1 ]]; then ROOT="$(cd "$REPO" && pwd)"; else ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"; fi
SHA="$(git -C "$ROOT" rev-parse --verify "${REF}^{commit}")" || die_unswitched "no commit $REF"
if [[ "$LOCAL" == 0 && -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  log "note: the checkout has uncommitted changes; they are NOT deployed (only commit ${SHA:0:12})"
fi

# ---------------------------------------------------------------- --provision
if [[ "$MODE" == provision ]]; then
  log "copying app/scripts/server at ${SHA:0:12} to /root/overdrive-server"
  git -C "$ROOT" archive --format=tar "$SHA" app/scripts/server | gzip -c \
    | ssh_ "rm -rf /root/overdrive-server && mkdir -p /root/overdrive-server && tar -xzf - -C /root/overdrive-server --strip-components=3 --no-same-owner"
  envs=""
  for v in API_DOMAIN MCP_DOMAIN DB_NAME SWAP_SIZE PG_PORT PG_MODE PG_IMAGE PG_MEMORY CADDY_ADD_IMPORT CADDY_MAIN CADDY_CONF_DIR CADDY_RELOAD_CMD; do
    [[ -n "${!v:-}" ]] && envs+="$v=$(printf '%q' "${!v}") "
  done
  log "running provision.sh on the server (takes a few minutes)"
  ssh_ "cd /root/overdrive-server && ${envs}bash provision.sh $PROV_ARG"
  exit 0
fi

# ---------------------------------------------------------------- deploy: local checks
if [[ "$LOCAL" == 1 ]]; then
  NET="$( { sed -n 's/^NETWORK=//p' "$TEST_ROOT/etc/overdrive/overdrive.env" 2>/dev/null || true; } | tail -1)"
else
  NET="${OVERDRIVE_NETWORK:-}"
fi
case "${NET:-mainnet}" in
  mainnet) NET=mainnet; CHAIN=4663 ;;
  testnet) CHAIN=46630 ;;
  *) die_unswitched "unknown network '$NET' (mainnet or testnet)" ;;
esac
DEP_NAME="$CHAIN.json"
DEP_SRC="${OVERDRIVE_DEPLOYMENTS_SRC:-$ROOT/app/deployments}"
if [[ "$LOCAL" == 1 ]]; then [[ -n "${OVERDRIVE_DEPLOYMENTS_SRC:-}" ]] || die_unswitched "--local needs OVERDRIVE_DEPLOYMENTS_SRC (the folder that holds $DEP_NAME)"; fi
[[ -f "$DEP_SRC/$DEP_NAME" ]] || die_unswitched "no $NET deployment in $DEP_SRC ($DEP_NAME): set OVERDRIVE_DEPLOYMENTS_SRC to the folder that has it"
grep -Eq "\"chainId\"[[:space:]]*:[[:space:]]*$CHAIN([^0-9]|\$)" "$DEP_SRC/$DEP_NAME" || die_unswitched "$DEP_SRC/$DEP_NAME is not for chain $CHAIN"
grep -Eq "\"network\"[[:space:]]*:[[:space:]]*\"$NET\"" "$DEP_SRC/$DEP_NAME" || die_unswitched "$DEP_SRC/$DEP_NAME is not a $NET deployment (network must be $NET)"
if grep -Eq '"forkProof"' "$DEP_SRC/$DEP_NAME"; then die_unswitched "$DEP_SRC/$DEP_NAME comes from a fork run (it has forkProof)"; fi

# ---------------------------------------------------------------- deploy: upload, then run on the server
REL="$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}"
if [[ "$LOCAL" == 1 ]]; then
  log "deploying ${SHA:0:12} on this server as release $REL"
  [[ -d "$BASE_DIR/releases" ]] || die_unswitched "not provisioned: $BASE_DIR/releases is missing"
  stage_release "$ROOT" "$SHA" "$BASE_DIR/releases/$REL" "$DEP_SRC" "$DEP_NAME" || { abandon_release "$BASE_DIR" "$REL"; die_unswitched "could not write the release dir $BASE_DIR/releases/$REL"; }
else
  log "deploying ${SHA:0:12} to $HOST as release $REL"
  git -C "$ROOT" archive --format=tar "$SHA" app LICENSE README.md | gzip -c \
    | ssh_ "set -e; umask 022; test -d /opt/overdrive/releases || { echo 'not provisioned: run deploy.sh --provision first' >&2; exit 1; }; mkdir -m 0755 /opt/overdrive/releases/$REL; tar -xzf - -C /opt/overdrive/releases/$REL --no-same-owner" \
    || die_unswitched "upload to $HOST failed"
  ssh_ "umask 022; mkdir -p /opt/overdrive/releases/$REL/app/deployments"
  ssh_ "cat >/opt/overdrive/releases/$REL/app/deployments/$DEP_NAME" <"$DEP_SRC/$DEP_NAME"
fi
log "uploaded code and $DEP_NAME ($NET)"

run_remote deploy "$REL" "$SHA" "$NET"

if [[ -n "${OVERDRIVE_PUBLIC_API_URL:-}" ]]; then
  curl -fsS -m 20 "${OVERDRIVE_PUBLIC_API_URL%/}/health" >/dev/null && log "public API ok (${OVERDRIVE_PUBLIC_API_URL%/}/health)" \
    || die "public API check failed at ${OVERDRIVE_PUBLIC_API_URL%/}/health (DNS, Caddy certificate or firewall?)"
fi
log "done"

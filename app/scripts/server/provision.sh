#!/usr/bin/env bash
# Prepares the SHARED server to run Overdrive next to other services.
# Run as root ON THE SERVER, from this folder (it reads ./systemd, ./Caddyfile, ./env.example and ./backup.sh).
# Safe to run again: every step checks the current state first (proved by deploy-local.test.sh).
#
#   bash provision.sh                 everything below
#   bash provision.sh --preflight     read only: say what would be created, reused or refused; changes nothing
#   bash provision.sh --units-only    only (re)install the systemd units and the backup script (deploy.sh uses this)
#   bash provision.sh --service-users only create/refresh the service users, their state dirs and env files, and the
#                                     ownership of the keystores in /etc/overdrive/keys (deploy.sh and the owner use this)
#
# CO-TENANT RULES (docs/DECISIONS.md D24). This script never touches anything that is not named overdrive*: no unit, file, user, role
# or database. It does not change the firewall, SSH, fail2ban, sysctl, journald, /proc, NTP or the system's packages
# (no apt upgrade), and it installs nothing into /usr/local. Everything it creates is named overdrive* or lives under
# /opt/overdrive, /etc/overdrive, /var/lib/overdrive, /var/backups/overdrive.
#   Users      overdrive (owns releases, runs migrations) and one per service: overdrive-api, -indexer, -crank, -hedger,
#              -liquidator, -vol-engine, -mcp, -risk-sim
#   Ports      127.0.0.1 only: 38101 (api), 38102 (mcp). Listeners are detected first; a port that something else
#              holds makes the script refuse before it changes anything.
#   Postgres   PG_MODE=docker (default): Overdrive's OWN Postgres 16 container `overdrive-db-postgres` (image PG_IMAGE, an
#              exact tag), bound to 127.0.0.1:5433 only, named volume overdrive-pgdata, restart unless-stopped, 512m memory
#              limit; roles overdrive and read-only overdrive_api and the database live inside it. The only docker commands
#              are `docker ps` (names only) and commands naming overdrive-db-postgres / overdrive-pgdata: no other
#              container is ever inspected, stopped, entered or connected to. 5433 held by anything else: refused.
#              PG_MODE=host: the box's own host Postgres is reused (never reinstalled, never restarted, no config edit).
#   Memory     units run in overdrive.slice (MemoryMax 1536M in total) and each has its own MemoryMax.
#   Swap       a 4G swap file only when the box has no swap at all.
#   Caddy      one separate site file (conf.d/overdrive.caddy); the other sites are never edited or removed; Caddy is
#              reloaded (never restarted) only after `caddy validate` accepts the whole configuration. When the main
#              Caddyfile has no `import /etc/caddy/conf.d/*.caddy` line the script stops, unless CADDY_ADD_IMPORT=1: then it
#              copies the main file to Caddyfile.bak.overdrive-<UTC time>, appends that one line, validates, and on a
#              validation failure puts the copy back and does not reload.
#   Tools      Bun and cast at pinned versions under /opt/overdrive/bin (not /usr/local/bin).
#
# Env (optional; saved to /etc/overdrive/provision.conf and reused on the next run):
#   API_DOMAIN   default api.get-overdrive.com        MCP_DOMAIN  blank = no public MCP route        ACME_EMAIL (unused here)
#   DB_NAME      default overdrive                    API_PORT / MCP_PORT  defaults 38101 / 38102   PG_PORT  default 5433 (docker) / 5432 (host)
#   PG_MODE      docker (default) or host          PG_IMAGE  default postgres:16.10-bookworm (exact tag; pin a digest if you prefer)
#   PG_MEMORY    default 512m (container limit)
#   SWAP_SIZE    default 4G (0 = never add swap)      CADDY_ADD_IMPORT=1  append the conf.d import to the main Caddyfile
#   CADDY_MAIN   default /etc/caddy/Caddyfile         CADDY_CONF_DIR  default /etc/caddy/conf.d
#   CADDY_RELOAD_CMD  default "systemctl reload caddy" (set it when Caddy runs in a container)
# OD_TEST_ROOT: tests only, refused as root: every path is under it and ownership changes are skipped.
#
# It never creates, reads or moves a key: /etc/overdrive/keys is created empty and the owner copies the keystores in.
set -euo pipefail

BUN_VERSION="1.4.2"
FOUNDRY_VERSION="1.8.4"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P="${OD_TEST_ROOT:-}"
ETC="$P/etc/overdrive"
CONF="$ETC/provision.conf"
OPT="$P/opt/overdrive"
VAR="$P/var/lib/overdrive"

log() { printf '[provision %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[provision] WARNING: %s\n' "$*" >&2; }
die() { printf 'provision: %s\n' "$*" >&2; exit 1; }

MODE=all
case "${1:-}" in
  "") ;;
  --preflight) MODE=preflight ;;
  --units-only) MODE=units ;;
  --service-users | --fix-key-perms) MODE=users ;;
  -h | --help) sed -n '2,38p' "$0"; exit 0 ;;
  *) die "unknown argument $1 (try --help)" ;;
esac

if [[ -n "$P" ]]; then
  [[ "$(id -u)" != 0 ]] || die "OD_TEST_ROOT is for tests only and is refused as root"
else
  [[ "$(id -u)" == 0 ]] || die "run as root"
fi
for f in systemd/overdrive.target systemd/overdrive.slice Caddyfile env.example backup.sh; do
  [[ -e "$HERE/$f" ]] || die "missing $HERE/$f: run provision.sh from the app/scripts/server folder"
done
cd /

# Ownership changes are skipped under a test root (the test user cannot chown); the intent is logged for the test.
own() { # own <owner[:group]> <path>
  if [[ -n "$P" ]]; then printf 'own %s %s\n' "$1" "${2#"$P"}" >>"$P/own.log"; else chown "$1" "$2"; fi
}
mkd() { # mkd <mode> <owner:group> <dir>
  mkdir -p "$3"
  chmod "$1" "$3"; own "$2" "$3"
}

SERVICES=(api indexer crank hedger liquidator vol-engine mcp risk-sim)
KEYS_DIR="$ETC/keys"
key_owner() { # keystore role -> the one service that signs with it
  case "$1" in
    crank) echo crank ;; hedger) echo hedger ;; liquidator) echo liquidator ;;
    vol-signer | vol-sender) echo vol-engine ;;
    *) echo "" ;;
  esac
}
# Default env lines for a service, written only when its file does not exist (paths only, never a secret).
service_defaults() {
  case "$1" in
    crank | hedger | liquidator)
      local u; u="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
      printf '%s_KEYSTORE=/etc/overdrive/keys/%s.json\n%s_KEYSTORE_PASSWORD_FILE=/etc/overdrive/keys/%s.password\n' "$u" "$1" "$u" "$1" ;;
    vol-engine)
      printf 'VOL_SIGNER_KEYSTORE=/etc/overdrive/keys/vol-signer.json\nVOL_SIGNER_KEYSTORE_PASSWORD_FILE=/etc/overdrive/keys/vol-signer.password\n'
      printf 'VOL_SENDER_KEYSTORE=/etc/overdrive/keys/vol-sender.json\nVOL_SENDER_KEYSTORE_PASSWORD_FILE=/etc/overdrive/keys/vol-sender.password\n' ;;
  esac
}

ensure_service_users() {
  local s u f base owner
  id overdrive >/dev/null 2>&1 || die "the overdrive user is missing: run provision.sh without arguments first"
  mkd 0711 root:root "$ETC"
  mkd 0711 root:root "$KEYS_DIR"
  for s in "${SERVICES[@]}"; do
    u="overdrive-$s"
    if ! id "$u" >/dev/null 2>&1; then
      log "creating the $u system user"
      useradd --system --user-group --home-dir "/var/lib/overdrive/$s" --no-create-home --shell /usr/sbin/nologin "$u"
    fi
    mkd 0700 "$u:$u" "$VAR/$s"
    if [[ ! -e "$ETC/$s.env" ]]; then
      { printf '# Overrides for overdrive-%s only. Written by provision.sh (paths, never secrets).\n' "$s"; service_defaults "$s"; } >"$ETC/$s.env"
    fi
    own root:root "$ETC/$s.env"
    chmod 0600 "$ETC/$s.env"
  done
  mkd 0751 overdrive:overdrive "$VAR"
  mkd 0700 overdrive:overdrive "$VAR/data"
  for f in "$KEYS_DIR"/*.json "$KEYS_DIR"/*.password; do
    [[ -e "$f" ]] || continue
    base="$(basename "$f")"; base="${base%.json}"; base="${base%.password}"
    owner="$(key_owner "$base")"
    if [[ -n "$owner" ]]; then
      own "root:overdrive-$owner" "$f"; chmod 0440 "$f"
    else
      warn "$f is not a known keystore role: left readable by root only"
      own root:root "$f"; chmod 0400 "$f"
    fi
  done
}

install_units() {
  local f dest changed=0 u
  mkd 0755 root:root "$P/etc/systemd/system"
  for f in "$HERE"/systemd/*.service "$HERE"/systemd/*.target "$HERE"/systemd/*.timer "$HERE"/systemd/*.slice; do
    dest="$P/etc/systemd/system/$(basename "$f")"
    if ! cmp -s "$f" "$dest"; then install -m 0644 "$f" "$dest"; changed=1; fi
  done
  mkd 0755 root:root "$OPT/bin"
  if ! cmp -s "$HERE/backup.sh" "$OPT/bin/overdrive-backup"; then install -m 0755 "$HERE/backup.sh" "$OPT/bin/overdrive-backup"; changed=1; fi
  mkd 0700 root:root "$P/var/backups/overdrive"
  if [[ "$changed" == 1 ]]; then systemctl daemon-reload; log "systemd units installed"; else log "systemd units unchanged"; fi
  for u in overdrive-backup.timer overdrive-risk-sim.timer; do
    systemctl is-enabled --quiet "$u" 2>/dev/null || { systemctl enable --now --quiet "$u" || die "could not enable $u"; }
  done
}

case "$MODE" in
  users) ensure_service_users; log "service users, state dirs, env files and key ownership are in place"; exit 0 ;;
  units) ensure_service_users; install_units; exit 0 ;;
esac

# ---------------------------------------------------------------- settings
# shellcheck disable=SC1090
saved() { [[ -r "$CONF" ]] && (set +u; source "$CONF" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\""); }
API_DOMAIN="${API_DOMAIN:-$(saved API_DOMAIN || true)}"; API_DOMAIN="${API_DOMAIN:-api.get-overdrive.com}"
MCP_DOMAIN="${MCP_DOMAIN:-$(saved MCP_DOMAIN || true)}"
DB_NAME="${DB_NAME:-$(saved DB_NAME || true)}"; DB_NAME="${DB_NAME:-overdrive}"
API_PORT="${API_PORT:-38101}"; MCP_PORT="${MCP_PORT:-38102}"
PG_MODE="${PG_MODE:-$(saved PG_MODE || true)}"; PG_MODE="${PG_MODE:-docker}"
[[ "$PG_MODE" == docker || "$PG_MODE" == host ]] || die "PG_MODE must be docker or host"
if [[ "$PG_MODE" == docker ]]; then PG_PORT="${PG_PORT:-5433}"; else PG_PORT="${PG_PORT:-5432}"; fi
PG_IMAGE="${PG_IMAGE:-postgres:16.10-bookworm}"; PG_MEMORY="${PG_MEMORY:-512m}"
PG_CONTAINER=overdrive-db-postgres; PG_VOLUME=overdrive-pgdata
[[ "$PG_IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ && "$PG_MEMORY" =~ ^[0-9]+[mg]$ ]] || die "PG_IMAGE or PG_MEMORY has a bad value"
if [[ "$PG_MODE" == docker ]]; then
  [[ "$PG_PORT" == 5433 ]] || die "docker mode binds 127.0.0.1:5433 only (PG_PORT=$PG_PORT is not allowed)"
fi
SWAP_SIZE="${SWAP_SIZE:-4G}"
CADDY_MAIN="${CADDY_MAIN:-/etc/caddy/Caddyfile}"
CADDY_CONF_DIR="${CADDY_CONF_DIR:-/etc/caddy/conf.d}"
CADDY_RELOAD_CMD="${CADDY_RELOAD_CMD:-systemctl reload caddy}"
domain_re='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
[[ "$API_DOMAIN" =~ $domain_re ]] || die "API_DOMAIN '$API_DOMAIN' is not a domain name"
[[ -z "$MCP_DOMAIN" || "$MCP_DOMAIN" =~ $domain_re ]] || die "MCP_DOMAIN '$MCP_DOMAIN' is not a domain name"
[[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]] || die "DB_NAME '$DB_NAME' must be lowercase letters, digits and _"
[[ "$DB_NAME" == overdrive* ]] || die "DB_NAME '$DB_NAME' is not allowed (it must be Overdrive's own database)"
[[ "$API_PORT" =~ ^[0-9]+$ && "$MCP_PORT" =~ ^[0-9]+$ && "$PG_PORT" =~ ^[0-9]+$ ]] || die "ports must be numbers"
[[ "$SWAP_SIZE" =~ ^(0|[0-9]+[MG])$ ]] || die "SWAP_SIZE must be 0 or a size like 4G"

# ---------------------------------------------------------------- preflight: detect before changing anything
listener() { # listener <port>: prints the listener line, nothing when the port is free
  ss -H -ltn "sport = :$1" 2>/dev/null | head -1 || true
}
port_ok() { # port_ok <port> <our unit>: free, or held by our own active unit
  local l; l="$(listener "$1")"
  [[ -z "$l" ]] && return 0
  systemctl is-active --quiet "$2" 2>/dev/null
}
PROBLEMS=0
problem() { printf 'provision: REFUSED: %s\n' "$*" >&2; PROBLEMS=$((PROBLEMS + 1)); }
port_ok "$API_PORT" overdrive-api.service || problem "port $API_PORT is taken by something that is not overdrive-api: $(listener "$API_PORT")"
if [[ -n "$MCP_DOMAIN" ]] || systemctl is-enabled --quiet overdrive-mcp.service 2>/dev/null; then
  port_ok "$MCP_PORT" overdrive-mcp.service || problem "port $MCP_PORT is taken by something that is not overdrive-mcp: $(listener "$MCP_PORT")"
fi
[[ "$API_PORT" == 38101 && "$MCP_PORT" == 38102 ]] || warn "ports differ from the ones in systemd/*.service and Caddyfile (38101, 38102): edit those too"
PG_STATE=none
if [[ "$PG_MODE" == docker ]]; then
  # Only `docker ps` (names) is ever read about containers; the other project's containers are never inspected.
  if ! command -v docker >/dev/null 2>&1; then
    problem "PG_MODE=docker needs docker, which is not installed (this script does not install it): install it or use PG_MODE=host"
  elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
    PG_STATE=container
  elif [[ -n "$(listener "$PG_PORT")" ]]; then
    PG_STATE=foreign
    problem "port $PG_PORT is taken by something that is not $PG_CONTAINER: $(listener "$PG_PORT")"
  else
    PG_STATE=new
  fi
elif command -v psql >/dev/null 2>&1 && runuser -u postgres -- pg_isready -q -p "$PG_PORT" 2>/dev/null; then
  PG_STATE=reuse
elif [[ -n "$(listener "$PG_PORT")" ]]; then
  PG_STATE=foreign
  problem "something listens on port $PG_PORT but the postgres OS user cannot reach it (a container?): set PG_PORT to the host cluster's port, or ask first"
fi
if [[ "$PG_MODE" == host && "$PG_STATE" == reuse ]]; then
  owner="$(runuser -u postgres -- psql -X -tA -p "$PG_PORT" -d postgres -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$DB_NAME'" 2>/dev/null || true)"
  [[ -z "$owner" || "$owner" == overdrive ]] || problem "database $DB_NAME already exists and belongs to role '$owner', not overdrive: pick another DB_NAME"
fi
if [[ -f "$CADDY_MAIN" || -d "$P$(dirname "$CADDY_MAIN")" ]] || [[ -f "$P$CADDY_MAIN" ]]; then
  clash="$( { grep -rlF -- "$API_DOMAIN" "$P$(dirname "$CADDY_MAIN")" 2>/dev/null || true; } | grep -v '/overdrive\.caddy$' | head -1 || true)"
  [[ -z "$clash" ]] || problem "$API_DOMAIN already appears in ${clash#"$P"}: another site owns it"
fi
MAIN="$P$CADDY_MAIN"
if [[ -f "$MAIN" ]] && ! grep -qE "^[[:space:]]*import[[:space:]]+.*conf\.d" "$MAIN" && [[ "${CADDY_ADD_IMPORT:-0}" != 1 ]]; then
  problem "$CADDY_MAIN has no 'import $CADDY_CONF_DIR/*.caddy' line, so Overdrive's site file would stay inactive. Run again with CADDY_ADD_IMPORT=1 (backs the file up, appends that one line, validates, restores on failure) or add the line yourself"
fi
swap_now="$(swapon --show --noheadings 2>/dev/null || true)"
log "preflight: postgres=$PG_MODE/$PG_STATE (port $PG_PORT), swap=$([[ -n "$swap_now" ]] && echo present || echo none), ports $API_PORT/$MCP_PORT, domain $API_DOMAIN"
[[ "$PROBLEMS" == 0 ]] || die "$PROBLEMS problem(s) above: nothing was changed"
if [[ "$MODE" == preflight ]]; then
  if command -v ufw >/dev/null 2>&1; then ufw status 2>/dev/null | head -1 | sed 's/^/ufw (left as it is): /' || true; fi
  log "preflight ok: nothing changed"
  exit 0
fi

# ---------------------------------------------------------------- packages (only what is missing; no upgrade)
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
need=()
for pkg in git build-essential ca-certificates curl gnupg unzip jq openssl python3 python3-venv python3-pip postgresql-client; do
  dpkg -s "$pkg" >/dev/null 2>&1 || need+=("$pkg")
done
if [[ "$PG_MODE" == host && "$PG_STATE" == none ]]; then need+=(postgresql-16); fi
if ! command -v caddy >/dev/null 2>&1; then need+=(caddy); fi
if [[ "${#need[@]}" -gt 0 ]]; then
  log "apt: installing only what is missing: ${need[*]}"
  apt-get update -q
  apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install --no-install-recommends "${need[@]}"
else
  log "apt: nothing missing"
fi

# ---------------------------------------------------------------- swap (only when the box has none)
if [[ "$SWAP_SIZE" != 0 && -z "$swap_now" ]]; then
  log "no swap on this box: adding a $SWAP_SIZE swap file"
  [[ -f "$P/swapfile-overdrive" ]] || fallocate -l "$SWAP_SIZE" "$P/swapfile-overdrive"
  chmod 600 "$P/swapfile-overdrive"
  mkswap "$P/swapfile-overdrive" >/dev/null
  swapon "$P/swapfile-overdrive"
  grep -qsE '^[^ ]*swapfile-overdrive[[:space:]]' "$P/etc/fstab" || { mkdir -p "$P/etc"; echo "/swapfile-overdrive none swap sw 0 0" >>"$P/etc/fstab"; }
fi

# ---------------------------------------------------------------- user and directories
if ! id overdrive >/dev/null 2>&1; then
  log "creating the overdrive system user"
  useradd --system --user-group --home-dir /var/lib/overdrive --no-create-home --shell /usr/sbin/nologin overdrive
fi
mkd 0755 overdrive:overdrive "$OPT"
mkd 0755 overdrive:overdrive "$OPT/releases"
mkd 0755 root:root "$OPT/bin"
mkd 0750 overdrive:overdrive "$VAR"
ensure_service_users
umask 077
{
  echo "# Written by provision.sh; read by provision.sh and overdrive-backup."
  printf 'API_DOMAIN=%q\nMCP_DOMAIN=%q\nDB_NAME=%q\nPG_MODE=%q\n' "$API_DOMAIN" "$MCP_DOMAIN" "$DB_NAME" "$PG_MODE"
} >"$CONF.tmp"
if cmp -s "$CONF.tmp" "$CONF" 2>/dev/null; then rm -f "$CONF.tmp"; else mv "$CONF.tmp" "$CONF"; fi
chmod 0600 "$CONF"
umask 022

# ---------------------------------------------------------------- Bun and cast (pinned, in /opt/overdrive/bin only)
install_bun() {
  if [[ -x "$OPT/bin/bun" && "$("$OPT/bin/bun" --version 2>/dev/null)" == "$BUN_VERSION" ]]; then log "bun $BUN_VERSION already installed"; return; fi
  local asset tmp base
  case "$(uname -m)" in
    x86_64) asset=bun-linux-x64; grep -qw avx2 /proc/cpuinfo || asset=bun-linux-x64-baseline ;;
    aarch64 | arm64) asset=bun-linux-aarch64 ;;
    *) die "no Bun build for $(uname -m)" ;;
  esac
  log "installing bun $BUN_VERSION ($asset)"
  tmp="$(mktemp -d)"
  base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
  curl -fsSL --retry 3 -o "$tmp/$asset.zip" "$base/$asset.zip"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep -E " \*?${asset}\.zip\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "bun download does not match SHASUMS256.txt"
  unzip -q "$tmp/$asset.zip" -d "$tmp"
  install -m 0755 "$tmp/$asset/bun" "$OPT/bin/bun"
  rm -rf "$tmp"
  [[ "$("$OPT/bin/bun" --version)" == "$BUN_VERSION" ]] || die "bun --version is not $BUN_VERSION after install"
}
install_cast() {
  if [[ -x "$OPT/bin/cast" ]] && "$OPT/bin/cast" --version 2>/dev/null | grep -qF "$FOUNDRY_VERSION"; then log "cast $FOUNDRY_VERSION already installed"; return; fi
  local arch tmp url
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; *) die "no Foundry build for $(uname -m)" ;; esac
  url="https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_${arch}.tar.gz"
  log "installing cast $FOUNDRY_VERSION"
  tmp="$(mktemp -d)"
  if curl -fsSL --retry 3 -o "$tmp/foundry.tar.gz" "$url" && tar -xzf "$tmp/foundry.tar.gz" -C "$tmp" cast; then
    install -m 0755 "$tmp/cast" "$OPT/bin/cast"
  else
    rm -rf "$tmp"; die "could not install cast from $url"
  fi
  rm -rf "$tmp"
}
install_bun
install_cast

# ---------------------------------------------------------------- Postgres: reuse the server; own role + database
if [[ "$PG_MODE" == docker ]]; then
  # The container's first superuser is the role overdrive (POSTGRES_USER), and POSTGRES_DB creates the database. Local
  # socket connections inside the container are trusted, so roles are managed with `docker exec` and no admin password.
  PSQL=(docker exec -i "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U overdrive)
  pg_ready() { docker exec "$PG_CONTAINER" pg_isready -q -U overdrive -d postgres; }
  if [[ "$PG_STATE" == new ]]; then
    umask 077
    pgpass_pw=""
    if [[ -f "$ETC/db.env" ]]; then pgpass_pw="$(sed -n 's#^DATABASE_URL=postgres://overdrive:\([^@]*\)@.*#\1#p' "$ETC/db.env" | tail -1)"; fi
    [[ -n "$pgpass_pw" ]] || pgpass_pw="$(openssl rand -hex 24)"
    envf="$(mktemp)"
    printf 'POSTGRES_USER=overdrive\nPOSTGRES_DB=%s\nPOSTGRES_PASSWORD=%s\n' "$DB_NAME" "$pgpass_pw" >"$envf"
    umask 022
    log "docker: creating the $PG_CONTAINER container ($PG_IMAGE, 127.0.0.1:$PG_PORT, volume $PG_VOLUME, memory $PG_MEMORY)"
    if ! docker run -d --name "$PG_CONTAINER" --restart unless-stopped --memory "$PG_MEMORY" --memory-swap "$PG_MEMORY" \
      -p "127.0.0.1:$PG_PORT:5432" -v "$PG_VOLUME:/var/lib/postgresql/data" --env-file "$envf" \
      "$PG_IMAGE" -c shared_buffers=128MB -c max_connections=60 -c listen_addresses='*' >/dev/null; then
      rm -f "$envf"; unset pgpass_pw; die "docker run failed for $PG_CONTAINER: nothing else was changed"
    fi
    rm -f "$envf"
    # Keep the generated password: db.env is written below with it (the role overdrive has this password).
    PG_FIRST_PW="$pgpass_pw"; unset pgpass_pw
  else
    PG_FIRST_PW=""
    if [[ "$(docker ps --format '{{.Names}}' | grep -cx "$PG_CONTAINER")" == 0 ]]; then
      log "docker: $PG_CONTAINER exists but is stopped: starting it"
      docker start "$PG_CONTAINER" >/dev/null || die "could not start $PG_CONTAINER"
    fi
  fi
  for _ in $(seq 1 60); do pg_ready && break; sleep 1; done
  pg_ready || die "$PG_CONTAINER does not answer"
else
  PSQL=(runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$PG_PORT")
  PG_FIRST_PW=""
  pg_ready() { runuser -u postgres -- pg_isready -q -p "$PG_PORT"; }
  if [[ "$PG_STATE" == none ]]; then
    systemctl enable --now --quiet postgresql || die "postgresql did not start"
    for _ in $(seq 1 30); do pg_ready && break; sleep 1; done
  fi
  pg_ready || die "Postgres does not answer on port $PG_PORT"
fi
role_exists() { [[ "$("${PSQL[@]}" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$1'")" == 1 ]]; }
db_password="" ro_password=""
if [[ -f "$ETC/db.env" ]]; then
  db_password="$(sed -n 's#^DATABASE_URL=postgres://overdrive:\([^@]*\)@.*#\1#p' "$ETC/db.env" | tail -1)"
  ro_password="$(sed -n 's#^API_DB_READONLY_URL=postgres://overdrive_api:\([^@]*\)@.*#\1#p' "$ETC/db.env" | tail -1)"
fi
if [[ -n "$db_password" && -n "$ro_password" ]] && role_exists overdrive && role_exists overdrive_api \
  && [[ "$("${PSQL[@]}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" == 1 ]]; then
  log "postgres: role overdrive, role overdrive_api and database $DB_NAME already in place"
else
  log "postgres: role overdrive, role overdrive_api, database $DB_NAME (the other databases and roles are not touched)"
  [[ -n "$db_password" ]] || db_password="${PG_FIRST_PW:-$(openssl rand -hex 24)}"
  [[ -n "$ro_password" ]] || ro_password="$(openssl rand -hex 24)"
  role_exists overdrive || "${PSQL[@]}" -d postgres -c "CREATE ROLE overdrive LOGIN"
  role_exists overdrive_api || "${PSQL[@]}" -d postgres -c "CREATE ROLE overdrive_api LOGIN"
  # Passwords go through stdin, never through a command line.
  printf "ALTER ROLE overdrive WITH LOGIN PASSWORD '%s';\nALTER ROLE overdrive_api WITH LOGIN PASSWORD '%s';\n" "$db_password" "$ro_password" | "${PSQL[@]}" -d postgres
  if [[ "$("${PSQL[@]}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" != 1 ]]; then
    if [[ "$PG_MODE" == docker ]]; then "${PSQL[@]}" -d postgres -c "CREATE DATABASE $DB_NAME OWNER overdrive"
    else runuser -u postgres -- createdb -p "$PG_PORT" --owner=overdrive "$DB_NAME"; fi
  fi
  umask 077
  {
    echo "# Written by provision.sh. Read by systemd (as root) for every overdrive-* unit. Do not commit or copy."
    echo "DATABASE_URL=postgres://overdrive:${db_password}@127.0.0.1:${PG_PORT}/${DB_NAME}"
    echo "API_DB_READONLY_URL=postgres://overdrive_api:${ro_password}@127.0.0.1:${PG_PORT}/${DB_NAME}"
  } >"$ETC/db.env.tmp"
  mv "$ETC/db.env.tmp" "$ETC/db.env"
  own root:root "$ETC/db.env"; chmod 0600 "$ETC/db.env"
  umask 022
fi
unset db_password ro_password PG_FIRST_PW

# ---------------------------------------------------------------- /etc/overdrive/overdrive.env (first run only)
if [[ ! -f "$ETC/overdrive.env" ]]; then
  umask 077; install -m 0600 "$HERE/env.example" "$ETC/overdrive.env"; umask 022
  log "wrote /etc/overdrive/overdrive.env from env.example: replace every CHANGE_ME in it before deploying"
else
  log "/etc/overdrive/overdrive.env exists: left as it is"
fi
own root:root "$ETC/overdrive.env"; chmod 0600 "$ETC/overdrive.env"

# ---------------------------------------------------------------- Caddy: ONE separate site file, validated before any reload
site_tmp="$(mktemp)"
sed -e "s/__API_DOMAIN__/${API_DOMAIN}/g" -e "s/__MCP_DOMAIN__/${MCP_DOMAIN}/g" "$HERE/Caddyfile" >"$site_tmp"
[[ -n "$MCP_DOMAIN" ]] || sed -i.bak '/^# BEGIN mcp$/,/^# END mcp$/d' "$site_tmp"
rm -f "$site_tmp.bak"
chmod 0644 "$site_tmp"
SITE="$P$CADDY_CONF_DIR/overdrive.caddy"
import_missing=0
if [[ -f "$MAIN" ]] && ! grep -qE "^[[:space:]]*import[[:space:]]+.*conf\.d" "$MAIN"; then import_missing=1; fi
if cmp -s "$site_tmp" "$SITE" 2>/dev/null && [[ "$import_missing" == 0 ]]; then
  log "caddy: $CADDY_CONF_DIR/overdrive.caddy unchanged"
else
  mkdir -p "$(dirname "$SITE")"
  had_site=0; [[ -f "$SITE" ]] && { had_site=1; cp "$SITE" "$site_tmp.prev"; }
  main_bak=""
  install -m 0644 "$site_tmp" "$SITE"
  if [[ -f "$MAIN" ]] && ! grep -qE "^[[:space:]]*import[[:space:]]+.*conf\.d" "$MAIN"; then
    if [[ "${CADDY_ADD_IMPORT:-0}" == 1 ]]; then
      main_bak="$MAIN.bak.overdrive-$(date -u +%Y%m%dT%H%M%SZ)"; cp -p "$MAIN" "$main_bak"
      [[ -z "$(tail -c1 "$MAIN")" ]] || echo >>"$MAIN"
      printf 'import %s/*.caddy\n' "$CADDY_CONF_DIR" >>"$MAIN"
      log "caddy: appended one import line to $CADDY_MAIN (backup: ${main_bak#"$P"})"
    else
      die "$CADDY_MAIN has no import line for $CADDY_CONF_DIR: run again with CADDY_ADD_IMPORT=1"
    fi
  fi
  if [[ -f "$MAIN" ]] && ! caddy validate --adapter caddyfile --config "$MAIN" >/dev/null 2>"$site_tmp.err"; then
    sed 's/^/        | /' "$site_tmp.err" >&2
    if [[ "$had_site" == 1 ]]; then cp "$site_tmp.prev" "$SITE"; else rm -f "$SITE"; fi
    [[ -z "$main_bak" ]] || cp -p "$main_bak" "$MAIN"
    rm -f "$site_tmp" "$site_tmp.err" "$site_tmp.prev"
    die "caddy validate rejected the configuration: the site file and any main-file edit were reverted, Caddy was not reloaded"
  fi
  if grep -qE "^[[:space:]]*import[[:space:]]+.*conf\.d" "$MAIN" 2>/dev/null; then
    $CADDY_RELOAD_CMD || warn "caddy reload failed; the configuration is valid, reload it by hand"
    log "caddy: $CADDY_CONF_DIR/overdrive.caddy written for $API_DOMAIN${MCP_DOMAIN:+ and $MCP_DOMAIN}; validated and reloaded"
  fi
fi
rm -f "$site_tmp" "$site_tmp.err" "$site_tmp.prev"

# ---------------------------------------------------------------- units
install_units

cat <<EOT

provision: done.
  Users      overdrive (releases, migrations) and overdrive-{api,indexer,crank,hedger,liquidator,vol-engine,mcp,risk-sim}
  Postgres   $PG_MODE ($PG_STATE) on 127.0.0.1:$PG_PORT, database $DB_NAME, roles overdrive and overdrive_api; URLs in /etc/overdrive/db.env (0600)
  Caddy      $API_DOMAIN -> 127.0.0.1:$API_PORT${MCP_DOMAIN:+, $MCP_DOMAIN -> 127.0.0.1:$MCP_PORT} (certificates arrive once DNS points here)
  Backups    nightly to /var/backups/overdrive (systemctl list-timers overdrive-backup.timer)
Next (README.md in this folder):
  1. Edit /etc/overdrive/overdrive.env: replace every CHANGE_ME.
  2. Copy the keystore (<role>.json) and password file (<role>.password) of crank, hedger, liquidator and vol-signer into
     /etc/overdrive/keys/, then run: bash provision.sh --service-users
  3. From the owner's machine: app/scripts/server/deploy.sh --ref <sha> <host>
EOT

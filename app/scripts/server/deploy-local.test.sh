#!/usr/bin/env bash
# Tests for the server scripts (provision.sh, deploy.sh, backup.sh, units, env.example). Everything runs against a
# throwaway fake root (OD_TEST_ROOT) with stubbed systemctl, curl, apt-get, psql, caddy and friends on PATH. It never
# starts ssh (a fake ssh on PATH fails the test if called), never reaches a real server and never touches the network.
#   bash app/scripts/server/deploy-local.test.sh
# Test names (R11 to R14): provision_idempotent_and_no_keys_touched, failed_health_check_rolls_back_to_previous_release,
# check_changes_nothing, env_example_loads_and_job_names_valid, units_verify_and_hardening_keys_present, plus the
# co-tenant cases (ports, Postgres reuse, Caddy validation, swap, build lock, no other project).
set -uo pipefail
exec </dev/null
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$HERE/deploy.sh"; PROVISION="$HERE/provision.sh"; BACKUP="$HERE/backup.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/state"
fail=0; n=0
check() { local name="$1"; shift; n=$((n + 1)); if "$@"; then printf 'ok   %s\n' "$name"; else printf 'FAIL %s\n' "$name"; fail=$((fail + 1)); fi; }
has() { grep -Fq -- "$2" <<<"$1"; }
# GNU stat reads -f as "file system status" and prints to stdout before failing, so pick the flavour once.
if stat -c %a / >/dev/null 2>&1; then mode_of() { stat -c %a "$1"; }; else mode_of() { stat -f %Lp "$1"; }; fi
export -f mode_of

# ---------------------------------------------------------------- stubs (first on PATH)
S="$T/state"; CALLS="$T/calls.log"; : >"$CALLS"
stub() { printf '#!/bin/bash\n%s\n' "$2" >"$T/bin/$1"; chmod +x "$T/bin/$1"; }
stub ssh "echo \"ssh was called: \$*\" >>\"$T/ssh-called\"; exit 99"
stub id 'if [ "$#" -eq 0 ]; then exec /usr/bin/id; fi; if [ "$1" = "-u" ]; then exec /usr/bin/id -u; fi; [ -e "'"$S"'/users/$1" ]'
stub useradd 'echo "useradd $*" >>"'"$CALLS"'"; mkdir -p "'"$S"'/users"; for a in "$@"; do last="$a"; done; touch "'"$S"'/users/$last"'
stub dpkg '[ "$1" = "-s" ] && [ -e "'"$S"'/pkgs/$2" ]'
stub apt-get 'echo "apt-get $*" >>"'"$CALLS"'"; mkdir -p "'"$S"'/pkgs"; seen=0; for a in "$@"; do if [ "$seen" = 1 ]; then case "$a" in -*|Dpkg*) ;; *) touch "'"$S"'/pkgs/$a";; esac; fi; [ "$a" = install ] && seen=1; done; exit 0'
stub systemctl 'echo "systemctl $*" >>"'"$CALLS"'"
case "$1" in
  is-enabled) u="${@: -1}"; [ -e "'"$S"'/enabled/$u" ];;
  enable) u="${@: -1}"; mkdir -p "'"$S"'/enabled"; touch "'"$S"'/enabled/$u";;
  is-active) u="${@: -1}"; if [ "$u" = overdrive-crank.service ] && [ -e "'"$S"'/badsha" ]; then [ "$(cat "$OD_TEST_ROOT/opt/overdrive/current/REVISION" 2>/dev/null)" != "$(cat "'"$S"'/badsha")" ] || { [ "$2" = --quiet ] || echo failed; exit 3; }; fi; [ -e "'"$S"'/active/$u" ] || [ -n "${OD_ALL_ACTIVE:-}" ] || exit 3; [ "$2" = --quiet ] || echo active;;
  start) [ "$2" = overdrive-migrate.service ] && [ -e "'"$S"'/migrate-fail" ] && exit 1; exit 0;;
  show) case "$*" in *ExecMainStatus*) echo 1;; *) echo 100;; esac;;
  *) exit 0;;
esac'
stub journalctl 'exit 0'
stub curl 'echo "curl $*" >>"'"$CALLS"'"; case "$*" in *eth_chainId*) echo "{\"result\":\"0x1237\"}";; *"-w"*) printf "{\"ok\":true}\n200";; *) echo "{}";; esac'
stub ss 'for a in "$@"; do last="$a"; done; port="${last##*:}"; [ -e "'"$S"'/listeners" ] && grep -E ":${port}[[:space:]]" "'"$S"'/listeners" | head -1; exit 0'
stub runuser 'while [ "$1" != -- ] && [ $# -gt 0 ]; do shift; done; shift; exec "$@"'
stub pg_isready '[ -e "'"$S"'/pg_up" ]'
stub psql 'in=""; [ -t 0 ] || in="$(cat)"; all="$* $in"
case "$all" in
  *"FROM pg_roles WHERE rolname = "*) r="${all#*rolname = \'"'"'}"; r="${r%%\'"'"'*}"; [ -e "'"$S"'/roles/$r" ] && echo 1;;
  *"pg_get_userbyid"*) d="${all#*datname = \'"'"'}"; d="${d%%\'"'"'*}"; [ -e "'"$S"'/dbowner/$d" ] && cat "'"$S"'/dbowner/$d";;
  *"FROM pg_database WHERE datname = "*) d="${all#*datname = \'"'"'}"; d="${d%%\'"'"'*}"; [ -e "'"$S"'/dbs/$d" ] && echo 1;;
  *"CREATE ROLE"*) r="$(echo "$all" | sed -n "s/.*CREATE ROLE \([a-z_]*\).*/\1/p")"; echo "psql CREATE ROLE $r" >>"'"$CALLS"'"; mkdir -p "'"$S"'/roles"; touch "'"$S"'/roles/$r";;
  *"ALTER ROLE"*) echo "psql ALTER ROLE" >>"'"$CALLS"'";;
  *) echo "psql other: $*" >>"'"$CALLS"'";;
esac; exit 0'
stub createdb 'echo "createdb $*" >>"'"$CALLS"'"; for a in "$@"; do last="$a"; done; mkdir -p "'"$S"'/dbs" "'"$S"'/dbowner"; touch "'"$S"'/dbs/$last"; echo overdrive >"'"$S"'/dbowner/$last"'
stub swapon 'if [ "$1" = --show ]; then cat "'"$S"'/swap" 2>/dev/null; exit 0; fi; echo "swapon $*" >>"'"$CALLS"'"'
stub fallocate 'echo "fallocate $*" >>"'"$CALLS"'"; for a in "$@"; do last="$a"; done; touch "$last"'
stub mkswap 'echo "mkswap $*" >>"'"$CALLS"'"'
stub caddy 'echo "caddy $*" >>"'"$CALLS"'"; [ "$1" = validate ] && [ -e "'"$S"'/caddy-invalid" ] && { echo "Error: invalid" >&2; exit 1; }; exit 0'
stub ufw 'echo "ufw $*" >>"'"$CALLS"'"; echo "Status: active"'
stub pg_dump 'echo "PGDMP fake dump"'
stub pg_restore 'exit 0'
export PATH="$T/bin:$PATH"
unset OVERDRIVE_ALLOW_REAL_DEPLOY OVERDRIVE_ALLOW_FILE OVERDRIVE_DEPLOYMENTS_SRC OD_TEST_ROOT
export OD_SETTLE=0 OD_PRE_SLEEP=0 DEPLOY_RETRY_WAITS="0 0"
touch "$T/armed"
SHA=0123456789abcdef0123456789abcdef01234567

# ---------------------------------------------------------------- A: the command line and the real-deploy guard
run() { # run <name> <want: 0|nz|N> <pattern> <envspec> args...
  local name="$1" want="$2" pat="$3" envspec="$4" out rc; shift 4
  # shellcheck disable=SC2086
  out="$(env $envspec bash "$DEPLOY" "$@" 2>&1)"; rc=$?
  n=$((n + 1))
  if [[ "$want" == 0 && $rc -ne 0 ]] || [[ "$want" == nz && $rc -eq 0 ]] || [[ "$want" =~ ^[0-9]+$ && "$want" != 0 && $rc -ne "$want" ]] || ! grep -Fq -- "$pat" <<<"$out"; then
    printf 'FAIL %s (rc=%s, wanted %s, pattern "%s")\n%s\n' "$name" "$rc" "$want" "$pat" "$out"; fail=$((fail + 1))
  else printf 'ok   %s\n' "$name"; fi
}
ARM="OVERDRIVE_ALLOW_REAL_DEPLOY=1 OVERDRIVE_ALLOW_FILE=$T/armed"
D=(--local --repo "$T" --ref "$SHA")
run "refuses with neither flag nor env"       nz "OVERDRIVE_ALLOW_REAL_DEPLOY=1 is not set" "" "${D[@]}"
run "refuses with env but no arming file var" nz "arming file" "OVERDRIVE_ALLOW_REAL_DEPLOY=1" "${D[@]}"
run "refuses with env but file missing"       nz "arming file" "OVERDRIVE_ALLOW_REAL_DEPLOY=1 OVERDRIVE_ALLOW_FILE=$T/nope" "${D[@]}"
run "refuses with file but no env"            nz "OVERDRIVE_ALLOW_REAL_DEPLOY=1 is not set" "OVERDRIVE_ALLOW_FILE=$T/armed" "${D[@]}"
run "refuses env=0"                           nz "OVERDRIVE_ALLOW_REAL_DEPLOY=1 is not set" "OVERDRIVE_ALLOW_REAL_DEPLOY=0 OVERDRIVE_ALLOW_FILE=$T/armed" "${D[@]}"
run "armed: refuses a host"                   nz "takes no host" "$ARM" --local somehost --check
run "armed: refuses --provision"              nz "cannot --provision" "$ARM" --local --provision
run "armed: deploy needs --repo"              nz "needs --repo" "$ARM" --local --ref "$SHA"
run "armed: refuses a branch name as ref"     nz "40-hex" "$ARM" --local --repo "$T" --ref main
run "armed: refuses a short sha"              nz "40-hex" "$ARM" --local --repo "$T" --ref abc1234
run "remote deploy refuses a branch name"     nz "40-hex" "" --ref main somehost
run "--repo without --local is refused"       nz "only goes with --local" "" --repo "$T" somehost
run "no host and no --local: usage, exit 2"   2 "deploy.sh --ref" "" --check


# ---------------------------------------------------------------- a small repo (two commits) and a fake provisioned root
G="$T/src"; mkdir -p "$G/app/src" "$G/app/python/vol-engine" "$G/app/python/risk-sim"
git -C "$G" init -q
printf 'export const x = 1;\n' >"$G/app/src/x.ts"; echo 'x = 1' >"$G/app/python/vol-engine/x.py"; echo 'y = 1' >"$G/app/python/risk-sim/y.py"; echo MIT >"$G/LICENSE"; echo readme >"$G/README.md"
gc() { git -C "$G" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q "$@"; }
git -C "$G" add -A && gc -m one; SHA1="$(git -C "$G" rev-parse HEAD)"
echo 'export const x = 2;' >"$G/app/src/x.ts"; git -C "$G" add -A && gc -m two; SHA2="$(git -C "$G" rev-parse HEAD)"
git clone -q --bare "$G" "$T/queue.git"
mkdir "$T/dep"; printf '{"chainId": 4663, "network": "mainnet"}\n' >"$T/dep/4663.json"

mkroot() { # mkroot <dir>: a provisioned fake server root
  local r="$1"
  mkdir -p "$r/opt/overdrive/bin" "$r/opt/overdrive/releases" "$r/etc/overdrive/keys" "$r/var/lock"
  printf '#!/bin/sh\necho 1.4.4\n' >"$r/opt/overdrive/bin/bun"; chmod +x "$r/opt/overdrive/bin/bun"
  printf 'NETWORK=mainnet\nCHAIN_ID=4663\nDEPLOYMENT_FILE=/opt/overdrive/current/app/deployments/4663.json\nPUBLIC_RPC_URL=http://rpc.test\nAPI_PORT=38101\n' >"$r/etc/overdrive/overdrive.env"
  printf 'DATABASE_URL=postgres://overdrive:x@127.0.0.1:5432/overdrive\n' >"$r/etc/overdrive/db.env"
  local k; for k in crank hedger liquidator vol-signer; do echo fake >"$r/etc/overdrive/keys/$k.json"; echo fake >"$r/etc/overdrive/keys/$k.password"; done
}
dep() { # dep <root> <sha> [extra env...]: a --local deploy against the fake root; prints output, returns the exit code
  local r="$1" sha="$2"; shift 2
  env OVERDRIVE_ALLOW_REAL_DEPLOY=1 OVERDRIVE_ALLOW_FILE="$T/armed" OVERDRIVE_DEPLOYMENTS_SRC="$T/dep" OD_TEST_ROOT="$r" OD_ALL_ACTIVE=1 "$@" \
    bash "$DEPLOY" --local --repo "$T/queue.git" --ref "$sha" 2>&1
}
snapshot() { (cd "$1" && find . -path ./own.log -prune -o -print | LC_ALL=C sort | while read -r f; do if [ -f "$f" ]; then printf '%s %s %s\n' "$f" "$(mode_of "$f")" "$(shasum "$f" | cut -d' ' -f1)"; else printf '%s dir %s\n' "$f" "$(mode_of "$f")"; fi; done); }

# ---------------------------------------------------------------- B: release dirs (umask, bare repo, retry)
out="$(umask 077; DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; umask; stage_release "$2" "$3" "$4" "$5" && echo staged' _ "$DEPLOY" "$T/queue.git" "$SHA1" "$T/rel1" "$T/dep" 2>&1)"
check "stage_release: umask 022 over the caller's 077, works from a bare repo" bash -c '[ "$(printf "%s" "$1" | head -1)" = 0022 ] && printf "%s" "$1" | grep -qx staged' _ "$out"
check "release dir drwxr-xr-x, files -rw-r--r--, vol-engine and risk-sim shipped" bash -c '[ "$(ls -ld "$1" | cut -c1-10)" = drwxr-xr-x ] && [ "$(ls -l "$1/app/deployments/4663.json" | cut -c1-10)" = -rw-r--r-- ] && [ -f "$1/app/python/vol-engine/x.py" ] && [ -f "$1/app/python/risk-sim/y.py" ]' _ "$T/rel1"
cat >"$T/flaky" <<'EOF'
#!/bin/bash
n=$(( $(cat "$1" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$1"; [ "$n" -ge "$2" ]
EOF
chmod +x "$T/flaky"
DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; retry flaky "$2" "$3" 3' _ "$DEPLOY" "$T/flaky" "$T/c1" >/dev/null 2>&1; rc=$?
check "retry: fails twice, passes on the third try" [ "$rc" == 0 -a "$(cat "$T/c1")" == 3 ]
DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; retry flaky "$2" "$3" 9' _ "$DEPLOY" "$T/flaky" "$T/c2" >/dev/null 2>&1; rc=$?
check "retry: gives up after 3 tries" [ "$rc" == 1 -a "$(cat "$T/c2")" == 3 ]

# ---------------------------------------------------------------- C: a healthy deploy, then check_changes_nothing
R1="$T/r1"; mkroot "$R1"
out="$(dep "$R1" "$SHA1")"; rc=$?
check "first deploy on a provisioned fake root: exit 0, live and healthy" bash -c '[ "$1" = 0 ] && grep -q "live and healthy" <<<"$2"' _ "$rc" "$out"
check "  ... current points at the release and carries REVISION and .healthy" bash -c 'c="$1/opt/overdrive/current"; [ -L "$c" ] && [ "$(cat "$c/REVISION")" = "$2" ] && [ -e "$c/.healthy" ]' _ "$R1" "$SHA1"
order="$(grep -E "systemctl (start|restart) " "$CALLS" | sed 's/systemctl //; s/overdrive-//; s/\.service//' | tr '\n' ' ')"
check "  ... migrate runs first, then indexer api crank vol-engine hedger liquidator (R12 order)" has "$order" "start migrate restart indexer restart api restart crank restart vol-engine restart hedger restart liquidator"
check "  ... only overdrive-* units were ever started or restarted" bash -c '! grep -E "systemctl (start|restart|stop|enable) " "$1" | grep -v overdrive'  _ "$CALLS"
check "check_changes_nothing: --local --check leaves every file as it was" bash -c '
  before="$(cd "$1" && find . -type f -o -type l | LC_ALL=C sort | xargs ls -ld | cut -c1-10,30- | shasum)"
  OD_TEST_ROOT="$1" OD_ALL_ACTIVE=1 OD_SETTLE=0 OD_PRE_SLEEP=0 bash "$2" --local --check >/dev/null 2>&1; rc=$?
  after="$(cd "$1" && find . -type f -o -type l | LC_ALL=C sort | xargs ls -ld | cut -c1-10,30- | shasum)"
  [ "$rc" = 0 ] && [ "$before" = "$after" ]' _ "$R1" "$DEPLOY"
: >"$CALLS"; OD_TEST_ROOT="$R1" OD_ALL_ACTIVE=1 bash "$DEPLOY" --local --check >/dev/null 2>&1
check "  ... and --check issues no start, restart, enable or stop" bash -c '! grep -E "systemctl (start|restart|stop|enable|daemon-reload)" "$1"' _ "$CALLS"
check "--local --check needs no arming file" bash -c 'OD_TEST_ROOT="$1" OD_ALL_ACTIVE=1 OD_SETTLE=0 OD_PRE_SLEEP=0 bash "$2" --local --check >/dev/null 2>&1' _ "$R1" "$DEPLOY"
check "  ... and is unhealthy (exit 1) when a service is not active" bash -c '! env OD_TEST_ROOT="$1" OD_SETTLE=0 OD_PRE_SLEEP=0 bash "$2" --local --check >/dev/null 2>&1' _ "$R1" "$DEPLOY"

# ---------------------------------------------------------------- D: failed_health_check_rolls_back_to_previous_release
sleep 1
prev_link="$(readlink "$R1/opt/overdrive/current")"
echo "$SHA2" >"$S/badsha"; : >"$CALLS"
out="$(dep "$R1" "$SHA2")"; rc=$?
check "failed_health_check_rolls_back_to_previous_release: exit 1 and says rolled back" bash -c '[ "$1" = 1 ] && grep -q "rolled back to" <<<"$2" && grep -q "crank is unhealthy" <<<"$2"' _ "$rc" "$out"
check "  ... current is back on the previous release" [ "$(readlink "$R1/opt/overdrive/current")" == "$prev_link" ]
check "  ... services after the failing one were never started on the bad release" bash -c '! grep -q "restarting hedger" <<<"$1" || [ "$(grep -c "restarting hedger" <<<"$1")" = 1 ]' _ "$out"
check "  ... every service was restarted again on the previous release" bash -c 'grep -c "systemctl restart overdrive-liquidator.service" "$1" | grep -qx 1' _ "$CALLS"
check "  ... the failed release is not marked healthy" bash -c '! ls "$1"/opt/overdrive/releases/*-'"${SHA2:0:12}"'/.healthy 2>/dev/null' _ "$R1"
rm -f "$S/badsha"
# migration failure: link goes back, nothing restarted
sleep 1; : >"$CALLS"; touch "$S/migrate-fail"
out="$(dep "$R1" "$SHA2")"; rc=$?
check "migration failure: exit 1, link back, services not restarted" bash -c '[ "$1" = 1 ] && grep -q "migrations failed" <<<"$2" && ! grep -q "systemctl restart" "$3" && [ "$(readlink "$4/opt/overdrive/current")" = "$5" ]' _ "$rc" "$out" "$CALLS" "$R1" "$prev_link"
rm -f "$S/migrate-fail"
# failures before the switch exit 75 and leave current alone
sleep 1; printf 'NETWORK=moon\n' >"$R1/etc/overdrive/overdrive.env.bad"
cp "$R1/etc/overdrive/overdrive.env" "$T/env.keep"; sed -i.bak 's/^CHAIN_ID=4663/CHAIN_ID=1/' "$R1/etc/overdrive/overdrive.env"; rm -f "$R1/etc/overdrive/overdrive.env.bak" "$R1/etc/overdrive/overdrive.env.bad"
out="$(dep "$R1" "$SHA2")"; rc=$?
check "a wrong CHAIN_ID stops before the switch: exit 75, current unchanged" bash -c '[ "$1" = 75 ] && [ "$(readlink "$2/opt/overdrive/current")" = "$3" ]' _ "$rc" "$R1" "$prev_link"
cp "$T/env.keep" "$R1/etc/overdrive/overdrive.env"
sleep 1; printf 'CRANK_PRIVATE_KEY=0xabc\n' >>"$R1/etc/overdrive/crank.env"
out="$(dep "$R1" "$SHA2")"; rc=$?
check "a raw key in any env file is refused before the switch (exit 75)" bash -c '[ "$1" = 75 ] && grep -q "CRANK_PRIVATE_KEY is set" <<<"$2"' _ "$rc" "$out"
rm -f "$R1/etc/overdrive/crank.env"
sleep 1; rm "$R1/etc/overdrive/keys/hedger.json"
out="$(dep "$R1" "$SHA2")"; rc=$?
check "a missing required keystore is refused before the switch (exit 75)" bash -c '[ "$1" = 75 ] && grep -q "hedger.json and hedger.password are missing\|hedger.json and" <<<"$2"' _ "$rc" "$out"
echo fake >"$R1/etc/overdrive/keys/hedger.json"
sleep 1; echo 'VOL_ORACLE_ADDRESS=CHANGE_ME' >>"$R1/etc/overdrive/overdrive.env"
out="$(dep "$R1" "$SHA2")"; rc=$?
check "a CHANGE_ME left in overdrive.env is refused (exit 75)" bash -c '[ "$1" = 75 ] && grep -q "fill these" <<<"$2" || { echo "$2"; exit 1; }' _ "$rc" "$out"
cp "$T/env.keep" "$R1/etc/overdrive/overdrive.env"

# ---------------------------------------------------------------- E: one build at a time (lock)
sleep 1
mkdir -p "$R1/var/lock/overdrive-build.lock.d"; sleep 30 & holder=$!; echo "$holder" >"$R1/var/lock/overdrive-build.lock.d/pid"
out="$(dep "$R1" "$SHA2" OD_LOCK_WAIT=1)"; rc=$?
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
check "build lock held by a live build: the deploy waits, then stops with exit 75" bash -c '[ "$1" = 75 ] && grep -q "holds the lock" <<<"$2"' _ "$rc" "$out"
check "  ... and a lock left by a dead build is taken over" bash -c '
  mkdir -p "$1/var/lock/overdrive-build.lock.d"; echo 999999 >"$1/var/lock/overdrive-build.lock.d/pid"
  DEPLOY_SH_SOURCE_ONLY=1; . "$2"; lock_acquire "$1/var/lock/overdrive-build.lock.d" 1 && lock_release "$1/var/lock/overdrive-build.lock.d"' _ "$R1" "$DEPLOY"

# ---------------------------------------------------------------- F: testnet profile has no hedger; unknown network refused
sleep 1; R2="$T/r2"; mkroot "$R2"
printf 'NETWORK=testnet\nCHAIN_ID=46630\nDEPLOYMENT_FILE=/opt/overdrive/current/app/deployments/46630.json\nPUBLIC_RPC_URL=http://rpc.test\n' >"$R2/etc/overdrive/overdrive.env"
mkdir "$T/tdep"; printf '{"chainId": 46630, "network": "testnet"}\n' >"$T/tdep/46630.json"
rm "$R2/etc/overdrive/keys/hedger."*
sed -i.bak 's/0x1237/0xb626/' "$T/bin/curl"; rm -f "$T/bin/curl.bak"
: >"$CALLS"; out="$(dep "$R2" "$SHA1" OVERDRIVE_DEPLOYMENTS_SRC="$T/tdep")"; rc=$?
check "testnet profile: deploys 46630.json without a hedger" bash -c '[ "$1" = 0 ] && ! grep -q "restart overdrive-hedger" "$2" && grep -q "restart overdrive-liquidator" "$2"' _ "$rc" "$CALLS"
sed -i.bak 's/0xb626/0x1237/' "$T/bin/curl"; rm -f "$T/bin/curl.bak"
sleep 1; printf 'NETWORK=moon\n' >"$R2/etc/overdrive/overdrive.env"
out="$(dep "$R2" "$SHA1" OVERDRIVE_DEPLOYMENTS_SRC="$T/tdep")"; rc=$?
check "an unknown NETWORK is refused before anything: exit 75" [ "$rc" == 75 ]

# ---------------------------------------------------------------- G: provision.sh against a fake root
BUNV="$(sed -n 's/^BUN_VERSION="\(.*\)"/\1/p' "$PROVISION")"; FV="$(sed -n 's/^FOUNDRY_VERSION="\(.*\)"/\1/p' "$PROVISION")"
newprov() { # newprov <root>: fake box with Postgres, Caddy (another project's site), and swap, pinned tools present
  local r="$1"; rm -rf "$S"; mkdir -p "$S" "$r/opt/overdrive/bin" "$r/etc/caddy/conf.d"
  printf '#!/bin/sh\necho %s\n' "$BUNV" >"$r/opt/overdrive/bin/bun"; printf '#!/bin/sh\necho "cast Version: %s-stable"\n' "$FV" >"$r/opt/overdrive/bin/cast"; chmod +x "$r/opt/overdrive/bin/"*
  touch "$S/pg_up"; echo "/swapfile file 2G" >"$S/swap"
  printf 'other.example.org {\n\treverse_proxy 127.0.0.1:9000\n}\nimport /etc/caddy/conf.d/*.caddy\n' >"$r/etc/caddy/Caddyfile"
  printf 'cap.example.org {\n\trespond "tenant"\n}\n' >"$r/etc/caddy/conf.d/tenant.caddy"
  mkdir -p "$S/roles" "$S/dbs" "$S/dbowner"; touch "$S/roles/tenant" "$S/dbs/tenant"; echo tenant >"$S/dbowner/tenant"
  : >"$CALLS"
}
prov() { env OD_TEST_ROOT="$PROV" PG_MODE=host bash "$PROVISION" "$@" 2>&1; }
PROV="$T/p1"; newprov "$PROV"
mkdir -p "$PROV/etc/overdrive/keys"; printf 'KEYSTORE-BYTES\n' >"$PROV/etc/overdrive/keys/crank.json"; printf 'pw-bytes\n' >"$PROV/etc/overdrive/keys/crank.password"
keyhash="$(shasum "$PROV/etc/overdrive/keys/"* | shasum)"
capcad="$(shasum "$PROV/etc/caddy/Caddyfile" "$PROV/etc/caddy/conf.d/tenant.caddy" | shasum)"
out="$(prov)"; rc=$?
check "provision first run succeeds" bash -c '[ "$1" = 0 ] || { echo "$2"; exit 1; }' _ "$rc" "$out"
snap1="$(snapshot "$PROV")"; cp "$CALLS" "$T/calls.first"; : >"$CALLS"
out2="$(prov)"; rc2=$?
snap2="$(snapshot "$PROV")"
check "provision_idempotent_and_no_keys_touched: second run exits 0 and changes no file or mode" bash -c '[ "$1" = 0 ] && [ "$2" = "$3" ]' _ "$rc2" "$snap1" "$snap2"
check "  ... and issues no mutating call (user, package, swap, role, database, enable, reload, curl)" bash -c '! grep -E "^(useradd|apt-get|fallocate|mkswap|swapon|createdb|curl|psql CREATE|psql ALTER|ufw (allow|default|enable))|systemctl (enable|reload|restart|start|stop|daemon-reload)" "$1"' _ "$CALLS"
check "  ... key files unchanged (bytes), never created or moved by provision" bash -c '[ "$(shasum "$1"/etc/overdrive/keys/* | shasum)" = "$2" ]' _ "$PROV" "$keyhash"
check "  ... keys dir was empty of anything but the owner's files (no key generated)" bash -c '[ "$(ls "$1/etc/overdrive/keys" | wc -l | tr -d " ")" = 2 ]' _ "$PROV"
check "  ... the key file is group-readable only by its service (own log + mode 440)" bash -c 'grep -q "own root:overdrive-crank /etc/overdrive/keys/crank.json" "$1/own.log" && [ "$(mode_of "$1/etc/overdrive/keys/crank.json")" = 440 ]' _ "$PROV"
check "  ... env files and db.env are mode 600, keys dir is empty-by-default 711" bash -c 'for f in overdrive.env db.env crank.env; do [ "$(mode_of "$1/etc/overdrive/$f")" = 600 ] || exit 1; done' _ "$PROV"
check "  ... the other project's Caddy files are byte for byte unchanged" bash -c '[ "$(shasum "$1/etc/caddy/Caddyfile" "$1/etc/caddy/conf.d/tenant.caddy" | shasum)" = "$2" ]' _ "$PROV" "$capcad"
check "  ... Overdrive's site is its own file and names its domain and port" bash -c 'grep -q "api.get-overdrive.com" "$1/etc/caddy/conf.d/overdrive.caddy" && grep -q "127.0.0.1:38101" "$1/etc/caddy/conf.d/overdrive.caddy"' _ "$PROV"
check "  ... api and mcp each get a rotated access log in Overdrive's own file names" bash -c 'f="$1/etc/caddy/conf.d/overdrive.caddy"; grep -q "output file /var/log/caddy/overdrive-api.log" "$f" && grep -q "roll_size 20MiB" "$f" && grep -q "roll_keep 5" "$f"' _ "$PROV"
check "  ... the site template logs both api and mcp, never a shared log name" bash -c 't="$1/Caddyfile"; [ "$(grep -c "output file /var/log/caddy/overdrive-" "$t")" = 2 ] && grep -q "overdrive-mcp.log" "$t" && ! grep -q "/var/log/caddy/api.log\|/var/log/caddy/mcp.log" "$t"' _ "$(cd "$(dirname "$0")" && pwd)"
check "  ... caddy validated, then reloaded (never restarted)" bash -c 'grep -q "^caddy validate" "$1" && grep -q "systemctl reload caddy" "$1" && ! grep -qE "systemctl (restart|stop) caddy" "$1"' _ "$T/calls.first"
check "  ... existing Postgres reused: no postgres package, no restart, only overdrive roles created" bash -c '! grep -qE "postgresql-16|postgresql\.service|restart" "$1" && grep -q "psql CREATE ROLE overdrive$" "$1" && grep -q "psql CREATE ROLE overdrive_api" "$1" && ! grep -q tenant "$1"' _ "$T/calls.first"
check "  ... the other project's role and database were not touched" bash -c '[ "$(cat "$2/dbowner/tenant")" = tenant ] && [ -e "$2/roles/tenant" ] && [ -e "$2/dbs/tenant" ]' _ "$PROV" "$S"
check "  ... no swap added when the box already has swap" bash -c '! grep -qE "^(fallocate|mkswap)" "$1"' _ "$T/calls.first"
check "  ... firewall, ssh, fail2ban, sysctl, apt upgrade are left alone" bash -c '! grep -qE "^ufw|upgrade|fail2ban|sshd|sysctl" "$1"' _ "$T/calls.first"
check "  ... bun and cast already at the pinned versions: nothing downloaded" bash -c '! grep -q "^curl" "$1"' _ "$T/calls.first"
check "  ... units installed under overdrive-* names only" bash -c 'ls "$1/etc/systemd/system" | grep -qx overdrive-api.service && ! ls "$1/etc/systemd/system" | grep -qv "^overdrive"' _ "$PROV"
check "  ... db.env has the two database URLs and is never printed" bash -c 'grep -q "^DATABASE_URL=postgres://overdrive:" "$1/etc/overdrive/db.env" && grep -q "^API_DB_READONLY_URL=postgres://overdrive_api:" "$1/etc/overdrive/db.env" && ! grep -q "postgres://overdrive:" <<<"$2"' _ "$PROV" "$out$out2"
# swap only when there is none
P2="$T/p2"; newprov "$P2"; : >"$S/swap"; PROV="$P2"; out="$(prov)"
check "no swap on the box: a 4G swap file is added (and only then)" bash -c 'grep -q "^fallocate -l 4G" "$1" && grep -q "^mkswap" "$1"' _ "$CALLS"
# a taken port refuses before any change
P3="$T/p3"; newprov "$P3"; echo "LISTEN 0 4096 127.0.0.1:38101 0.0.0.0:*" >"$S/listeners"; PROV="$P3"; out="$(prov)"; rc=$?
check "port 38101 held by another program: refused, nothing created" bash -c '[ "$1" != 0 ] && grep -q "port 38101 is taken" <<<"$2" && ! grep -qE "^(useradd|apt-get|createdb)" "$3" && [ ! -e "$4/etc/overdrive" ]' _ "$rc" "$out" "$CALLS" "$P3"
out="$(prov --preflight)"; rc=$?
check "--preflight is read only and reports the same refusal" bash -c '[ "$1" != 0 ] && grep -q "REFUSED" <<<"$2"' _ "$rc" "$out"
# a database that belongs to someone else, a foreign Postgres, a foreign name
P4="$T/p4"; newprov "$P4"; touch "$S/dbs/overdrive"; echo tenant >"$S/dbowner/overdrive"; PROV="$P4"; out="$(prov)"; rc=$?
check "an existing database named overdrive owned by another role: refused" bash -c '[ "$1" != 0 ] && grep -q "belongs to role" <<<"$2" && ! grep -q "psql CREATE" "$3"' _ "$rc" "$out" "$CALLS"
P5="$T/p5"; newprov "$P5"; rm "$S/pg_up"; echo "LISTEN 0 244 127.0.0.1:5432 0.0.0.0:*" >"$S/listeners"; PROV="$P5"; out="$(prov)"; rc=$?
check "something on 5432 the postgres user cannot reach: refused, never installs a second Postgres" bash -c '[ "$1" != 0 ] && grep -q "listens on port 5432" <<<"$2" && ! grep -q postgresql-16 "$3"' _ "$rc" "$out" "$CALLS"
P6="$T/p6"; newprov "$P6"; PROV="$P6"; out="$(env OD_TEST_ROOT="$P6" PG_MODE=host DB_NAME=tenant_overdrive bash "$PROVISION" 2>&1)"; rc=$?
check "a database name not starting with overdrive is refused" bash -c '[ "$1" != 0 ] && grep -q "not allowed" <<<"$2"' _ "$rc" "$out"
P6b="$T/p6b"; newprov "$P6b"; printf 'api.get-overdrive.com {\n\trespond "x"\n}\n' >"$P6b/etc/caddy/conf.d/other.caddy"; PROV="$P6b"; out="$(prov)"; rc=$?
check "a domain another site already serves is refused" bash -c '[ "$1" != 0 ] && grep -q "already appears" <<<"$2"' _ "$rc" "$out"
# caddy validation fails: file removed, no reload
P7="$T/p7"; newprov "$P7"; touch "$S/caddy-invalid"; PROV="$P7"; out="$(prov)"; rc=$?
check "caddy validate fails: site file removed, Caddy not reloaded, exit nonzero" bash -c '[ "$1" != 0 ] && [ ! -e "$2/etc/caddy/conf.d/overdrive.caddy" ] && ! grep -q "systemctl reload caddy" "$3" && grep -q "not reloaded" <<<"$4"' _ "$rc" "$P7" "$CALLS" "$out"
# main Caddyfile without an import: refused unless the owner asks, then backed up, one line appended, validated, reloaded
P8="$T/p8"; newprov "$P8"; printf 'other.example.org {\n\trespond "x"\n}\n' >"$P8/etc/caddy/Caddyfile"; main8="$(shasum "$P8/etc/caddy/Caddyfile")"; PROV="$P8"; out="$(prov)"; rc=$?
check "main Caddyfile has no conf.d import: stops with a clear message, nothing changed, no reload" bash -c '[ "$1" != 0 ] && [ "$(shasum "$2/etc/caddy/Caddyfile")" = "$3" ] && grep -q "CADDY_ADD_IMPORT=1" <<<"$4" && ! grep -q "systemctl reload caddy" "$5" && [ ! -e "$2/etc/overdrive" ]' _ "$rc" "$P8" "$main8" "$out" "$CALLS"
: >"$CALLS"; out="$(env OD_TEST_ROOT="$P8" PG_MODE=host CADDY_ADD_IMPORT=1 bash "$PROVISION" 2>&1)"
check "CADDY_ADD_IMPORT=1: timestamped backup, exactly one import line appended, validated, reloaded" bash -c 'f="$1/etc/caddy/Caddyfile"; [ "$(grep -c "^import " "$f")" = 1 ] && tail -1 "$f" | grep -qx "import /etc/caddy/conf.d/\*.caddy" && head -3 "$f" | grep -q other.example.org && ls "$1"/etc/caddy/Caddyfile.bak.overdrive-2* >/dev/null && [ "$(shasum < "$(ls "$1"/etc/caddy/Caddyfile.bak.overdrive-2* | head -1)")" = "$(printf "other.example.org {\n\trespond \"x\"\n}\n" | shasum)" ] && grep -q "systemctl reload caddy" "$2" && ! grep -qE "systemctl (restart|stop) caddy" "$2"' _ "$P8" "$CALLS"
: >"$CALLS"; out="$(env OD_TEST_ROOT="$P8" PG_MODE=host CADDY_ADD_IMPORT=1 bash "$PROVISION" 2>&1)"
check "  ... a second run adds no second line and no reload" bash -c '[ "$(grep -c "^import " "$1/etc/caddy/Caddyfile")" = 1 ] && ! grep -q "systemctl reload" "$2"' _ "$P8" "$CALLS"
P8b="$T/p8b"; newprov "$P8b"; printf 'other.example.org {\n\trespond "x"\n}\n' >"$P8b/etc/caddy/Caddyfile"; main8b="$(shasum "$P8b/etc/caddy/Caddyfile")"; touch "$S/caddy-invalid"; : >"$CALLS"
out="$(env OD_TEST_ROOT="$P8b" PG_MODE=host CADDY_ADD_IMPORT=1 bash "$PROVISION" 2>&1)"; rc=$?
check "CADDY_ADD_IMPORT=1 but validate fails: main Caddyfile restored byte for byte, site removed, no reload" bash -c '[ "$1" != 0 ] && [ "$(shasum "$2/etc/caddy/Caddyfile")" = "$3" ] && [ ! -e "$2/etc/caddy/conf.d/overdrive.caddy" ] && ! grep -q "systemctl reload" "$4" && grep -q "not reloaded" <<<"$5"' _ "$rc" "$P8b" "$main8b" "$CALLS" "$out"
check "no script drops a database or role, resets a firewall or edits sshd" bash -c '! grep -nE "DROP (DATABASE|ROLE)|dropdb|dropuser|ufw (reset|default|--force enable)|sshd_config|hidepid|apt-get[^#]*upgrade|systemctl restart (caddy|postgresql|ssh)" "$1"/provision.sh "$1"/deploy.sh "$1"/backup.sh' _ "$HERE"

# ---------------------------------------------------------------- H: backup keeps 14, dumps one database
B="$T/b1"; mkdir -p "$B/etc/overdrive" "$B/var/backups/overdrive"
i=1; while [ "$i" -le 16 ]; do touch "$B/var/backups/overdrive/overdrive-202601$(printf %02d "$i")T030000Z.dump"; i=$((i + 1)); done
out="$(OD_TEST_ROOT="$B" PG_MODE=host bash "$BACKUP" 2>&1)"; rc=$?
check "backup keeps the newest 14 dumps and adds today's" bash -c '[ "$1" = 0 ] && [ "$(ls "$2/var/backups/overdrive" | wc -l | tr -d " ")" = 14 ] && [ ! -e "$2/var/backups/overdrive/overdrive-20260101T030000Z.dump" ]' _ "$rc" "$B"
out="$(OD_TEST_ROOT="$B" DB_NAME=tenant_main bash "$BACKUP" 2>&1)"; rc=$?
check "backup refuses a database that is not Overdrive's" bash -c '[ "$1" != 0 ]' _ "$rc"

# ---------------------------------------------------------------- G2: PG_MODE=docker (the default): Overdrive's own container
# A fake docker: ps lists names only; run creates ONLY overdrive-db-postgres; exec and start accept ONLY overdrive-* names.
# The other project's containers (other-pg on 5432, other-redis on 6379) exist and any touch of them is logged as FOREIGN.
stub docker 'echo "docker $*" >>"'"$CALLS"'"
c="'"$S"'/containers"; mkdir -p "$c"
case "$1" in
  ps) all=0; for a in "$@"; do [ "$a" = -a ] && all=1; done
      for f in "$c"/*; do [ -e "$f" ] || continue; if [ "$all" = 1 ] || grep -qx running "$f"; then basename "$f"; fi; done; exit 0;;
  run) name=""; prev=""; for a in "$@"; do [ "$prev" = --name ] && name="$a"; prev="$a"; done
       case "$name" in overdrive-*) ;; *) echo "FOREIGN docker run $name" >>"'"$CALLS"'"; exit 99;; esac
       [ -e "$c/$name" ] && exit 125
       echo running >"$c/$name"; touch "'"$S"'/pg_up"; mkdir -p "'"$S"'/roles" "'"$S"'/dbs" "'"$S"'/dbowner"; touch "'"$S"'/roles/overdrive" "'"$S"'/dbs/overdrive"; echo overdrive >"'"$S"'/dbowner/overdrive"; echo deadbeef; exit 0;;
  start) case "$2" in overdrive-*) echo running >"$c/$2"; exit 0;; *) echo "FOREIGN docker start $2" >>"'"$CALLS"'"; exit 99;; esac;;
  exec) shift; while [ "${1#-}" != "$1" ]; do shift; done
        case "$1" in overdrive-*) shift; exec "$@";; *) echo "FOREIGN docker exec $1" >>"'"$CALLS"'"; exit 99;; esac;;
  *) echo "FOREIGN docker $*" >>"'"$CALLS"'"; exit 99;;
esac'
newprovd() { # a box with the OTHER project's containers, swap, and Caddy with the import line; no Overdrive container yet
  newprov "$1"; rm -f "$S/pg_up"; rm -rf "$S/roles" "$S/dbs" "$S/dbowner"; mkdir -p "$S/containers"
  echo running >"$S/containers/other-pg"; echo running >"$S/containers/other-redis"
  echo "LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*" >"$S/listeners"; echo "LISTEN 0 4096 127.0.0.1:6379 0.0.0.0:*" >>"$S/listeners"
  : >"$CALLS"
}
provd() { env OD_TEST_ROOT="$PROV" "$@" bash "$PROVISION" 2>&1; }
PD="$T/pd"; newprovd "$PD"; PROV="$PD"
capd="$(shasum "$PD/etc/caddy/Caddyfile" "$PD/etc/caddy/conf.d/tenant.caddy" | shasum)"
out="$(provd)"; rc=$?; cp "$CALLS" "$T/calls.dock1"
check "docker mode (default) first run succeeds" bash -c '[ "$1" = 0 ] || { echo "$2"; exit 1; }' _ "$rc" "$out"
check "  ... exactly one docker run: own name, 127.0.0.1:5433 only, own volume, unless-stopped, 512m, exact image tag" bash -c 'r="$(grep "^docker run" "$1")"; [ "$(grep -c "^docker run" "$1")" = 1 ] && grep -q -- "--name overdrive-db-postgres " <<<"$r" && grep -q -- "-p 127.0.0.1:5433:5432" <<<"$r" && grep -q -- "-v overdrive-pgdata:/var/lib/postgresql/data" <<<"$r" && grep -q -- "--restart unless-stopped" <<<"$r" && grep -q -- "--memory 512m" <<<"$r" && grep -qE " postgres:16\.[0-9]+(-[a-z]+)?( |$)| postgres:16[^ ]*@sha256:" <<<"$r"' _ "$T/calls.dock1"
check "  ... the roles are made inside the container (overdrive_api read-only), the other project's database is untouched" bash -c 'grep -q "^docker exec -i overdrive-db-postgres psql" "$1" && grep -q "psql CREATE ROLE overdrive_api" "$1" && ! grep -q "psql CREATE ROLE overdrive$" "$1" && ! grep -q tenant "$1"' _ "$T/calls.dock1"
check "  ... db.env points at port 5433, is mode 600, and no password is printed or on any command line" bash -c 'grep -q "^DATABASE_URL=postgres://overdrive:[0-9a-f]\{48\}@127.0.0.1:5433/overdrive$" "$1/etc/overdrive/db.env" && [ "$(mode_of "$1/etc/overdrive/db.env")" = 600 ] && pw="$(sed -n "s#^DATABASE_URL=postgres://overdrive:\([^@]*\)@.*#\1#p" "$1/etc/overdrive/db.env")" && ! grep -q "$pw" "$2" && ! grep -q "$pw" <<<"$3"' _ "$PD" "$T/calls.dock1" "$out"
check "  ... provision.conf records PG_MODE=docker (backup and deploy follow it)" grep -q "^PG_MODE=docker" "$PD/etc/overdrive/provision.conf"
check "  ... the other project's Caddy files are unchanged and no new swap was made (swap already existed)" bash -c '[ "$(shasum "$1/etc/caddy/Caddyfile" "$1/etc/caddy/conf.d/tenant.caddy" | shasum)" = "$2" ] && ! grep -qE "^(fallocate|mkswap|swapon)" "$3"' _ "$PD" "$capd" "$T/calls.dock1"
snapd1="$(snapshot "$PD")"; : >"$CALLS"; out2="$(provd)"; rc2=$?; snapd2="$(snapshot "$PD")"
check "docker mode second run: exit 0, no file or mode changed, no docker run, no create or alter" bash -c '[ "$1" = 0 ] && [ "$2" = "$3" ] && ! grep -qE "^docker (run|start)|psql CREATE|psql ALTER|^useradd|^apt-get|systemctl (reload|restart|enable|daemon-reload)" "$4"' _ "$rc2" "$snapd1" "$snapd2" "$CALLS"
check "never calls docker on a non-overdrive name: only ps, and run/start/exec on overdrive-db-postgres" bash -c 'cat "$1" "$2" | grep "docker" | grep -vE "^docker (ps( |$)|run .*--name overdrive-db-postgres |start overdrive-db-postgres|exec (-i )?overdrive-db-postgres )" | grep -c . | grep -qx 0; ! grep -rq "FOREIGN\|other-pg\|other-redis" "$1" "$2"' _ "$T/calls.dock1" "$CALLS"
check "  ... the other containers are still exactly as they were (running, never started or stopped)" bash -c '[ "$(cat "$1/containers/other-pg")" = running ] && [ "$(cat "$1/containers/other-redis")" = running ]' _ "$S"
# 5433 held by something that is not our container
PD2="$T/pd2"; newprovd "$PD2"; echo "LISTEN 0 4096 127.0.0.1:5433 0.0.0.0:*" >>"$S/listeners"; PROV="$PD2"; out="$(provd)"; rc=$?
check "5433 held by something else: refused before any change, no docker run" bash -c '[ "$1" != 0 ] && grep -q "port 5433 is taken" <<<"$2" && ! grep -qE "^docker run|^useradd|^apt-get" "$3" && [ ! -e "$4/etc/overdrive" ]' _ "$rc" "$out" "$CALLS" "$PD2"
out="$(provd PG_PORT=5432)"; rc=$?
check "docker mode refuses any port but 5433 (never the other project's 5432)" bash -c '[ "$1" != 0 ] && grep -q "5433 only" <<<"$2"' _ "$rc" "$out"
# an existing but stopped container is started, never recreated
PD3="$T/pd3"; newprovd "$PD3"; PROV="$PD3"; provd >/dev/null; echo exited >"$S/containers/overdrive-db-postgres"; : >"$CALLS"; out="$(provd)"; rc=$?
check "stopped overdrive container: started (not recreated), still only overdrive names" bash -c '[ "$1" = 0 ] && grep -q "^docker start overdrive-db-postgres" "$2" && ! grep -q "^docker run" "$2"' _ "$rc" "$CALLS"
# no docker at all: refused clearly, host mode unaffected
# The host may have a real docker in /usr/bin (GitHub runners do), so PATH is the stubs plus a copy of /usr/bin and /bin
# made of symlinks that leaves docker out.
mkdir -p "$T/nodocker"; for d in /usr/bin /bin; do for f in "$d"/*; do b="${f##*/}"; case "$b" in docker|docker-*) continue;; esac; [ -x "$f" ] && [ ! -e "$T/nodocker/$b" ] && ln -s "$f" "$T/nodocker/$b"; done; done
PD4="$T/pd4"; newprovd "$PD4"; PROV="$PD4"; mv "$T/bin/docker" "$T/docker.off"; out="$(env OD_TEST_ROOT="$PD4" PATH="$T/bin:$T/nodocker" bash "$PROVISION" 2>&1)"; rc=$?; mv "$T/docker.off" "$T/bin/docker"
check "docker mode without docker installed: refused, nothing changed" bash -c '[ "$1" != 0 ] && grep -q "needs docker" <<<"$2" && [ ! -e "$3/etc/overdrive" ]' _ "$rc" "$out" "$PD4"
# backup in docker mode dumps from the container
B2="$T/b2"; mkdir -p "$B2/etc/overdrive" "$B2/var/backups/overdrive"; : >"$CALLS"
i=1; while [ "$i" -le 16 ]; do touch "$B2/var/backups/overdrive/overdrive-202601$(printf %02d "$i")T030000Z.dump"; i=$((i + 1)); done
out="$(OD_TEST_ROOT="$B2" bash "$BACKUP" 2>&1)"; rc=$?
check "backup (docker mode): docker exec pg_dump on overdrive-db-postgres, still keeps 14" bash -c '[ "$1" = 0 ] && grep -q "^docker exec overdrive-db-postgres pg_dump -U overdrive" "$2" && ! grep -q FOREIGN "$2" && [ "$(ls "$3/var/backups/overdrive" | wc -l | tr -d " ")" = 14 ]' _ "$rc" "$CALLS" "$B2"
B3="$T/b3"; mkdir -p "$B3/etc/overdrive"; echo PG_MODE=host >"$B3/etc/overdrive/provision.conf"; : >"$CALLS"; OD_TEST_ROOT="$B3" bash "$BACKUP" >/dev/null 2>&1
check "backup with PG_MODE=host in provision.conf keeps the host path (no docker)" bash -c '! grep -q "^docker" "$1"' _ "$CALLS"

# ---------------------------------------------------------------- I: env.example matches the code (launch incident)
APP="$HERE/../.."; REPO="$APP/.."
check "env_example_loads_and_job_names_valid: every name is known to the code" bash -c '
  bad=0
  for name in $(grep -oE "^[A-Z][A-Z0-9_]*=" "$1/env.example" | tr -d =); do
    grep -rqw -- "$name" "$2/app/src" "$2/app/python/vol-engine/src" "$2/app/python/risk-sim/src" --include=*.ts --include=*.py 2>/dev/null || { echo "unknown name in env.example: $name"; bad=1; }
  done; exit $bad' _ "$HERE" "$REPO"
BUNBIN="$(command -v bun || echo /opt/homebrew/bin/bun)"
if [ -d "$APP/node_modules" ] && [ -x "$BUNBIN" ]; then
  sed -e 's/^NETWORK=CHANGE_ME/NETWORK=mainnet/' -e 's/^CHAIN_ID=CHANGE_ME/CHAIN_ID=4663/' -e 's#^DEPLOYMENT_FILE=CHANGE_ME#DEPLOYMENT_FILE=deployments/anvil.json#' \
      -e 's/^VOL_ORACLE_ADDRESS=CHANGE_ME/VOL_ORACLE_ADDRESS=0x0000000000000000000000000000000000000001/' "$HERE/env.example" >"$T/env.filled"
  check "  ... loadConfig accepts the filled-in file and every *_ENABLED/DISABLED_JOBS name is in the code's lists" bash -c '
    cd "$1" && set -a && . "$2" && set +a && DATABASE_URL=postgres://u:p@127.0.0.1:5432/d "$3" -e "
      import { loadConfig, CRANK_JOBS, HEDGER_JOBS, LIQUIDATOR_JOBS } from \"./src/config\";
      const c = loadConfig();
      const ok = (v: readonly string[], all: readonly string[]) => v.every((j) => (all as readonly string[]).includes(j));
      if (!ok(c.CRANK_ENABLED_JOBS, CRANK_JOBS) || !ok(c.HEDGER_ENABLED_JOBS, HEDGER_JOBS) || !ok(c.LIQUIDATOR_ENABLED_JOBS, LIQUIDATOR_JOBS)) process.exit(1);
      if (c.API_PORT !== 38101) process.exit(1);
    "' _ "$APP" "$T/env.filled" "$BUNBIN"
else
  echo "skip loadConfig check: app/node_modules or bun missing (run bun install in app/ first)"
fi
check "  ... env.example holds no key, password or token value" bash -c '! grep -E "^[A-Z_]*(PRIVATE_KEY|PASSWORD|SECRET|TOKEN)[A-Z_]*=." "$1/env.example"' _ "$HERE"
check "  ... every Environment= name in the units is a known name" bash -c '
  for name in $(grep -hoE "^Environment=[A-Z_]+" "$1"/systemd/*.service | cut -d= -f2 | sort -u); do
    case "$name" in PYTHON*) continue;; esac
    grep -rqw -- "$name" "$2/app/src" "$2/app/python/vol-engine/src" "$2/app/python/risk-sim/src" || { echo "unknown: $name"; exit 1; }
  done' _ "$HERE" "$REPO"

# ---------------------------------------------------------------- J: units (R14)
U="$HERE/systemd"
unit_ok() { # unit_ok <svc>: the hardening keys R14 asks for
  local f="$U/overdrive-$1.service"
  grep -q '^Restart=on-failure' "$f" && grep -q "^User=overdrive-$1\$" "$f" && grep -q '^ProtectSystem=strict' "$f" && grep -q '^NoNewPrivileges=true' "$f" \
    && [ "$(grep -c '^ReadWritePaths=' "$f")" = 1 ] && grep -q "^ReadWritePaths=/var/lib/overdrive/$1\$" "$f" \
    && grep -q '^MemoryMax=' "$f" && grep -q '^Slice=overdrive.slice' "$f" && grep -q '^ExecStart=/' "$f"
}
for svc in api indexer crank hedger liquidator mcp vol-engine; do check "units_verify_and_hardening_keys_present: overdrive-$svc.service" unit_ok "$svc"; done
for pair in crank:crank hedger:hedger liquidator:liquidator vol-engine:vol-signer; do
  check "  ... ${pair%%:*} waits for its keystore (ConditionPathExists)" grep -q "^ConditionPathExists=/etc/overdrive/keys/${pair##*:}.json" "$U/overdrive-${pair%%:*}.service"
done
check "  ... risk-sim timer is 02:30 UTC and runs the nightly job" bash -c 'grep -q "^OnCalendar=\*-\*-\* 02:30:00 UTC" "$1/overdrive-risk-sim.timer" && grep -q "risk-sim run --nightly" "$1/overdrive-risk-sim.service" && grep -q "^User=overdrive-risk-sim" "$1/overdrive-risk-sim.service"' _ "$U"
check "  ... backup timer is nightly and the script keeps 14 dumps" bash -c 'grep -q "^OnCalendar=\*-\*-\* 03:10:00 UTC" "$1/overdrive-backup.timer" && grep -q "^KEEP=\"\${KEEP:-14}\"" "$2/backup.sh"' _ "$U" "$HERE"
check "  ... the migrate unit is a oneshot that runs the migrator as the overdrive user" bash -c 'grep -q "^Type=oneshot" "$1/overdrive-migrate.service" && grep -q "src/bin/migrate.ts" "$1/overdrive-migrate.service" && grep -q "^User=overdrive$" "$1/overdrive-migrate.service"' _ "$U"
check "  ... the slice caps Overdrive at 1536M and the long-running units fit inside it" bash -c '
  grep -q "^MemoryMax=1536M" "$1/overdrive.slice" || exit 1
  sum=0; for s in api indexer crank hedger liquidator mcp vol-engine; do m="$(sed -n "s/^MemoryMax=\([0-9]*\)M/\1/p" "$1/overdrive-$s.service")"; sum=$((sum + m)); done
  echo "sum of MemoryMax: ${sum}M"; [ "$sum" -le 1536 ]' _ "$U"
check "  ... no unit uses /usr/local, ports are only 38101/38102" bash -c '! grep -rqiE "/usr/local" "$1" && ! grep -rE "[^0-9]3[0-9]{4}[^0-9]" "$1" | grep -vE "3810[12]" | grep -q .' _ "$U"
if command -v systemd-analyze >/dev/null 2>&1; then
  check "  ... systemd-analyze verify is clean" bash -c 'cd "$1" && systemd-analyze verify --man=no ./*.service ./*.timer ./*.target ./*.slice 2>&1 | grep -v "not found\|/opt/overdrive" | grep -q . && exit 1 || exit 0' _ "$U"
else
  echo "skip systemd-analyze verify: not available on this machine (the key checks above ran)"
fi

# ---------------------------------------------------------------- J2: the vol engine's market keys match the deployment
printf '#!/bin/bash\nprintf "%%s|" "$@" "VOL_KEYS=$VOL_KEYS" "SECRET=${OD_SECRET_PROBE:-}" >"%s/vk-args"\nexit 0\n' "$T" >"$T/vk-bin"; printf '#!/bin/bash\nexit 1\n' >"$T/vk-bad"; chmod +x "$T/vk-bin" "$T/vk-bad"
OD_SECRET_PROBE=leak DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; vol_keys_check "$2" "NVDA,NVDA/TSLA" /x/4663.json' _ "$DEPLOY" "$T/vk-bin"; rc=$?
check "vol_keys_check: runs check-keys on the record with VOL_KEYS and nothing else from the environment" \
  bash -c '[ "$1" = 0 ] && [ "$(cat "$2/vk-args")" = "check-keys|/x/4663.json|VOL_KEYS=NVDA,NVDA/TSLA|SECRET=|" ]' _ "$rc" "$T"
DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; vol_keys_check "$2" "" /x/4663.json' _ "$DEPLOY" "$T/vk-bad"; rc=$?
check "  ... and fails when check-keys fails" [ "$rc" == 1 ]
R3="$T/root-volkeys"; mkroot "$R3"
out="$(dep "$R3" "$SHA1" OD_SETTLE=0 OD_PRE_SLEEP=0)"; rc=$?
vk_prev="$(readlink "$R3/opt/overdrive/current")"
sleep 1; stub_vk='mkdir -p app/python/vol-engine/.venv/bin && printf "#!/bin/sh\necho \"vol-engine check-keys: TSLA: engine key 0xab but the deployment reads 0xcd\" >&2\nexit 1\n" >app/python/vol-engine/.venv/bin/vol-engine && chmod +x app/python/vol-engine/.venv/bin/vol-engine'
out="$(dep "$R3" "$SHA2" OD_SETTLE=0 OD_PRE_SLEEP=0 OD_TEST_BUILD_CMD="$stub_vk")"; rc=$?
check "a vol engine key that does not match the deployment stops before the switch (exit 75), current unchanged" \
  bash -c '[ "$1" = 75 ] && grep -q "market keys do not match 4663.json" <<<"$2" && grep -q "TSLA: engine key" <<<"$2" && [ "$(readlink "$3/opt/overdrive/current")" = "$4" ]' _ "$rc" "$out" "$R3" "$vk_prev"
sleep 1; out="$(dep "$R3" "$SHA2" OD_SETTLE=0 OD_PRE_SLEEP=0 OD_TEST_BUILD_CMD="${stub_vk/exit 1/exit 0}")"; rc=$?
check "  ... and a matching one deploys (exit 0)" bash -c '[ "$1" = 0 ] && grep -q "vol keys: every market" <<<"$2"' _ "$rc" "$out"

# ---------------------------------------------------------------- K: nothing ever reached ssh or the real server
check "remote script sets the test-root prefix empty before server_main (real box runs under set -u; 2026-11-16)" bash -c 'out="$(DEPLOY_SH_SOURCE_ONLY=1 bash -c ". \"\$1\"; remote_script" _ "$1/deploy.sh")" && [ "$(printf "%s\n" "$out" | head -1)" = "P=\"\"" ]' _ "$HERE"
check "provision hands the Caddy site logs to the caddy user after validate (fresh box, 2026-11-16)" grep -q 'chown caddy:caddy "\$lf"' "$HERE/provision.sh"
check "every health path the scripts and Caddy probe is a route the API serves (it is /health, not /v1/health; 2026-11-16)" bash -c 'grep -q "path: \"/health\"" "$1/../../src/api/routes/health.ts" && ! grep -rn "v1/health" "$1"/deploy.sh "$1"/Caddyfile "$1/../../src/api/http-cache.ts"' _ "$HERE"
check "no real server address in any script" bash -c '! grep -rnE "88\.216" "$1"/*.sh "$1"/systemd "$1"/Caddyfile "$1"/env.example' _ "$HERE"
check "ssh was never called" bash -c '[ ! -e "$1/ssh-called" ]' _ "$T"

if ((fail)); then printf '%s of %s failed\n' "$fail" "$n"; exit 1; fi
printf 'all %s passed\n' "$n"

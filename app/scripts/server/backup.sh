#!/usr/bin/env bash
# Nightly backup of the Overdrive database only: one pg_dump (custom format) per run in /var/backups/overdrive, the newest
# KEEP dumps kept (default 14). Installed as /usr/local/sbin/overdrive-backup by provision.sh and run as root by
# overdrive-backup.timer. It dumps ONE database (DB_NAME, default overdrive) and touches no other project's data.
# Restore into an empty database with:
#   runuser -u postgres -- pg_restore --clean --if-exists --no-owner --role=overdrive -d overdrive <file>.dump
#
# Env (optional): DB_NAME (default from /etc/overdrive/provision.conf, else overdrive), BACKUP_DIR, KEEP (default 14).
# OD_TEST_ROOT: tests only, refused as root (every path is under it and no root check is made).
# The dumps stay on this server's disk: copy them somewhere else too (README.md, "Backups").
set -euo pipefail

P="${OD_TEST_ROOT:-}"
if [[ -n "$P" && "$(id -u)" == 0 ]]; then echo "backup: OD_TEST_ROOT is for tests and is refused as root" >&2; exit 1; fi
if [[ -r "$P/etc/overdrive/provision.conf" ]]; then
  # shellcheck disable=SC1091
  source "$P/etc/overdrive/provision.conf"
fi
DB_NAME="${DB_NAME:-overdrive}"
BACKUP_DIR="${BACKUP_DIR:-$P/var/backups/overdrive}"
KEEP="${KEEP:-14}"

[[ -n "$P" || "$(id -u)" == 0 ]] || { echo "backup: run as root" >&2; exit 1; }
[[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "backup: DB_NAME must be lowercase letters, digits and _" >&2; exit 1; }
[[ "$DB_NAME" == overdrive* ]] \
  || { echo "backup: refusing to dump $DB_NAME (not an Overdrive database)" >&2; exit 1; }
[[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -ge 1 ]] || { echo "backup: KEEP must be a whole number >= 1" >&2; exit 1; }

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
cd /

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/${DB_NAME}-${stamp}.dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

runuser -u postgres -- pg_dump --format=custom --compress=6 --no-password "$DB_NAME" >"$tmp"
# A dump that pg_restore cannot list is not a backup.
pg_restore --list "$tmp" >/dev/null
mv "$tmp" "$out"
trap - EXIT

# Keep the newest KEEP dumps (names hold the UTC time, so name order is age order); drop old partial files.
n=0
for f in $(ls -1 "$BACKUP_DIR" | grep -E "^${DB_NAME}-[0-9]{8}T[0-9]{6}Z\.dump$" | LC_ALL=C sort -r); do
  n=$((n + 1))
  if [[ "$n" -gt "$KEEP" ]]; then rm -f "$BACKUP_DIR/$f"; echo "backup: removed old dump $f"; fi
done
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-*.dump.partial" -mtime +0 -delete
count="$(ls -1 "$BACKUP_DIR" | grep -cE "^${DB_NAME}-[0-9]{8}T[0-9]{6}Z\.dump$" || true)"
echo "backup: $out ($(du -h "$out" | cut -f1)), $count dump(s) kept in $BACKUP_DIR"

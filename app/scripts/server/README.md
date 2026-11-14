# Server scripts (shared box)

Overdrive runs on one existing server that also hosts other services. These scripts are
written so Overdrive can be installed, updated and removed without touching it. The owner runs them; they are tested here
by `deploy-local.test.sh` against a throwaway fake root with stubbed `systemctl`, `psql`, `caddy` and so on (no ssh, no
network, never the real server).

## What never happens
These scripts never touch any unit, file, user, role or database that is not named overdrive*: units, files, users, roles or databases, and never edit or remove another project's
Caddy site. They do not change the firewall, SSH, fail2ban, sysctl, journald, `/proc`, time sync or system packages (no
`apt upgrade`), do not restart Caddy or Postgres, and install nothing into `/usr/local`. A test greps for each of these.

## What is created (all named overdrive)
| Thing | Name |
|---|---|
| Linux users | `overdrive` (releases, migrations) and `overdrive-api`, `-indexer`, `-crank`, `-hedger`, `-liquidator`, `-vol-engine`, `-mcp`, `-risk-sim` |
| Folders | `/opt/overdrive` (releases, `current`, `bin` with Bun and cast), `/etc/overdrive` (env files, `keys/`), `/var/lib/overdrive/<service>`, `/var/backups/overdrive` |
| Ports (127.0.0.1 only) | api 38101, mcp 38102. Listeners are detected first; a taken port refuses the whole run before any change |
| Postgres | the box's existing server is reused. New role `overdrive`, SELECT-only role `overdrive_api`, database `overdrive`. Installed only if the box has no Postgres at all |
| systemd | `overdrive.slice` (MemoryMax 1536M for everything), `overdrive.target`, `overdrive-{api,indexer,crank,hedger,liquidator,mcp,vol-engine}.service`, `overdrive-migrate.service`, `overdrive-risk-sim.{service,timer}` (02:30 UTC), `overdrive-backup.{service,timer}` (03:10 UTC, 14 dumps) |
| Caddy | one separate file `/etc/caddy/conf.d/overdrive.caddy` for api.get-overdrive.com. `caddy validate` of the whole config must pass or the file is removed and Caddy is not reloaded; reload never restart |
| Swap | a 4G file only if the box has no swap |

Memory: seven long-running units total 1472M of MemoryMax, inside the 1536M slice. The nightly risk-sim (256M) and the
migrate unit run inside the same slice. A deploy build runs in its own 768M scope outside the slice, one build at a time
(a lock), so peak use during a deploy is about 2.2 GB. Do not deploy while the other project is under load.

## Scripts
| Script | What |
|---|---|
| `provision.sh [--preflight\|--units-only\|--service-users]` | prepare the box; second run changes nothing (tested). `--preflight` is read only |
| `deploy.sh --ref <40-hex> <host>` | release a commit, migrate first, restart in order, health-check each, return to the previous release on any failure |
| `deploy.sh --check <host>` | health only, changes nothing |
| `deploy.sh --local ...` | the same on the server itself; needs `OVERDRIVE_ALLOW_REAL_DEPLOY=1` and `OVERDRIVE_ALLOW_FILE` |
| `backup.sh` | `pg_dump` of the overdrive database only; installed as `/opt/overdrive/bin/overdrive-backup` |
| `env.example` | copied to `/etc/overdrive/overdrive.env` on the first run; replace every `CHANGE_ME` |

Order for the owner: `provision.sh --preflight`, then `provision.sh` (set `CADDY_ADD_IMPORT=1` only if the main Caddyfile has
no `import /etc/caddy/conf.d/*.caddy` line and you accept one appended line), fill the env file, copy keystores into
`/etc/overdrive/keys` (crank, hedger, liquidator, vol-signer, and vol-sender when `VOL_SEND=1`), run
`provision.sh --service-users`, then `deploy.sh`. The runbook is `docs/runbooks/server-bringup.md`.

## Roll back
A failed deploy returns by itself. By hand: point `/opt/overdrive/current` at an older healthy release in
`/opt/overdrive/releases` (marked `.healthy`) and `systemctl restart overdrive.target`. Migrations are never reversed by a
rollback; a migration that is not backward compatible needs a forward fix.

## Backups
Dumps stay on this server. Copy them elsewhere too. Restore: `runuser -u postgres -- pg_restore --clean --if-exists
--no-owner --role=overdrive -d overdrive <file>.dump`.

## Remove Overdrive
`systemctl disable --now overdrive.target overdrive-risk-sim.timer overdrive-backup.timer`, delete `/etc/systemd/system/overdrive*`,
`/etc/caddy/conf.d/overdrive.caddy` (then validate and reload Caddy), `/opt/overdrive`, `/etc/overdrive`, and drop only the
`overdrive` database and the `overdrive` and `overdrive_api` roles. Nothing else is Overdrive's.

# Overdrive Backend

Smart contracts and backend services for Overdrive: geared tokens on Robinhood Chain (chain ID `4663`; testnet `46630`). A gear is an ERC-20 whose value follows an underlying price raised to a fixed power (1.5, 2, 3, 0.5 or -1), fully paid in USDG.

Holders are never liquidated. The cost of the gear is a daily toll, applied by shrinking a normalisation factor, so the position can lose value but never owes more than it holds. Backers fund the house book and post collateral in vaults; their vaults, not holders, face liquidation.

Status: in development. Not deployed. Unaudited. Do not rely on it with funds. The security model, privileged roles and known issues are in [SECURITY.md](SECURITY.md); internal review records are in [security/](security/).

## Layout

```
contracts/        Solidity contracts (Foundry): src/<area>/, src/interfaces/, test/ (with test/mocks/), lib/ (vendored)
app/              Bun services: API, indexer, crank, hedger, liquidator, MCP, migrations; deployments/, drizzle/, src/abi/
app/python/       Python services: vol-engine/ (computes sigma per market and signs EIP-712 posts for the vol oracle) and
                  risk-sim/ (nightly stress simulation of the Governor book; recommends caps, holds no keys); .python-version
sdk/              TypeScript client for the API (second deliverable, not yet published)
sdk/mcp/          Agent MCP package (bundles app/src/mcp into one file) and its guide, MCP.md
web/              Website and dashboard (Vite, React, Tailwind): landing page and the Overdrive dashboard, static build
web/exit/         Standalone exit page: one static HTML file (build.mjs, lib.cjs, tests) that works with no website and no API
security/         AUDITS.md (internal review history), coverage and mutation records, post-deploy check output
.githooks/        pre-commit public guard and commit-msg guard
.github/          CI workflows; scripts/ (ci-local.sh, quiet-run.sh, export-abis.sh, formal.sh, coverage, mutation and their tests)
                  .tool-versions: the exact bun, node, python and foundry versions CI pins (checked by check-hygiene.py)
```
The website and dashboard live in `web/` (built by the design team, imported unchanged). The dashboard reads the API through the `/v1/compat` routes.

### Frontend (`web/`)

A Vite, React and Tailwind single-page app: the landing page plus the dashboard views (Dashboard, Markets, Portfolio, Trade, Backers, Governor, Activity, Token). It is static; there is no server code and no secret. Wallet connection is by injected EVM wallet on Robinhood Chain (4663).

All network access goes through one module, `web/src/services/overdrive.ts`, which calls the API's website contract routes, `POST /v1/compat/<procedure>` (`market.list`, `gear.snapshot`, `trade.quote`, `trade.status`, `exit.queueStatus`, `portfolio.positions`, `backer.vaults`, `backer.quoteAction`, `governor.snapshot`, `stake.account`, `stake.quoteAction`, `activity.list`; typed errors with the 14 `ServiceErrorCode` values). A transaction is sent only after the trade ticket shows the quote review, the intent passes `services/allowlist.ts` (known contract, known function) and the wallet is on the right chain; a wrong chain, a rejected signature and an account change are each handled in the ticket.

Public build config (every `VITE_` value ships to the browser, so never a key):

| Variable | Meaning |
| --- | --- |
| `VITE_API_ORIGIN` | API base URL, e.g. `http://127.0.0.1:3101` for the local fork stack |
| `VITE_CHAIN_ID` | Chain the wallet must be on: 4663 (Robinhood Chain) or 31337 (the fork) |

`web/.env.fork` holds the fork values for `npm run dev -- --mode fork`; `app/scripts/fork/up.sh` starts the web service in that mode. `web/tests/fork.test.ts` runs the compat smoke, QUOTE-1 and the wallet flows against a running fork stack when `FORK_API_URL`, `FORK_RPC_URL` and `FORK_DEPLOYMENT` are set (skipped otherwise).

```
cd web && npm ci --ignore-scripts && npx tsc --noEmit && npm run build   # output in web/dist
npm run dev                                                              # local dev server
```

`web/vercel.json` serves `index.html` for `/dashboard` and its query-string views; real assets are served as files. CI and `.github/scripts/ci-local.sh` run the `web` job (install, typecheck, `bun test`, build).

### Contracts (`contracts/src`)

`src/gear/`

| Contract | What it does |
| --- | --- |
| `ODGear` | The ERC-20 of one gear, deployed as a minimal clone |
| `ODGearFactory` | Deploys one `ODGear` clone per gear at a deterministic address |
| `ODGearRegistry` | The one list of gears: underlying, power, unit, cap, spread, status |

`src/governor/`

| Contract | What it does |
| --- | --- |
| `ODMinter` | Buys and sells gear tokens against the house book at value plus or minus a spread; accrues the toll |
| `ODMinterPricing` | The single pricing path of the minter (linked library) |
| `ODGovernor` | The house book: an ERC-4626 vault of USDG owned by backers; carries exposure, the exit reserve and stress rules |
| `ODGovernorRisk` | Per-gear book loops: liability, exposure and open interest |
| `ODInsurance` | USDG pot that only the Governor and the backer contract may draw |

`src/backer/`

| Contract | What it does |
| --- | --- |
| `ODBacker` | Backer vaults: post USDG collateral, mint gear tokens against it, sealed liquidation batches |
| `ODBackerMath` | Pure arithmetic of a backer vault |
| `ODLiquidation` | Sealed-batch liquidation: seal, wait, execute per vault, bonus and bad-debt order (insurance, then stake, then Governor); holders are never touched |
| `ODSaleCredit` | A vault's sale credit: the proceeds of debt sold to the Governor, which never leave the Governor |

`src/hook/`

| Contract | What it does |
| --- | --- |
| `ODHook` | Uniswap v4 hook on each gear/USDG pool; prices every swap through the minter, holds no liquidity |
| `ODHookMiner` | Finds the CREATE2 salt that gives the hook its permission bits |

`src/oracle/`

| Contract | What it does |
| --- | --- |
| `ODOracleGuard` | Every price that moves money passes here; Chainlink primary, fails closed |
| `ODVolOracle` | Annualised volatility per market, posted as EIP-712 messages by the vol signer |
| `ODMarketHours`, `ODCalendar` | Keeper-pushed US equity sessions, with an on-chain fallback calendar |
| `ODTwapReader`, `ODTickPrice` | Uniswap v3 time-weighted price helpers |

`src/fees/`

| Contract | What it does |
| --- | --- |
| `ODFees` | Splits fees between buckets |
| `ODBuyBurn` | Recipient of the burn bucket; spends it on $OVRD through one admin-set route |
| `IODSwapRoute` | The swap route interface `ODBuyBurn` uses (returns the TWAP reference price of a token) |

`src/stake/`

| Contract | What it does |
| --- | --- |
| `ODStake` | Staked $OVRD: slashable first-loss capital behind the Governor |

`src/agent/`

| Contract | What it does |
| --- | --- |
| `ODAgentRouter` | Lets an agent key trade for an owner inside the owner's on-chain policy; no admin, no pause |
| `ODPaymaster` | Gas sponsorship for agent accounts |

`src/math/`

| Contract | What it does |
| --- | --- |
| `ODFixed`, `ODIndex`, `ODNorm`, `ODToll` | Maths: fixed point, the gear index r^p, the normalisation factor, the daily toll rate |

`src/interfaces/`

| Contract | What it does |
| --- | --- |
| `interfaces/` | Every `IOD*` interface, plus `ODRoles`, `ODTypes`, `ODPowers` |

The cores are non-upgradeable. Admin actions go through a 48 hour timelock; the guardian can only pause or reduce risk. Libraries are vendored without git metadata (no submodules); versions and commits are in [contracts/lib/VERSIONS.md](contracts/lib/VERSIONS.md).

### Deployment

Not deployed yet. No addresses are published. This section will list them from `app/deployments/<chain>.json` once the contracts are live.

### Actors and roles

Intended holders at deployment. Nothing is deployed, so no address holds any role yet. The full list of privileged functions, with bounds, is in [SECURITY.md](SECURITY.md).

| Actor | Role | What it can do | Holder |
| --- | --- | --- | --- |
| Holder | none | Buy, sell, queue and cancel a sell, transfer gear tokens | Anyone |
| Backer | none | Open a vault, mint against collateral, repay, withdraw; the only party that can be liquidated | Anyone |
| Liquidity provider | depositor allowlist | Deposit into the Governor, request a withdrawal, claim after the delay | Allowed accounts |
| Staker | none | Stake OVRD for a fee discount and first-loss cover; unstake after a delay | Anyone |
| Executor | none | Seal and execute liquidation batches, poke risk, accrue the toll | Anyone |
| Admin | `DEFAULT_ADMIN_ROLE` (owner for the paymaster) | Every setter, within hard bounds; unpause | Safe 3-of-5 behind a 48 hour timelock |
| Guardian | `GUARDIAN_ROLE` | Pause buys, lower a cap, revoke the vol signer; cannot unpause or raise a limit | Safe 2-of-5 |
| Keeper | `KEEPER_ROLE` | Session windows, move cash into the exit reserve, fee buy-and-burn | Crank key (gas only) |
| Hedger | `HEDGER_ROLE` | Send USDG to the hedger wallet and back; post hedge equity | Hedger key |
| Vol signer | signer address | Sign volatility posts, clamped to per-market bounds | Vol-engine key |
| Paymaster signer | signer address | Sign gas sponsorship for agent accounts | Paymaster signer key |
| Modules | one-time wiring | Minter, backer, hook and fee contract call into the Governor, gear tokens and stake | Contracts |

### Services (`app/src`)

| Service | Entry | What it does |
| --- | --- | --- |
| API | `bin/api.ts` | Read-only REST API (Hono). Reads only from Postgres; builds unsigned intents, sends nothing |
| Indexer | `bin/indexer.ts` | The only process that polls the chain. Writes events and snapshots to Postgres |
| Crank | `bin/crank.ts` | Scheduled jobs that send transactions: `sessions`, `toll`, `poke`, `vol-watch`, `queued-sells`, `fees`, `risk-monitor`, `admin-watch`, `gas-watch`, `pyth-push`, `heartbeat` |
| Hedger | `bin/hedger.ts` | Hedges the Governor's exposure on outside venues; dry run by default; never moves funds off the system |
| Liquidator | `bin/liquidator.ts` | Seals and executes backer liquidation batches; its key holds gas only |
| MCP | `bin/mcp.ts` | MCP server: stdio for an agent host, or hosted read-only over HTTP |
| Migrate | `bin/migrate.ts` | Applies Drizzle migrations from `app/drizzle` |
| Telegram bot | `bin/telegram-bot.ts` | Team bot: answers read-only commands in the ops chat; holds no chain key and no database access, reads the local API only |

Other folders: `abi/` (contract ABIs), `chain/` (RPC pool, clients, deployment loader), `db/` (schema and queries), `pricing/`, `lib/` (helpers), `config/` (vol and earnings data), `config.ts` (all environment variables).

Python services (`app/python`, each with its own README and hash-pinned lock files): `vol-engine` computes sigma per market and signs EIP-712 posts for the vol oracle (the vol signer key); `risk-sim` runs the nightly stress simulation of the Governor book, recommends caps and holds no keys.

## Requirements

- [Bun](https://bun.sh) 1.4+
- [Foundry](https://getfoundry.sh) (solc version is set in `contracts/foundry.toml`)
- Postgres 16
- Python 3.11+ for `app/python/vol-engine/` and `app/python/risk-sim/`; install them only from their lock files with `pip install --require-hashes --no-deps -r requirements-dev.lock` (see each README)

## Contracts

```sh
cd contracts
forge build
forge test
```

## Deploy

Everything here is a script in this repository; nothing is deployed yet and no address is published (see Deployment above). Steps marked **owner** are run by the project owner only: they sign, spend or need an account. No agent broadcasts.

**Contracts** (`contracts/script`, driven by `app/scripts/deploy-{fork,testnet,mainnet}.sh`)

1. Fill `contracts/script/config/<network>.json` (`mainnet`, `testnet`; `fork` and `anvil` are for local runs). The config refuses placeholder addresses, and `hookSeed.approvedByOwner` must be true on mainnet. **owner**
2. Dry run on a local fork first: `anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8547`, then `OD_DEPLOYER=<address> ANVIL_URL=http://127.0.0.1:8547 bash app/scripts/deploy-fork.sh`. Every stage is skipped if already done, so a rerun is safe.
3. Arm the real run: `OVERDRIVE_ALLOW_REAL_DEPLOY=1` and `OVERDRIVE_ALLOW_FILE=<a file the owner creates>`. Without both, `ODScript._guardRealBroadcast` reverts on chains 4663 and 46630. The signing key is a Foundry keystore account (`overdrive-deployer` by default, `OD_ACCOUNT` to change); no key is ever passed on a command line. **owner**
4. Run `bash app/scripts/deploy-testnet.sh` (46630) or `bash app/scripts/deploy-mainnet.sh` (4663). Mainnet first repeats the whole deploy on a local fork at the deployer's real nonce and runs `PostDeployCheck` on it, then asks you to type the chain id. **owner**
5. The scripts run these stages in order: `DeploySystem.s.sol` (deploys the cores, wires the once-only setters (minter, backer, hook, stake, coverers, notifiers) exactly once each, hands every admin role to the 48 hour timelock, with the Safe 3-of-5 as proposer, renounces the deployer's roles, gives the guardian role to the guardian Safe and writes the deployments json; it seeds nothing), `TimelockHandoff.s.sol` (idempotent; finishes a handoff that stopped), `PostDeployCheck.s.sol` (read only: chain, code present, wiring, roles, the 48 hour delay, hook address bits, pool initialisation; writes `security/post-deploy-<network>.txt` and reverts on any failure), then `ListGears.s.sol` (writes the Safe batch `.batches/<network>-list-gears.json`; it never executes).
6. Schedule and execute the list-gears batch from the owner Safe (3-of-5), through the timelock. **owner**
7. Seed each pool as set out in SECURITY.md (known residual L-7). **owner**
8. Verify the deployed bytecode against this checkout's build: `bash contracts/script/verify-deployment.sh <mainnet|testnet> [rpc-url]` (PASS or FAIL per contract). `MineHookSalt.s.sol` is a view-only helper that prints the hook salt for a deployer.

**Record.** The scripts write `app/deployments/mainnet.json` or `app/deployments/testnet.json` (local and fork runs write `app/deployments/local/`, git-ignored; `app/deployments/anvil.json` is the committed local record). The services and the SDK read addresses only from it. Commit the file, then run `python3 .github/scripts/readme-deployments.py` to regenerate the Deployment section above and `cd sdk && bun run generate` to regenerate the SDK address table. CI fails if either is out of date, so this README cannot disagree with the files.

**Servers** (`app/scripts/server`, one shared box, only `overdrive*` things are touched; see its [README](app/scripts/server/README.md))

1. `deploy.sh --provision --preflight <host>` (read only), then `deploy.sh --provision <host>`; fill `/etc/overdrive/overdrive.env` and copy the keystores into `/etc/overdrive/keys`; run `provision.sh --service-users`. **owner**
2. `deploy.sh --ref <40-hex sha> <host>` releases a commit: it migrates first, restarts in order, health-checks each service and returns to the previous release on any failure. **owner**
3. `deploy.sh --check <host>` health-checks without changing anything. Rollback is described in the server README.

## Services

```sh
cd app
bun install
bun run migrate
bun run indexer
bun run crank
bun run api
```

The hedger, liquidator and MCP server start with `bun run src/bin/hedger.ts`, `bun run src/bin/liquidator.ts` and `bun run src/bin/mcp.ts`.

### Configuration

All config comes from environment variables and is checked at startup (`app/src/config.ts`). Signing keys are read separately (`app/src/keys.ts`), one distinct key per role.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `NETWORK` | `fork` | `mainnet` (4663), `testnet` (46630) or `fork` (31337); `CHAIN_ID` must match |
| `CHAIN_ID` | from `NETWORK` | Optional; must match `NETWORK` when set |
| `DATABASE_URL` | none | Required. Postgres connection string |
| `PUBLIC_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | Public RPC endpoint |
| `RPC_URL_OVERRIDE` | empty | Single endpoint for forks and tests; refused on mainnet |
| `RPC_BACKUP_URL` | see notes | Backup endpoint tried only after every main endpoint failed; defaults to a keyless public one on mainnet |
| `ALCHEMY_API_KEYS` | empty | Comma-separated keys; empty means public RPC only |
| `ALCHEMY_URL_TEMPLATE` | `https://robinhood-mainnet.g.alchemy.com/v2/{key}` | Must contain `{key}` |
| `RPC_ROUTE_LOGS` | `public,alchemy` | Order of endpoints for log reads (`public`, `alchemy`) |
| `RPC_ROUTE_STATE` | `public,alchemy` | Order of endpoints for state reads |
| `RPC_ROUTE_TX` | `alchemy,public` | Order of endpoints for transactions |
| `DEPLOYMENT_FILE` | `deployments/anvil.json` | Deployment file, see below |
| `INDEXER_POLL_ACTIVE_MS` | `5000` | Poll interval while events are arriving |
| `INDEXER_POLL_BASE_MS` | `15000` | Normal poll interval |
| `INDEXER_POLL_IDLE_MS` | `60000` | Poll interval when quiet |
| `INDEXER_CATCHUP_CONCURRENCY` | `3` | 1 to 6 parallel log ranges while catching up |
| `INDEXER_CONFIRMATIONS` | 0 fork, 2 otherwise | Blocks behind head; 0 on fork, 2 otherwise |
| `INDEXER_SNAPSHOT_HEARTBEAT_MS` | `600000` | Maximum gap between snapshots (5 s to 10 min) |
| `CRANK_ENABLED_JOBS` | all jobs | Comma-separated crank jobs; all by default |
| `CRANK_DISABLED_JOBS` | none | Jobs removed from the enabled list |
| `HEDGER_ENABLED_JOBS` | all jobs | Comma-separated hedger jobs; all by default |
| `HEDGER_DISABLED_JOBS` | none | Jobs removed from the enabled list |
| `LIQUIDATOR_ENABLED_JOBS` | all jobs | Comma-separated liquidator jobs; all by default |
| `LIQUIDATOR_DISABLED_JOBS` | none | Jobs removed from the enabled list |
| `CRANK_DRY_RUN` | `0` | `1` simulates every job and sends nothing |
| `CRANK_AUTOPAUSE` | `0` | `1` lets the risk monitor send the guardian pause when the indexed tables and the contract agree; the crank key must hold the guardian role |
| `CRANK_GAS_MULTIPLIER_BPS` | `15000` | Gas price multiplier in bps (12000 to 100000) |
| `CRANK_GAS_HEADROOM` | `500000` | Extra gas added to estimates |
| `CRANK_GAS_CAP` | `32000000` | Per-transaction gas cap |
| `CRANK_TOLL_MAX_AGE_SECONDS` | `3600` | Oldest allowed toll accrual before the crank settles it |
| `CRANK_TOLL_BATCH` | `40` | Gears per toll batch |
| `CRANK_TOLL_BATCH_MAX` | `45` | Upper bound for the batch size |
| `CRANK_TOLL_GAS_TARGET` | `8000000` | Gas target per toll batch |
| `CRANK_QUEUE_MAX_PER_PASS` | `25` | Queued sells processed per pass |
| `CRANK_QUEUE_RETRY_MS` | `600000` | Wait before retrying a queued sell |
| `VOL_STALE_WARN_SECONDS` | `900` | Warn when the vol oracle is older than this |
| `FEES_MIN_USDG` | `50` | Smallest fee balance the crank distributes |
| `PYTH_HERMES_URL` | `https://hermes.pyth.network` | Hermes base URL the `pyth-push` job fetches signed price updates from |
| `PYTH_HERMES_API_KEY` | empty | Hermes API key. Empty = the `pyth-push` job pushes nothing and logs a warning (Pyth-referenced markets then go stale); its reference health check and critical alert still run. Set it in the crank env file (`/etc/overdrive/crank.env`), never in git |
| `PYTH_HERMES_AUTH_HEADER` | `x-api-key` | Header that carries the key (never sent in the URL). Pyth Terminal keys use `Authorization`, sent as `Bearer <key>` |
| `PYTH_PUSH_INTERVAL_SECONDS` | `45` | How often the job runs (10 to 3600); keep it below the smallest `refMaxAge` (120 s on mainnet) |
| `PYTH_PUSH_FRESH_PERCENT` | `50` | Skip a push while the on-chain print is younger than this share of the market's `refMaxAge` (read from the guard per market) |
| `PYTH_PUSH_MAX_RETRIES` | `3` | Retries of the Hermes and fee reads, with doubling backoff |
| `PYTH_PUSH_BACKOFF_MS` | `1000` | First retry wait |
| `PYTH_PUSH_DAILY_BUDGET_ETH` | `0.02` | Update fees plus gas the job may spend per UTC day; at the limit it stops and raises a critical alert |
| `GAS_WATCH_MIN_ETH_CRANK` | `0.01` | Alert below this ETH balance (crank wallet) |
| `GAS_WATCH_MIN_ETH_HEDGER` | `0.01` | Alert below this ETH balance (hedger wallet) |
| `GAS_WATCH_MIN_ETH_LIQUIDATOR` | `0.01` | Alert below this ETH balance (liquidator wallet) |
| `GAS_WATCH_MIN_ETH_VOL_SIGNER` | `0.001` | Alert below this ETH balance (vol signer) |
| `GAS_WATCH_MIN_ETH_VOL_SENDER` | `0.01` | Alert below this ETH balance (vol sender) |
| `GAS_WATCH_REALERT_HOURS` | `6` | Hours between repeat alerts |
| `TELEGRAM_ENV_FILE` | empty | Path of an env file holding the alert bot settings; empty disables alerts |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Bot API base; only the real endpoint or a local test server is accepted |
| `LOG_LEVEL` | `info` | pino level |
| `EXPECT_ADDRESS` | empty | If set, a service refuses to start under a different signing address |
| `API_PORT` | `3101` | API listen port |
| `CORS_ORIGINS` | empty | Comma-separated allowed origins; empty allows none |
| `API_RATE_LIMIT_PER_MINUTE` | `300` | Per client, reads (0 disables) |
| `API_WRITE_RATE_LIMIT_PER_MINUTE` | `30` | Per client, intent routes |
| `API_CLIENT_IP_HEADER` | `cf-connecting-ip` | Header carrying the client address behind the proxy |
| `API_QUOTE_CACHE_MS` | `2000` | Quote cache lifetime |
| `API_QUOTE_MAX_RPC_PER_REQUEST` | `3` | RPC calls one quote request may make |
| `API_DB_READONLY_URL` | empty | SELECT-only Postgres role for the API; falls back to `DATABASE_URL` |
| `QUOTER_ADDRESS` | empty | Quoter contract address; empty uses the deployment file |
| `API_QUOTER` | `chain` | `chain` or `mock` (mock only on the fork network) |

Never commit `.env` files or keys; they are ignored by `.gitignore`.

### Pyth push (operator steps)

Markets reference Pyth, and nothing on chain 4663 keeps Pyth fresh by itself. The crank job `pyth-push` does: every
`PYTH_PUSH_INTERVAL_SECONDS` it reads each Pyth market's `refMaxAge` from the oracle guard, skips the push while the on-chain
print is fresh enough or Hermes holds nothing newer, and otherwise calls `getUpdateFee` then `updatePriceFeeds` with exactly that fee.
Without `PYTH_HERMES_API_KEY` it pushes nothing and warns; the reference health check and its critical alert still run on every pass. Steps: (1) get a Hermes API key from the Hermes provider; (2) put it in
`/etc/overdrive/crank.env` as `PYTH_HERMES_API_KEY` (mode 0440); (3) fund the crank wallet (the fee and gas come from it; `gas-watch`
alerts when it is low); (4) restart the crank, run once with `CRANK_DRY_RUN=1` and check the log line "Pyth prices pushed" shows
`dryRun: true`, then arm. Check `GET /v1/status`: `oracle.ok` is true and every market shows `source` `pyth` or `twap`. A market with
no usable reference raises a critical alert (`pyth-ref:<symbol>`) until it recovers.

### Deployment file

The services read `DEPLOYMENT_FILE` (default `deployments/anvil.json`). The committed record for a chain is `app/deployments/<chain>.json` (contract addresses, start block, markets and gears); its schema is `app/deployments/schema.json`. The SDK generates its address table from the same file.

## API

All routes except `/health` are versioned under `/v1`. The OpenAPI spec is at `/openapi.json` (and committed as `sdk/openapi.json`); human docs at `/docs`.

| Route | |
| --- | --- |
| `GET /health` | Liveness |
| `GET /v1/status` | Indexer lag, service heartbeats and pauses |
| `GET /v1/config` | Addresses and gears from the deployment file |
| `GET /v1/gears` | All gears with price, daily toll, spread, cap and sell mode |
| `GET /v1/gears/{id}` | One gear by symbol or id |
| `GET /v1/gears/{id}/history` | Normalisation factor, value per token and toll series |
| `GET /v1/tolls` | The daily toll of every gear, now |
| `GET /v1/tolls/formula` | The published toll formula and its constants |
| `GET /v1/quote` | Exact quote: what executes is what is quoted |
| `POST /v1/intent/buy` | Unsigned buy transaction from a fresh quote |
| `POST /v1/intent/sell` | Unsigned sell transaction from a fresh quote |
| `GET /v1/governor` | Equity, exposure per underlying, hedge residual, exit reserve, stress |
| `GET /v1/governor/history` | Rows of the Governor ledger |
| `GET /v1/exit` | Exit reserve, floor, coverage and queue |
| `GET /v1/backers/{address}` | A backer's vaults with health against maintenance |
| `GET /v1/vaults/{id}` | One vault |
| `GET /v1/account/{address}` | Balances per gear with value, cost basis, toll paid and queued sells |
| `GET /v1/fees` | Fee splits as read from chain, and fee totals |
| `GET /v1/risk` | Latest risk-sim run and cap plan, with its age |
| `GET /v1/hedges` | Recent hedge positions from the Governor ledger |
| `POST /v1/compat/{procedure}` | The website contract (12 procedures, typed `ServiceErrorCode` errors) over the routes above |

## Checks

```sh
cd app
bun run typecheck
bun test
```

The protocol invariants and the tests that check them are listed in [contracts/INVARIANTS.md](contracts/INVARIANTS.md).

**Coverage.** `bash .github/scripts/coverage.sh` runs `forge coverage --ir-minimum` over the hermetic suite (no fork RPC) and writes `contracts/coverage/lcov.info` and `contracts/coverage/summary.md` (not committed). Measured 2026-11-15 at 16acffc, contracts/src: lines 95.67% (3159/3302), branches 83.31% (998/1198), functions 95.78% (454/474). ODGovernor 96.82% lines, 78.45% branches; ODBacker 96.61%, 74.80%; ODMinter 95.22%, 72.97%; ODOracleGuard 95.61%, 86.01%. Left out of the coverage run only: the stateful system invariant suite (its handler, test/invariant/SystemHandler.sol, is stack too deep under `--ir-minimum`) and the gas ceiling tests, named `..._GasBound` (five tests: the instrumented, unoptimised build uses more gas than the ceilings they assert). All of them still run in `forge test`. No file in contracts/src is excluded. Under `--ir-minimum` source maps are approximate.

The whole suite (contracts, app, guard, scripts), the same jobs as the CI workflow:

```sh
bash .github/scripts/ci-local.sh                       # every job
bash .github/scripts/ci-local.sh --only app,sdk,guard  # some jobs
```

Jobs: hygiene, semgrep, contracts, app, guard, scripts, python, web, sdk, slither.

**The push gate.** GitHub Actions skips every job on the private repository, so `.github/scripts/ci-local.sh` is its CI. A run in which every job passed, on a clean tree, writes a stamp `.ci-local/green/<sha>.json` (commit, tree hash, job list, UTC time, tool versions). The `.githooks/pre-push` hook (enabled by `git config core.hooksPath .githooks`) refuses a push whose head commit has no stamp for its exact tree listing every job (hygiene, semgrep, contracts, app, guard, scripts, python, web, sdk, slither). The stamp records the jobs that ran and `"scope": "full"` or `"subset"`; a stamp from an `--only` run does not open the gate. `OD_REQUIRED_JOBS` replaces the required set, and a set that drops a job is logged to `.ci-local/overrides.log`. The emergency override is `OD_SKIP_CI_GATE="<reason>" git push`; the reason is appended to `.ci-local/overrides.log`. `bash .github/scripts/pre-push.test.sh` proves the hook in a temporary repository. The public repository runs the same jobs in GitHub Actions (`.github/workflows/ci.yml`), with two differences: the word denylist is private, so the public copy skips the guard's two denylist steps (this gate ran them before the copy was published), and the contracts job is split so that each part fits a free runner (one job for the checks and the src build, plus the test suites in six parallel shards listed in `contracts/script/ci/test-shards.py`, every suite in exactly one), and those jobs run only when a push changes `contracts/` or the workflow (pull requests and manual runs always run them).

## License

[MIT](LICENSE)

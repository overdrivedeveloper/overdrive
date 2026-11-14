# Overdrive Backend

Smart contracts and backend services for Overdrive: geared tokens on Robinhood Chain (chain ID `4663`). A gear is an ERC-20 whose value follows an underlying price raised to a fixed power (1.5, 2, 3, 0.5 or -1), fully paid in USDG.

Holders are never liquidated. The cost of the gear is a daily toll, applied by shrinking a normalisation factor, so the position can lose value but never owes more than it holds. Backers fund the house book and post collateral in vaults; their vaults, not holders, face liquidation.

Status: in development. Not deployed. Unaudited. Do not rely on it with funds.

## Layout

```
contracts/    Solidity contracts (Foundry): src/<area>/, src/interfaces/, test/ (with test/mocks/), lib/ (vendored)
app/          Bun services: API, indexer, crank, hedger, liquidator, MCP, migrations; deployments/, drizzle/, src/abi/
sdk/          TypeScript client for the API (second deliverable, not yet published)
mcp/          Agent MCP package (bundles app/src/mcp into one file) and its guide, MCP.md
vol-engine/   Python volatility engine: computes sigma per market and signs EIP-712 posts for the vol oracle
risk-sim/     Python nightly stress simulation of the Governor book; recommends caps, holds no keys
exit/         Standalone exit page: one static HTML file (build.mjs, lib.cjs, tests) that works with no website and no API
scripts/      CI and tooling: ci-local.sh, quiet-run.sh, export-abis.sh and their tests
.githooks/    pre-commit public guard and commit-msg guard
.github/      CI workflow and SECURITY.md
```

The front end is built by another team and lives outside this repository. It talks to the API through `sdk/`.

### Contracts (`contracts/src`)

| Contract | What it does |
| --- | --- |
| `ODGear` | The ERC-20 of one gear, deployed as a minimal clone |
| `ODGearFactory` | Deploys one `ODGear` clone per gear at a deterministic address |
| `ODGearRegistry` | The one list of gears: underlying, power, unit, cap, spread, status |
| `ODMinter` | Buys and sells gear tokens against the house book at value plus or minus a spread; accrues the toll |
| `ODMinterPricing` | The single pricing path of the minter (linked library) |
| `ODGovernor` | The house book: an ERC-4626 vault of USDG owned by backers; carries exposure, the exit reserve and stress rules |
| `ODGovernorRisk` | Per-gear book loops: liability, exposure and open interest |
| `ODInsurance` | USDG pot that only the Governor and the backer contract may draw |
| `ODBacker` | Backer vaults: post USDG collateral, mint gear tokens against it, sealed liquidation batches |
| `ODBackerMath` | Pure arithmetic of a backer vault |
| `ODLiquidation` | Sealed-batch liquidation: seal, wait, execute per vault, bonus and bad-debt order (insurance, then stake, then Governor); holders are never touched |
| `ODHook` | Uniswap v4 hook on each gear/USDG pool; prices every swap through the minter, holds no liquidity |
| `ODHookMiner` | Finds the CREATE2 salt that gives the hook its permission bits |
| `ODOracleGuard` | Every price that moves money passes here; Chainlink primary, fails closed |
| `ODVolOracle` | Annualised volatility per market, posted as EIP-712 messages by the vol signer |
| `ODMarketHours`, `ODCalendar` | Keeper-pushed US equity sessions, with an on-chain fallback calendar |
| `ODTwapReader`, `ODTickPrice` | Uniswap v3 time-weighted price helpers |
| `ODFees` | Splits fees between buckets |
| `ODBuyBurn` | Recipient of the burn bucket; spends it on $OVRD through one admin-set route |
| `ODStake` | Staked $OVRD: slashable first-loss capital behind the Governor |
| `ODAgentRouter` | Lets an agent key trade for an owner inside the owner's on-chain policy; no admin, no pause |
| `ODPaymaster` | Gas sponsorship for agent accounts |
| `ODFixed`, `ODIndex`, `ODNorm`, `ODToll` | Maths: fixed point, the gear index r^p, the normalisation factor, the daily toll rate |
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
| Crank | `bin/crank.ts` | Scheduled jobs that send transactions: `sessions`, `toll`, `poke`, `vol-watch`, `queued-sells`, `fees`, `risk-monitor`, `admin-watch`, `gas-watch`, `heartbeat` |
| Hedger | `bin/hedger.ts` | Hedges the Governor's exposure on outside venues; dry run by default; never moves funds off the system |
| Liquidator | `bin/liquidator.ts` | Seals and executes backer liquidation batches; its key holds gas only |
| MCP | `bin/mcp.ts` | MCP server: stdio for an agent host, or hosted read-only over HTTP |
| Migrate | `bin/migrate.ts` | Applies Drizzle migrations from `app/drizzle` |

Other folders: `abi/` (contract ABIs), `chain/` (RPC pool, clients, deployment loader), `db/` (schema and queries), `pricing/`, `lib/` (helpers), `config/` (vol and earnings data), `config.ts` (all environment variables).

## Requirements

- [Bun](https://bun.sh) 1.4+
- [Foundry](https://getfoundry.sh) (solc version is set in `contracts/foundry.toml`)
- Postgres 16
- Python 3.11+ for `vol-engine/` and `risk-sim/`; install them only from their lock files with `pip install --require-hashes --no-deps -r requirements-dev.lock` (see each README)

## Contracts

```sh
cd contracts
forge build
forge test
```

## Deploy

Deploy scripts arrive with todo 11. Until then there is no deploy command in this repository and no address is published. The planned order, taken from the todo, is:

1. Run the deploy script against a fork or local node first; a mainnet broadcast needs an explicit owner approval and an armed flag.
2. Deploy the cores with their constructor arguments, mining the hook salt for the real deployer.
3. Wire the once-only setters (minter, backer, hook, stake, coverers, notifiers) exactly once each.
4. List the launch gears and initialise their pools; seed each pool as set out in SECURITY.md (known residual L-7).
5. Hand every admin role to the timelock, with the Safe 3-of-5 as proposer, and renounce the deployer's roles; set the guardian Safe 2-of-5.
6. Run the read-only post-deploy check: chain, code present, wiring, roles, the 48 hour delay, hook address bits, pool initialisation.
7. Verify the deployed bytecode against the local build and write `app/deployments/<chain>.json`; the services and the SDK read addresses only from it.

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
| `API_QUOTE_MAX_RPC_PER_REQUEST` | `2` | RPC calls one quote request may make |
| `API_DB_READONLY_URL` | empty | SELECT-only Postgres role for the API; falls back to `DATABASE_URL` |
| `QUOTER_ADDRESS` | empty | Quoter contract address; empty uses the deployment file |
| `API_QUOTER` | `chain` | `chain` or `mock` (mock only on the fork network) |

Never commit `.env` files or keys; they are ignored by `.gitignore`.

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

## Checks

```sh
cd app
bun run typecheck
bun test
```

The protocol invariants and the tests that check them are listed in [contracts/INVARIANTS.md](contracts/INVARIANTS.md).

The whole suite (contracts, app, guard, scripts), the same jobs as the CI workflow:

```sh
bash scripts/ci-local.sh
```

## License

[MIT](LICENSE)

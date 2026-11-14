// Typed view of drizzle/0000_base.sql and 0001_indexer.sql (the SQL files are the source of truth and are hand written; this
// file is what services import). On-chain addresses are lowercase hex. Amounts are raw integers kept as strings:
// USDG 6 dp, NF / index / token amounts WAD (1e18).
import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

const int78 = (name: string) => numeric(name, { precision: 78, scale: 0 });
const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const blk = (name = "block") => bigint(name, { mode: "bigint" });

export const gears = pgTable("gears", {
  id: text("id").primaryKey(),
  marketA: text("market_a").notNull(),
  marketB: text("market_b"),
  underlying: text("underlying").notNull(),
  underlyingB: text("underlying_b"),
  power: numeric("power").notNull(),
  powerWad: int78("power_wad").notNull(),
  token: text("token").notNull().unique(),
  capUsd: int78("cap_usd").notNull(),
  spreadBps: integer("spread_bps").notNull(),
  status: text("status", { enum: ["active", "paused", "retired"] }).notNull(),
  nf: int78("nf").notNull().default("1000000000000000000"),
  lastAccrual: at("last_accrual"),
  listedBlock: blk("listed_block"),
  listedAt: at("listed_at"),
});

export const nfHistory = pgTable("nf_history", {
  gear: text("gear").notNull(), ts: at("ts").notNull(), block: blk(), txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(),
  nf: int78("nf").notNull(), toll: int78("toll").notNull(), tollValueUsdWad: int78("toll_value_usd_wad"),
  sigmaHat: int78("sigma_hat"), usage: int78("usage"), session: text("session"),
}, (t) => [primaryKey({ columns: [t.gear, t.ts, t.txHash, t.logIndex] })]);

export const backerVaults = pgTable("backer_vaults", {
  id: int78("id").primaryKey(), owner: text("owner").notNull(), gear: text("gear").notNull(),
  collateral: int78("collateral").notNull(), debtTokens: int78("debt_tokens").notNull(), health: int78("health"),
  status: text("status", { enum: ["open", "liquidating", "closed"] }).notNull(), openedBlock: blk("opened_block"), updatedBlock: blk("updated_block"),
});

export const governorLedger = pgTable("governor_ledger", {
  ts: at("ts").notNull(), underlying: text("underlying").notNull(), delta: int78("delta").notNull(), gamma: int78("gamma").notNull(),
  hedgeDelta: int78("hedge_delta").notNull(), equity: int78("equity").notNull(), exitReserve: int78("exit_reserve").notNull(), block: blk(),
}, (t) => [primaryKey({ columns: [t.ts, t.underlying] })]);

export const fees = pgTable("fees", {
  ts: at("ts").notNull(), gear: text("gear"), kind: text("kind").notNull(), amount: int78("amount").notNull(), block: blk(),
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const serviceStatus = pgTable("service_status", {
  job: text("job").primaryKey(), lastRun: at("last_run"), lastOk: at("last_ok"), lastError: text("last_error"), lastTx: text("last_tx"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
});

export const jobs = pgTable("jobs", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), kind: text("kind").notNull(), dedupeKey: text("dedupe_key").notNull(),
  payload: jsonb("payload").notNull().default({}), runAt: at("run_at").notNull().defaultNow(),
  status: text("status", { enum: ["queued", "running", "done", "failed", "dead"] }).notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0), maxAttempts: integer("max_attempts").notNull().default(8),
  lockedBy: text("locked_by"), lockedUntil: at("locked_until"), lastError: text("last_error"), result: jsonb("result"), createdAt: at("created_at").defaultNow(),
});

export const jobSchedule = pgTable("job_schedule", {
  name: text("name").primaryKey(), everyMs: integer("every_ms").notNull(), nextRunAt: at("next_run_at").notNull(), enabled: boolean("enabled").notNull().default(true),
});


export const trades = pgTable("trades", {
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), block: blk().notNull(), ts: at("ts").notNull(),
  gear: text("gear").notNull(), account: text("account").notNull(), recipient: text("recipient"), side: text("side", { enum: ["buy", "sell"] }).notNull(),
  tokens: int78("tokens").notNull(), usdg: int78("usdg").notNull(), valuePerToken: int78("value_per_token"), spreadBps: integer("spread_bps"),
  session: text("session"), via: text("via", { enum: ["hook", "minter", "queue"] }).notNull(),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const transfers = pgTable("transfers", {
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), block: blk().notNull(), ts: at("ts").notNull(),
  token: text("token").notNull(), fromAddr: text("from_addr").notNull(), toAddr: text("to_addr").notNull(), amount: int78("amount").notNull(),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const balances = pgTable("balances", {
  token: text("token").notNull(), account: text("account").notNull(), balance: int78("balance").notNull(),
}, (t) => [primaryKey({ columns: [t.token, t.account] })]);

export const prices = pgTable("prices", {
  underlying: text("underlying").notNull(), ts: at("ts").notNull(), block: blk(), priceWad: int78("price_wad").notNull(), session: text("session"),
  fresh: boolean("fresh").notNull().default(true), source: text("source"), multiplierWad: int78("multiplier_wad"),
}, (t) => [primaryKey({ columns: [t.underlying, t.ts] })]);

export const volPosts = pgTable("vol_posts", {
  gearOrUnderlying: text("gear_or_underlying").notNull(), ts: at("ts").notNull(), block: blk().notNull(), txHash: text("tx_hash").notNull(),
  logIndex: integer("log_index").notNull(), sigmaBps: int78("sigma_bps").notNull(), validUntil: at("valid_until"), signer: text("signer"),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const queuedSells = pgTable("queued_sells", {
  ticket: int78("ticket").primaryKey(), gear: text("gear").notNull(), account: text("account").notNull(), tokens: int78("tokens").notNull(),
  minProceeds: int78("min_proceeds").notNull(), queuedBlock: blk("queued_block").notNull(), queuedAt: at("queued_at").notNull(),
  status: text("status", { enum: ["open", "filled", "cancelled"] }).notNull(), filledBlock: blk("filled_block"),
});

export const liquidationBatches = pgTable("liquidation_batches", {
  batchId: int78("batch_id").primaryKey(), gear: text("gear").notNull(), sealedValueWad: int78("sealed_value_wad"), sealedAt: at("sealed_at"),
  vaultIds: text("vault_ids").array().notNull().default([]), status: text("status", { enum: ["sealed", "executed", "voided", "expired"] }).notNull(),
  sealedBlock: blk("sealed_block"), closedBlock: blk("closed_block"), voidReason: text("void_reason"),
});

export const liquidations = pgTable("liquidations", {
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), block: blk().notNull(), ts: at("ts").notNull(),
  batchId: int78("batch_id"), vaultId: int78("vault_id").notNull(), debtTokens: int78("debt_tokens").notNull(),
  collateralSeized: int78("collateral_seized").notNull(), bonusUsdg: int78("bonus_usdg"), badDebtUsdg: int78("bad_debt_usdg"),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const pauseLog = pgTable("pause_log", {
  ts: at("ts").notNull(), block: blk().notNull(), txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(),
  scope: text("scope", { enum: ["global", "gear", "underlying"] }).notNull(), ref: text("ref"), action: text("action", { enum: ["pause", "unpause"] }).notNull(),
  actor: text("actor"), reason: text("reason"),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const stockEvents = pgTable("stock_events", {
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), block: blk().notNull(), ts: at("ts").notNull(),
  token: text("token").notNull(), kind: text("kind", { enum: ["ui_multiplier", "oracle_paused", "oracle_unpaused"] }).notNull(),
  oldWad: int78("old_wad"), newWad: int78("new_wad"), effectiveAt: at("effective_at"),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const exitReserveLog = pgTable("exit_reserve_log", {
  ts: at("ts").notNull(), block: blk().notNull(), txHash: text("tx_hash").notNull().default(""), logIndex: integer("log_index").notNull().default(-1),
  balance: int78("balance").notNull(), floor: int78("floor").notNull(), ringFenced: boolean("ring_fenced").notNull().default(true),
}, (t) => [primaryKey({ columns: [t.ts, t.block, t.txHash, t.logIndex] })]);

export const stakeEvents = pgTable("stake_events", {
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), block: blk().notNull(), ts: at("ts").notNull(),
  kind: text("kind").notNull(), account: text("account"), amount: int78("amount"), detail: jsonb("detail").notNull().default({}),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const agentPolicies = pgTable("agent_policies", {
  owner: text("owner").notNull(), agent: text("agent").notNull(), budgetUsdg: int78("budget_usdg"), expiresAt: at("expires_at"),
  revoked: boolean("revoked").notNull().default(false), detail: jsonb("detail").notNull().default({}), updatedBlock: blk("updated_block").notNull(),
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(),
}, (t) => [primaryKey({ columns: [t.owner, t.agent] })]);

export const agentTrades = pgTable("agent_trades", {
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), block: blk().notNull(), ts: at("ts").notNull(),
  owner: text("owner"), agent: text("agent"), gear: text("gear"), side: text("side"), tokens: int78("tokens"), usdg: int78("usdg"),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const adminEvents = pgTable("admin_events", {
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), block: blk().notNull(), ts: at("ts").notNull(),
  source: text("source").notNull(), kind: text("kind").notNull(), opId: text("op_id"), target: text("target"), eta: at("eta"), detail: jsonb("detail").notNull().default({}),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const entityEvents = pgTable("entity_events", {
  txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), block: blk().notNull(), ts: at("ts").notNull(),
  scope: text("scope").notNull(), ref: text("ref").notNull(), kind: text("kind").notNull(), data: jsonb("data").notNull().default({}),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex, t.scope, t.ref] })]);

export const indexerSkippedEvents = pgTable("indexer_skipped_events", {
  block: blk().notNull(), txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), address: text("address"), reason: text("reason").notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.txHash, t.logIndex] })]);

export const cursors = pgTable("cursors", {
  name: text("name").primaryKey(), block: blk().notNull(), updatedAt: at("updated_at").notNull().defaultNow(),
});

export const blockHashes = pgTable("block_hashes", { block: blk().primaryKey(), hash: text("hash").notNull(), parentHash: text("parent_hash").notNull() });

export const reorgLog = pgTable("reorg_log", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), detectedAt: at("detected_at").notNull().defaultNow(), ancestor: blk("ancestor").notNull(),
  depth: blk("depth").notNull(), rowsRemoved: integer("rows_removed").notNull().default(0),
});

// drizzle/0002_vol_engine.sql
export const earningsDates = pgTable("earnings_dates", {
  symbol: text("symbol").notNull(), reportDate: date("report_date", { mode: "string" }).notNull(), session: text("session").notNull().default("unknown"),
  source: text("source").notNull(), fetchedAt: at("fetched_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.symbol, t.source, t.reportDate] })]);

export const volPostIntents = pgTable("vol_post_intents", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), market: text("market").notNull(), key: text("key").notNull().default(""),
  sigmaBps: bigint("sigma_bps", { mode: "bigint" }).notNull(), buyBlockFrom: at("buy_block_from"), buyBlockTo: at("buy_block_to"),
  validUntil: at("valid_until").notNull(), nonce: bigint("nonce", { mode: "bigint" }).notNull(),
  status: text("status", { enum: ["planned", "dry_run", "sent", "accepted", "dropped", "rejected"] }).notNull(), txHash: text("tx_hash"),
  flags: text("flags").array().notNull().default([]), digest: text("digest").notNull().default(""), signature: text("signature").notNull().default(""),
  createdAt: at("created_at").notNull().defaultNow(),
}, (t) => [index("vol_post_intents_market_idx").on(t.market, t.createdAt.desc()), index("vol_post_intents_pending_idx").on(t.status).where(sql`status IN ('planned','sent')`)]);

export const volAlerts = pgTable("vol_alerts", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), market: text("market").notNull(), kind: text("kind").notNull(),
  detail: jsonb("detail").notNull().default({}), createdAt: at("created_at").notNull().defaultNow(), repeatedAt: at("repeated_at"),
}, (t) => [index("vol_alerts_market_kind_idx").on(t.market, t.kind, t.id.desc())]);

// drizzle/0004_hedger.sql
export const hedges = pgTable("hedges", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), ts: at("ts").notNull().defaultNow(), venue: text("venue").notNull(), underlying: text("underlying").notNull(),
  side: text("side", { enum: ["buy", "sell"] }).notNull(), usd: int78("usd").notNull(), px: int78("px").notNull(), feesUsd: int78("fees_usd").notNull().default("0"),
  ref: text("ref"), reason: text("reason").notNull(), dry: boolean("dry").notNull(), clientId: text("client_id").notNull().unique(),
}, (t) => [index("hedges_underlying_ts_idx").on(t.underlying, t.ts.desc())]);

export const hedgeCycles = pgTable("hedge_cycles", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), ts: at("ts").notNull(), underlying: text("underlying").notNull(),
  deltaUsd: int78("delta_usd").notNull(), gammaUsd: int78("gamma_usd").notNull(), positionUsd: int78("position_usd").notNull(),
  residualUsd: int78("residual_usd").notNull(), bandUsd: int78("band_usd").notNull(),
  action: text("action", { enum: ["traded", "would_trade", "hold", "failed"] }).notNull(), reason: text("reason").notNull(), inputAgeS: integer("input_age_s"),
}, (t) => [index("hedge_cycles_underlying_ts_idx").on(t.underlying, t.ts.desc())]);

export const hedgerSignals = pgTable("hedger_signals", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), ts: at("ts").notNull().defaultNow(),
  kind: text("kind", { enum: ["gamma_over_budget", "unhedged", "venue_down", "proxy_basis", "disagree_with_chain", "stale_inputs", "hedge_post_missed"] }).notNull(),
  underlying: text("underlying").notNull().default(""), detail: jsonb("detail").notNull().default({}), clearedAt: at("cleared_at"),
}, (t) => [index("hedger_signals_open_idx").on(t.kind, t.underlying).where(sql`cleared_at IS NULL`)]);

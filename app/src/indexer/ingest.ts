import type { Logger } from "pino";
import type { Sql } from "postgres";
import type { Address, Hex } from "viem";
import type { Deployment } from "../chain/deployment";
import { notifyOverdriveEvents, type OdEventKind } from "../db/notify";
import { safeErrorSummary } from "../log";
import { decodeChainLog, watchedAddresses, watchedStockTopics } from "./events";
import { handleEvents, recordSkipped } from "./handlers/index";
import { rollbackAfter, type RollbackSummary } from "./rollback";
import { takeSnapshot, type SnapshotReader } from "./snapshot";
import type { BlockHeader, ChainEvent, ChainSource, IndexerContext, RpcLog } from "./types";
import { asAddress, asBigInt, asNumber } from "./units";

export const INITIAL_RANGE = 50_000n;
export const MAX_RANGE = 200_000n;
/** Blocks of header hashes kept and compared for reorg detection. */
export const HASH_WINDOW = 32n;
/** A deeper reorg stops the indexer. */
export const MAX_REORG_DEPTH = 20n;
export const MAX_CATCHUP_CONCURRENCY = 6;
const DISCOVERY_PASSES = 4;
const LAG_WARN = 100n;
const LAG_ERROR = 1_000n;

export interface IndexerSettings {
  /** Blocks behind the head that are treated as final. 0 ingests the head and relies on reorg repair. */
  readonly confirmations: number;
  readonly catchupConcurrency: number;
  readonly snapshotHeartbeatMs: number;
}

export class ReorgTooDeepError extends Error {
  constructor(readonly cursor: bigint, readonly depth: bigint | undefined) {
    super(
      depth === undefined
        ? `Block hashes disagree with the chain further back than the ${HASH_WINDOW} blocks kept (cursor ${cursor}); needs a manual re-index`
        : `Reorg of ${depth} blocks at cursor ${cursor} exceeds the automatic limit of ${MAX_REORG_DEPTH}; needs a manual re-index`,
    );
    this.name = "ReorgTooDeepError";
  }
}

export interface IndexerState {
  readonly settings: IndexerSettings;
  readonly source: ChainSource;
  readonly reader: SnapshotReader;
  readonly sql: Sql;
  readonly logger: Logger;
  readonly deployment: Deployment;
  readonly now: () => number;
  readonly gearByToken: Map<string, string>;
  readonly watched: Set<string>;
  readonly stockWatched: readonly string[];
  cursor: bigint;
  range: bigint;
  successfulRanges: number;
  catchupLimit: number;
  catchup: { ranges: number; parallelRanges: number; backoffs: number };
  skipped: number;
  pendingSnapshot: boolean;
  lastSnapshotAt: number;
  lastBlockTs: Date | undefined;
}

export interface CreateIndexerStateArgs {
  readonly settings: IndexerSettings;
  readonly source: ChainSource;
  readonly reader: SnapshotReader;
  readonly sql: Sql;
  readonly logger: Logger;
  readonly deployment: Deployment;
  readonly now?: () => number;
}

export function confirmedAt(settings: IndexerSettings, head: bigint): bigint {
  const confirmations = BigInt(settings.confirmations);
  return head > confirmations ? head - confirmations : 0n;
}

export async function createIndexerState(args: CreateIndexerStateArgs): Promise<IndexerState> {
  const { sql, deployment } = args;
  const initial = BigInt(deployment.startBlock) - 1n;
  await sql`INSERT INTO cursors (name, block) VALUES ('main', ${(initial < 0n ? 0n : initial).toString()}) ON CONFLICT (name) DO NOTHING`;
  const cursorRows = await sql<{ block: string }[]>`SELECT block FROM cursors WHERE name = 'main'`;
  const gearRows = await sql<{ id: string; token: string }[]>`SELECT id, token FROM gears`;
  const gearByToken = new Map<string, string>();
  for (const gear of deployment.gears) gearByToken.set(gear.token.toLowerCase(), gear.id.toLowerCase());
  for (const row of gearRows) gearByToken.set(row.token, row.id);
  const addresses = watchedAddresses(deployment);
  const watched = new Set(addresses.own);
  for (const token of gearByToken.keys()) watched.add(token);
  return {
    settings: args.settings, source: args.source, reader: args.reader, sql, logger: args.logger, deployment, now: args.now ?? Date.now,
    gearByToken, watched, stockWatched: addresses.stock, cursor: BigInt(cursorRows[0]!.block), range: INITIAL_RANGE, successfulRanges: 0,
    catchupLimit: Math.max(1, Math.min(MAX_CATCHUP_CONCURRENCY, args.settings.catchupConcurrency)), catchup: { ranges: 0, parallelRanges: 0, backoffs: 0 },
    skipped: 0, pendingSnapshot: true, lastSnapshotAt: 0, lastBlockTs: undefined,
  };
}

/** True when a node refused a log query for its size (so the range must shrink). */
export function isRangeLimitError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /too many|range|limit|exceed|more than|10000|10,000|response size|query returned|block span/i.test(text);
}

const blockOf = (log: RpcLog): bigint => asBigInt(log.blockNumber, -1n);
const eventOrder = (a: ChainEvent, b: ChainEvent): number => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

function uniqueLogs(logs: readonly RpcLog[]): RpcLog[] {
  const seen = new Set<string>();
  const out: RpcLog[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash}:${asNumber(log.logIndex, -1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(log);
  }
  return out;
}

interface RangeData {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly logs: RpcLog[];
  readonly stockLogs: RpcLog[];
  readonly headers: Map<bigint, BlockHeader>;
  readonly tail: BlockHeader[];
}

async function headersFor(state: IndexerState, blocks: Iterable<bigint>, into: Map<bigint, BlockHeader>): Promise<void> {
  const missing = [...new Set(blocks)].filter((block) => !into.has(block));
  if (missing.length === 0) return;
  const fetched = await state.source.getHeaders(missing);
  for (const block of missing) {
    const header = fetched.get(block);
    if (!header) throw new Error(`Block header unavailable for ${block}`);
    into.set(block, header);
  }
}

/** Everything read from the node for one range, fetched without touching the database so ranges can be fetched at once. */
async function loadRange(state: IndexerState, fromBlock: bigint, toBlock: bigint): Promise<RangeData> {
  const { logs, stockLogs } = await state.source.getLogs({
    fromBlock, toBlock, addresses: [...state.watched] as Address[], stockAddresses: state.stockWatched as Address[], stockTopics: watchedStockTopics as Hex[],
  });
  const all = uniqueLogs([...logs, ...stockLogs]);
  const wanted = new Set<bigint>([fromBlock]);
  for (const log of all) wanted.add(blockOf(log));
  const tailStart = toBlock - HASH_WINDOW + 1n > fromBlock ? toBlock - HASH_WINDOW + 1n : fromBlock;
  for (let block = tailStart; block <= toBlock; block += 1n) wanted.add(block);
  const headers = new Map<bigint, BlockHeader>();
  await headersFor(state, wanted, headers);
  const tail: BlockHeader[] = [];
  for (let block = tailStart; block <= toBlock; block += 1n) tail.push(headers.get(block)!);
  return { fromBlock, toBlock, logs: all, stockLogs: [], headers, tail };
}

function planRanges(state: IndexerState, from: bigint, confirmed: bigint): [bigint, bigint][] {
  const planned: [bigint, bigint][] = [];
  let start = from;
  while (start <= confirmed && planned.length < state.catchupLimit) {
    const end = start + state.range - 1n > confirmed ? confirmed : start + state.range - 1n;
    planned.push([start, end]);
    start = end + 1n;
  }
  return planned;
}

/** Writes the status row. Lag warns at 100 blocks and is an error at 1,000. */
async function writeStatus(sql: Sql, state: IndexerState, head: bigint, indexed: bigint): Promise<void> {
  const lag = head > indexed ? head - indexed : 0n;
  const error = lag >= LAG_ERROR ? `indexer lag ${lag} blocks` : null;
  if (lag >= LAG_WARN) state.logger.warn({ lag: lag.toString() }, "Indexer is behind the chain head");
  const meta = JSON.stringify({
    lastHeadBlock: head.toString(), indexedBlock: indexed.toString(), lag: lag.toString(), skippedEvents: state.skipped,
    catchup: { ...state.catchup, range: state.range.toString(), limit: state.catchupLimit },
    chainTimestamp: state.lastBlockTs ? Math.floor(state.lastBlockTs.getTime() / 1000) : null,
  });
  await sql`
    INSERT INTO service_status (job, last_run, last_ok, last_error, meta) VALUES ('indexer', NOW(), NOW(), ${error}, ${meta}::jsonb)
    ON CONFLICT (job) DO UPDATE SET last_run = NOW(), last_ok = NOW(), last_error = ${error}, meta = service_status.meta || EXCLUDED.meta`;
}

/** Applies one fetched range in one transaction. Returns the number of events and the kinds to announce. */
async function ingestRange(state: IndexerState, data: RangeData, head: bigint): Promise<{ events: number; kinds: Set<OdEventKind> }> {
  const { fromBlock, toBlock, headers, tail } = data;
  const previous = await state.sql<{ hash: string }[]>`SELECT hash FROM block_hashes WHERE block = ${(fromBlock - 1n).toString()}`;
  const first = headers.get(fromBlock)!;
  if (previous[0] && previous[0].hash !== first.parentHash) throw new Error(`Chain reorganised while ingesting ${fromBlock}; retrying after repair`);

  const maps = { deployment: state.deployment, gearByToken: state.gearByToken };
  const decode = async (tx: IndexerContext["tx"], logs: readonly RpcLog[]): Promise<ChainEvent[]> => {
    const events: ChainEvent[] = [];
    for (const log of logs) {
      const header = headers.get(blockOf(log));
      const event = header ? decodeChainLog(log, maps, header.timestamp) : undefined;
      if (event) events.push(event);
      else if (state.watched.has(asAddress(log.address)) && log.transactionHash) {
        // a watched contract emitted something we cannot decode: record it and move on (R13)
        await recordSkipped(tx, { block: blockOf(log), txHash: log.transactionHash.toLowerCase(), logIndex: asNumber(log.logIndex, 0), address: log.address, reason: "undecodable log" });
        state.skipped += 1;
      }
    }
    return events.sort(eventOrder);
  };

  let count = 0;
  const kinds = new Set<OdEventKind>();
  await state.sql.begin(async (tx) => {
    const context: IndexerContext = { tx, deployment: state.deployment, logger: state.logger, gearByToken: state.gearByToken, touchedBalances: new Map(), newTokens: [], kinds, snapshotNeeded: false, ...(state.source.readGearParams ? { readGearParams: state.source.readGearParams.bind(state.source) } : {}) };
    let events = await decode(tx, data.logs);
    for (let pass = 0; ; pass++) {
      state.skipped += await handleEvents(context, events);
      count += events.length;
      const fresh = context.newTokens.splice(0).filter((token) => !state.watched.has(token));
      if (fresh.length === 0 || pass >= DISCOVERY_PASSES) break;
      // gear tokens listed inside this range were not in the address filter: fetch their logs for the same range now
      for (const token of fresh) state.watched.add(token);
      const extra = await state.source.getLogs({ fromBlock, toBlock, addresses: fresh as Address[], stockAddresses: [], stockTopics: [] });
      await headersFor(state, extra.logs.map(blockOf), headers);
      events = await decode(tx, uniqueLogs(extra.logs));
    }
    for (const header of tail) {
      await tx`INSERT INTO block_hashes (block, hash, parent_hash) VALUES (${header.number.toString()}, ${header.hash}, ${header.parentHash})
        ON CONFLICT (block) DO UPDATE SET hash = EXCLUDED.hash, parent_hash = EXCLUDED.parent_hash`;
    }
    await tx`DELETE FROM block_hashes WHERE block <= ${(toBlock - 2n * HASH_WINDOW).toString()}`;
    state.pendingSnapshot ||= context.snapshotNeeded;
    await tx`UPDATE cursors SET block = ${toBlock.toString()}, updated_at = NOW() WHERE name = 'main'`;
    state.lastBlockTs = headers.get(toBlock)!.timestamp;
    await writeStatus(tx as unknown as Sql, state, head, toBlock);
  });
  state.cursor = toBlock;
  return { events: count, kinds };
}

/** Compares the stored top block hash with the chain; on a mismatch finds the common ancestor and rolls back (R11). */
export async function repairReorg(state: IndexerState): Promise<RollbackSummary | undefined> {
  const stored = await state.sql<{ block: string; hash: string }[]>`SELECT block, hash FROM block_hashes ORDER BY block DESC LIMIT ${Number(HASH_WINDOW)}`;
  const top = stored[0];
  if (!top) return undefined;
  const topBlock = BigInt(top.block);
  const topHeader = (await state.source.getHeaders([topBlock])).get(topBlock);
  if (topHeader && topHeader.hash === top.hash) return undefined;

  const headers = await state.source.getHeaders(stored.map((row) => BigInt(row.block)));
  const ancestor = stored.find((row) => headers.get(BigInt(row.block))?.hash === row.hash);
  const depth = ancestor ? state.cursor - BigInt(ancestor.block) : undefined;
  if (!ancestor || depth! > MAX_REORG_DEPTH) {
    const message = new ReorgTooDeepError(state.cursor, depth).message;
    await state.sql`
      INSERT INTO service_status (job, last_run, last_error) VALUES ('indexer', NOW(), ${message})
      ON CONFLICT (job) DO UPDATE SET last_run = NOW(), last_error = ${message}`;
    throw new ReorgTooDeepError(state.cursor, depth);
  }
  const ancestorBlock = BigInt(ancestor.block);
  let summary!: RollbackSummary;
  await state.sql.begin(async (tx) => {
    summary = await rollbackAfter(tx, state.deployment, ancestorBlock);
    await tx`INSERT INTO reorg_log (ancestor, depth, rows_removed) VALUES (${ancestorBlock.toString()}, ${depth!.toString()}, ${summary.rowsRemoved})`;
  });
  state.logger.warn({ depth: depth!.toString(), ancestor: ancestorBlock.toString() }, "Chain reorganised: rolled back orphaned blocks and will re-ingest them");
  state.cursor = ancestorBlock;
  state.pendingSnapshot = true;
  state.successfulRanges = 0;
  return summary;
}

async function maybeSnapshot(state: IndexerState, block: bigint, ts: Date, kinds: Set<OdEventKind>): Promise<void> {
  const due = state.pendingSnapshot || state.now() - state.lastSnapshotAt >= state.settings.snapshotHeartbeatMs;
  if (!due) return;
  const result = await takeSnapshot(state.reader, state.sql, state.deployment, { block, ts }, state.logger);
  if (result.ok) {
    state.pendingSnapshot = false;
    state.lastSnapshotAt = state.now();
    kinds.add("snapshot");
  }
}

export function createIngest(state: IndexerState): { tick(): Promise<{ ingested: bigint; head: bigint; reorg?: RollbackSummary }> } {
  return {
    async tick() {
      const head = await state.source.getHead();
      const reorg = await repairReorg(state);
      const confirmed = confirmedAt(state.settings, head);
      const kinds = new Set<OdEventKind>();
      const startCursor = state.cursor;
      let attempts = 0;
      while (state.cursor < confirmed) {
        const planned = planRanges(state, state.cursor + 1n, confirmed);
        let loaded: RangeData[];
        try {
          loaded = await Promise.all(planned.map(([from, to]) => loadRange(state, from, to)));
        } catch (error) {
          // halve the range on a provider error or "too many results"; give up only when a one-block range still fails
          attempts += 1;
          if (state.range <= 1n || attempts > 24) throw error;
          state.range = state.range / 2n > 1n ? state.range / 2n : 1n;
          state.successfulRanges = 0;
          state.catchup.backoffs += 1;
          if (state.catchupLimit > 1) state.catchupLimit -= 1;
          state.logger.warn({ range: state.range.toString(), err: safeErrorSummary(error) }, "Log range failed; halving");
          continue;
        }
        if (loaded.length > 1) state.catchup.parallelRanges += loaded.length;
        for (const data of loaded) {
          const applied = await ingestRange(state, data, head);
          for (const kind of applied.kinds) kinds.add(kind);
          state.catchup.ranges += 1;
          state.successfulRanges += 1;
        }
        if (state.successfulRanges >= 3 && state.range < MAX_RANGE) {
          state.range = state.range * 2n > MAX_RANGE ? MAX_RANGE : state.range * 2n;
          state.successfulRanges = 0;
        }
        if (state.catchupLimit < Math.min(MAX_CATCHUP_CONCURRENCY, state.settings.catchupConcurrency)) state.catchupLimit += 1;
      }
      const ingested = state.cursor - startCursor > 0n ? state.cursor - startCursor : 0n;
      const header = state.lastBlockTs ?? (await state.source.getHeaders([state.cursor])).get(state.cursor)?.timestamp ?? new Date(state.now());
      await maybeSnapshot(state, state.cursor, header, kinds);
      await writeStatus(state.sql, state, head, state.cursor);
      // NOTIFY only after everything above has committed (R18)
      if (kinds.size > 0 || reorg) await notifyOverdriveEvents(state.sql, { kinds: [...kinds].length ? [...kinds].sort() : ["config"], block: state.cursor });
      return reorg ? { ingested, head, reorg } : { ingested, head };
    },
  };
}

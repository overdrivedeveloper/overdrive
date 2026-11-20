import type { Logger } from "pino";
import type { Sql } from "postgres";
import type { Hex } from "viem";
import type { Deployment } from "../chain/deployment";
import { safeErrorSummary } from "../log";
import { marketSymbol } from "./units";
import { mulWad, toBigInt, WAD, wadToUsdg } from "../lib/fixed";

/** What a snapshot reads from the chain (production: multicall over the state route; tests: a fixture). */
export interface SnapshotReader {
  price(market: Hex): Promise<{ priceWad: bigint; fresh: boolean; source: string; session: string | null }>;
  /** Gear token total supply, Governor backer debt for the gear, and the Minter's value per token (WAD USD, NF included). */
  gear(gearId: Hex, token: string): Promise<{ supply: bigint; backerDebt: bigint; valuePerTokenWad: bigint }>;
  /** Raw USDG (6 dp). */
  governor(): Promise<{ equity: bigint; exitReserve: bigint; exitReserveFloor: bigint }>;
  /** Net hedge position in USD, raw USDG (6 dp), per underlying market. */
  hedgeDelta(market: Hex): Promise<bigint>;
}

export interface LedgerRow {
  readonly underlying: string;
  readonly deltaUsdg: bigint;
  readonly gammaUsdg: bigint;
}

export interface GearBook {
  readonly marketA: string;
  readonly marketB: string | null;
  readonly powerWad: bigint;
  /** Governor-backed supply: total supply minus tokens minted against backer vaults. */
  readonly holderTokens: bigint;
  readonly valuePerTokenWad: bigint;
}

/**
 * R15: delta = sum p*V and gamma = sum p(p-1)*V per underlying, V = Governor-backed supply * value per token (USD).
 * A pair gear (A/B)^p adds p*V to A and -p*V to B, diagonal gamma p(p-1)V on A and p(p+1)V on B. Summed in WAD, converted
 * to raw USDG once per underlying.
 */
export function computeLedger(gears: readonly GearBook[], symbolOf: (market: string) => string): LedgerRow[] {
  const delta = new Map<string, bigint>();
  const gamma = new Map<string, bigint>();
  const add = (map: Map<string, bigint>, key: string, value: bigint) => map.set(key, (map.get(key) ?? 0n) + value);
  for (const gear of gears) {
    const v = mulWad(gear.holderTokens, gear.valuePerTokenWad);
    const p = gear.powerWad;
    const a = symbolOf(gear.marketA);
    add(delta, a, mulWad(p, v));
    add(gamma, a, mulWad(mulWad(p, p - WAD), v));
    if (gear.marketB) {
      const b = symbolOf(gear.marketB);
      add(delta, b, -mulWad(p, v));
      add(gamma, b, mulWad(mulWad(p, p + WAD), v));
    }
  }
  const underlyings = new Set([...delta.keys(), ...gamma.keys()]);
  return [...underlyings].sort().map((underlying) => ({ underlying, deltaUsdg: wadToUsdg(delta.get(underlying) ?? 0n), gammaUsdg: wadToUsdg(gamma.get(underlying) ?? 0n) }));
}

async function markStale(sql: Sql, stale: boolean, message?: string): Promise<void> {
  const meta = JSON.stringify(stale ? { snapshotStale: true } : { snapshotStale: false, lastSnapshotAt: new Date().toISOString() });
  await sql`
    INSERT INTO service_status (job, last_run, meta) VALUES ('indexer', NOW(), ${meta}::jsonb)
    ON CONFLICT (job) DO UPDATE SET meta = service_status.meta || EXCLUDED.meta, last_run = NOW(),
      last_error = CASE WHEN ${message ?? null}::text IS NULL THEN service_status.last_error ELSE ${message ?? null} END`;
}

/**
 * Reads prices, gear books and Governor state from the chain and writes prices, governor_ledger and exit_reserve_log for `at`.
 * R16: every read happens before any write; if one fails the previous rows stay, `service_status.meta.snapshotStale` is set,
 * and nothing is written (never zeros).
 */
export async function takeSnapshot(
  reader: SnapshotReader, sql: Sql, deployment: Deployment, at: { block: bigint; ts: Date }, logger?: Logger,
): Promise<{ ok: boolean; ledgerRows: number }> {
  try {
    const gearRows = await sql<{ id: string; token: string; market_a: string; market_b: string | null; power_wad: string; status: string }[]>`
      SELECT id, token, market_a, market_b, power_wad, status FROM gears WHERE status <> 'retired' ORDER BY id`;
    const symbols = new Map(deployment.markets.map((market) => [market.id.toLowerCase(), market.symbol]));
    // a market only the chain knows (listed through the timelock after the deploy, record not synced yet) reads by its id
    const symbolOf = (market: string) => symbols.get(market.toLowerCase()) ?? marketSymbol(market);
    const unrecorded = new Map<string, string>();
    for (const row of gearRows) {
      for (const m of [row.market_a, row.market_b]) {
        if (m && /^0x[0-9a-fA-F]{64}$/.test(m) && !symbols.has(m.toLowerCase())) unrecorded.set(symbolOf(m), m.toLowerCase());
      }
    }
    const books: GearBook[] = [];
    for (const row of gearRows) {
      const read = await reader.gear(row.id as Hex, row.token);
      books.push({
        marketA: row.market_a, marketB: row.market_b, powerWad: toBigInt(row.power_wad),
        holderTokens: read.supply > read.backerDebt ? read.supply - read.backerDebt : 0n, valuePerTokenWad: read.valuePerTokenWad,
      });
    }
    const ledger = computeLedger(books, symbolOf);
    const governor = await reader.governor();
    const hedge = new Map<string, bigint>();
    for (const row of ledger) {
      const market = deployment.markets.find((m) => m.symbol === row.underlying);
      hedge.set(row.underlying, market ? await reader.hedgeDelta(market.id) : 0n);
    }
    const prices: { symbol: string; stockToken: string | null; read: Awaited<ReturnType<SnapshotReader["price"]>> }[] = [];
    for (const market of deployment.markets) prices.push({ symbol: market.symbol, stockToken: market.stockToken?.toLowerCase() ?? null, read: await reader.price(market.id) });
    for (const [symbol, id] of unrecorded) {
      // never let a market the record lacks fail the whole snapshot: skip it and say so
      try { prices.push({ symbol, stockToken: null, read: await reader.price(id as Hex) }); }
      catch (error) { logger?.warn({ err: safeErrorSummary(error), market: symbol }, "price read failed for a market the deployment record does not list"); }
    }

    const ts = at.ts.toISOString();
    const block = at.block.toString();
    await sql.begin(async (tx) => {
      for (const price of prices) {
        let multiplier: string | null = null;
        if (price.stockToken) {
          const rows = await tx<{ new_wad: string | null }[]>`
            SELECT new_wad FROM stock_events WHERE token = ${price.stockToken} AND kind = 'ui_multiplier' AND effective_at <= ${ts}::timestamptz ORDER BY effective_at DESC, block DESC LIMIT 1`;
          multiplier = rows[0]?.new_wad ?? WAD.toString();
        }
        await tx`
          INSERT INTO prices (underlying, ts, block, price_wad, session, fresh, source, multiplier_wad)
          VALUES (${price.symbol}, ${ts}, ${block}, ${price.read.priceWad.toString()}, ${price.read.session}, ${price.read.fresh}, ${price.read.source}, ${multiplier})
          ON CONFLICT (underlying, ts) DO UPDATE SET block = EXCLUDED.block, price_wad = EXCLUDED.price_wad, session = EXCLUDED.session, fresh = EXCLUDED.fresh,
            source = EXCLUDED.source, multiplier_wad = EXCLUDED.multiplier_wad`;
      }
      for (const row of ledger) {
        await tx`
          INSERT INTO governor_ledger (ts, underlying, delta, gamma, hedge_delta, equity, exit_reserve, block)
          VALUES (${ts}, ${row.underlying}, ${row.deltaUsdg.toString()}, ${row.gammaUsdg.toString()}, ${(hedge.get(row.underlying) ?? 0n).toString()},
                  ${governor.equity.toString()}, ${governor.exitReserve.toString()}, ${block})
          ON CONFLICT (ts, underlying) DO UPDATE SET delta = EXCLUDED.delta, gamma = EXCLUDED.gamma, hedge_delta = EXCLUDED.hedge_delta,
            equity = EXCLUDED.equity, exit_reserve = EXCLUDED.exit_reserve, block = EXCLUDED.block`;
      }
      await tx`
        INSERT INTO exit_reserve_log (ts, block, tx_hash, log_index, balance, "floor", ring_fenced)
        VALUES (${ts}, ${block}, '', -1, ${governor.exitReserve.toString()}, ${governor.exitReserveFloor.toString()}, true)
        ON CONFLICT DO NOTHING`;
    });
    await markStale(sql, false);
    return { ok: true, ledgerRows: ledger.length };
  } catch (error) {
    logger?.warn({ err: safeErrorSummary(error) }, "Snapshot read failed; keeping the previous rows");
    await markStale(sql, true, `snapshot failed: ${safeErrorSummary(error).message}`.slice(0, 300)).catch(() => undefined);
    return { ok: false, ledgerRows: 0 };
  }
}

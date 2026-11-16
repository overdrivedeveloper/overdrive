import type { Sql } from "postgres";
import type { Hex } from "viem";
import { pairMarketKey } from "../../lib/volpost";

export interface GearRow {
  id: string; marketA: string; marketB: string | null; underlying: string; underlyingB: string | null; power: string; token: string;
  capUsd: string; spreadBps: number; status: "active" | "paused" | "retired"; nf: string; lastAccrual: Date | null;
  tollPerSecWad: string | null; tollAt: Date | null;
  priceWad: string | null; priceTs: Date | null; session: string | null; priceFresh: boolean | null;
  sigmaBps: string | null; sigmaAt: Date | null;
  lastValueWad: string | null; supply: string;
  /** NF in force at the last trade (nf_history at or before it); null when none is indexed. */
  tradeNf: string | null;
}

const GEAR_SELECT = (sql: Sql, where: ReturnType<Sql>) => sql<GearRow[]>`
  SELECT g.id, g.market_a AS "marketA", g.market_b AS "marketB", g.underlying, g.underlying_b AS "underlyingB", g.power::text AS power, g.token,
    g.cap_usd::text AS "capUsd", g.spread_bps AS "spreadBps", g.status, g.nf::text AS nf, g.last_accrual AS "lastAccrual",
    h.toll::text AS "tollPerSecWad", h.ts AS "tollAt",
    p.price_wad::text AS "priceWad", p.ts AS "priceTs", p.session, p.fresh AS "priceFresh",
    v.sigma_bps::text AS "sigmaBps", v.ts AS "sigmaAt",
    t.value_per_token::text AS "lastValueWad", tn.nf::text AS "tradeNf",
    COALESCE((SELECT SUM(b.balance) FROM balances b WHERE b.token = g.token AND b.account <> '0x0000000000000000000000000000000000000000'), 0)::text AS supply
  FROM gears g
  LEFT JOIN LATERAL (SELECT toll, ts FROM nf_history WHERE gear = g.id ORDER BY block DESC, log_index DESC LIMIT 1) h ON true
  LEFT JOIN LATERAL (SELECT price_wad, ts, session, fresh FROM prices WHERE underlying = g.underlying ORDER BY ts DESC LIMIT 1) p ON true
  LEFT JOIN LATERAL (SELECT sigma_bps, ts FROM vol_posts WHERE gear_or_underlying = g.id
    OR (g.market_b IS NULL AND gear_or_underlying IN (g.underlying, g.market_a)) ORDER BY ts DESC LIMIT 1) v ON true
  LEFT JOIN LATERAL (SELECT value_per_token, block, log_index FROM trades WHERE gear = g.id AND value_per_token IS NOT NULL ORDER BY block DESC, log_index DESC LIMIT 1) t ON true
  LEFT JOIN LATERAL (SELECT nf FROM nf_history WHERE gear = g.id AND t.block IS NOT NULL AND (block < t.block OR (block = t.block AND log_index <= t.log_index)) ORDER BY block DESC, log_index DESC LIMIT 1) tn ON true
  ${where} ORDER BY g.underlying, g.power`;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** The oracle key a pair gear's sigma is posted under: keccak256(abi.encode(marketA, marketB)) (ODVolOracle.pairKey, R9). */
export function pairVolKey(row: Pick<GearRow, "marketA" | "marketB">): string | null {
  if (!row.marketB || !BYTES32.test(row.marketA) || !BYTES32.test(row.marketB)) return null;
  return pairMarketKey(row.marketA as Hex, row.marketB as Hex).toLowerCase();
}

/** Pair gears read sigma under the oracle pair key, never under leg A's market (SQL has no keccak, so this is a second query). */
async function withPairSigma(sql: Sql, rows: GearRow[]): Promise<GearRow[]> {
  const keyed = rows.map((r) => [r, pairVolKey(r)] as const).filter((x): x is readonly [GearRow, string] => x[1] !== null);
  if (keyed.length === 0) return rows;
  const posts = await sql<{ key: string; sigmaBps: string; sigmaAt: Date }[]>`
    SELECT DISTINCT ON (gear_or_underlying) gear_or_underlying AS key, sigma_bps::text AS "sigmaBps", ts AS "sigmaAt"
    FROM vol_posts WHERE gear_or_underlying IN ${sql(keyed.map((x) => x[1]))} ORDER BY gear_or_underlying, ts DESC`;
  const byKey = new Map(posts.map((p) => [p.key, p]));
  for (const [row, key] of keyed) {
    const p = byKey.get(key);
    if (p && (row.sigmaAt === null || p.sigmaAt >= row.sigmaAt)) {
      row.sigmaBps = p.sigmaBps;
      row.sigmaAt = p.sigmaAt;
    }
  }
  return rows;
}

export const listGears = async (sql: Sql): Promise<GearRow[]> => withPairSigma(sql, await GEAR_SELECT(sql, sql``));
export const getGear = async (sql: Sql, id: string): Promise<GearRow | undefined> =>
  (await withPairSigma(sql, await GEAR_SELECT(sql, sql`WHERE g.id = ${id.toLowerCase()}`)))[0];

export interface HistoryPoint { ts: string; nf: string; tollPerSecWad: string; valuePerTokenWad: string | null; priceWad: string | null }
/** NF and toll series from nf_history, with the underlying price in force at each point (prices table). */
export async function gearHistory(sql: Sql, gearId: string, underlying: string, since: Date, limit: number): Promise<HistoryPoint[]> {
  const rows = await sql<{ ts: Date; nf: string; toll: string; price: string | null; value: string | null }[]>`
    SELECT h.ts, h.nf::text AS nf, h.toll::text AS toll,
      (SELECT price_wad::text FROM prices p WHERE p.underlying = ${underlying} AND p.ts <= h.ts ORDER BY p.ts DESC LIMIT 1) AS price,
      (SELECT value_per_token::text FROM trades t WHERE t.gear = ${gearId} AND t.ts <= h.ts AND t.value_per_token IS NOT NULL ORDER BY t.ts DESC LIMIT 1) AS value
    FROM nf_history h WHERE h.gear = ${gearId} AND h.ts >= ${since.toISOString()} ORDER BY h.ts DESC LIMIT ${limit}`;
  return rows.reverse().map((r) => ({ ts: r.ts.toISOString(), nf: r.nf, tollPerSecWad: r.toll, valuePerTokenWad: r.value, priceWad: r.price }));
}

import type { Sql } from "postgres";
export interface HoldingRow { gear: string; token: string; balance: string; bought: string; boughtUsdg: string; sold: string; soldUsdg: string }
/** Balances per gear with the trade totals the cost basis is built from. */
export const holdings = (sql: Sql, account: string) => sql<HoldingRow[]>`
  SELECT g.id AS gear, g.token, b.balance::text AS balance,
    COALESCE((SELECT SUM(tokens) FROM trades t WHERE t.gear = g.id AND t.account = ${account} AND t.side = 'buy'), 0)::text AS bought,
    COALESCE((SELECT SUM(usdg) FROM trades t WHERE t.gear = g.id AND t.account = ${account} AND t.side = 'buy'), 0)::text AS "boughtUsdg",
    COALESCE((SELECT SUM(tokens) FROM trades t WHERE t.gear = g.id AND t.account = ${account} AND t.side = 'sell'), 0)::text AS sold,
    COALESCE((SELECT SUM(usdg) FROM trades t WHERE t.gear = g.id AND t.account = ${account} AND t.side = 'sell'), 0)::text AS "soldUsdg"
  FROM balances b JOIN gears g ON g.token = b.token WHERE b.account = ${account} AND (b.balance > 0 OR EXISTS (SELECT 1 FROM trades t WHERE t.gear = g.id AND t.account = ${account}))
  ORDER BY g.underlying, g.power`;
/** Toll paid by a holder: the NF shrink between each buy and now, in value terms, is not stored per account, so the API derives it
 * from the gear's toll history over the holding period: sum of toll_value_usd_wad per token x balance. Returns the per-gear
 * cumulative toll value per token since the first trade (USD WAD). */
export const tollPerTokenSince = async (sql: Sql, gear: string, since: Date | null): Promise<bigint> => {
  if (!since) return 0n;
  const [row] = await sql<{ s: string | null }[]>`SELECT SUM(toll_value_usd_wad)::text AS s FROM nf_history WHERE gear = ${gear} AND ts >= ${since.toISOString()} AND toll_value_usd_wad > 0`;
  return BigInt(row?.s ?? "0");
};
export const firstTradeAt = async (sql: Sql, gear: string, account: string): Promise<Date | null> =>
  (await sql<{ ts: Date | null }[]>`SELECT MIN(ts) AS ts FROM trades WHERE gear = ${gear} AND account = ${account}`)[0]?.ts ?? null;

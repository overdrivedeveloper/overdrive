// Gears listed on chain that the deployment record does not name yet. Listing happens after the deploy, through the
// timelock, so for a while (or for good, when the owner forgets the record sync) the record lags the chain. The indexer
// stores every GearListed event; this module turns those rows into record-shaped entries so the API still knows the
// gear (symbol, power, market, token) and the services can say loudly that the record is stale.
// The record stays the source for everything the events do not hold (pool ids, market feeds for the crank).
import type { Sql } from "postgres";
import { getAddress } from "viem";
import type { Deployment } from "./deployments";

export type RecordGear = Deployment["gears"][number];

/** ODTypes.Gear order: names, power text and the registry token suffix (ODGearRegistry.suffixOf). */
const GEAR_NAMES = ["CRUISE", "SPORT", "RACE", "ECO", "REVERSE"] as const;
const GEAR_POWERS = ["1.5", "2", "3", "0.5", "-1"] as const;
const GEAR_SUFFIX = ["-CRUISE", "-SPORT", "-RACE", "-ECO", "-REV"] as const;
const ZERO_POOL = `0x${"0".repeat(64)}` as const;
const WAD = 10n ** 18n;

/** One indexed listing: the gears row joined with its GearListed entity event (gear enum and unit). */
export interface IndexedGear {
  id: string; underlying: string; underlyingB: string | null; power: string; token: string; capUsd: string; spreadBps: number;
  gearIndex: number | null; unitWad: string | null;
}

/** The token symbol the registry accepts and ListGears writes: TICKER + suffix, TICKER = "A/B" for a pair. */
export function listedSymbol(underlying: string, underlyingB: string | null, gearIndex: number): string {
  return `${underlyingB ? `${underlying}/${underlyingB}` : underlying}${GEAR_SUFFIX[gearIndex] ?? ""}`;
}

/** A record-shaped gear from an indexed listing. The pool id is not on the event: it reads as zero until the record has it. */
export function recordGearFromIndexed(row: IndexedGear): RecordGear | undefined {
  const index = row.gearIndex ?? GEAR_POWERS.indexOf(String(Number(row.power)) as (typeof GEAR_POWERS)[number]);
  if (index < 0 || index >= GEAR_NAMES.length || !/^0x[0-9a-fA-F]{40}$/.test(row.token)) return undefined;
  // the gears row stores the pair underlying as "A/B" in some paths; the market A symbol is the part before the slash
  const marketA = row.underlyingB && row.underlying.endsWith(`/${row.underlyingB}`) ? row.underlying.slice(0, -row.underlyingB.length - 1) : row.underlying;
  const unit = row.unitWad && /^\d+$/.test(row.unitWad) ? BigInt(row.unitWad) : WAD;
  return {
    id: row.id.toLowerCase() as `0x${string}`, symbol: listedSymbol(marketA, row.underlyingB, index), gear: GEAR_NAMES[index]!, power: GEAR_POWERS[index]!,
    marketA, marketB: row.underlyingB, token: getAddress(row.token), poolId: ZERO_POOL, capUsd: row.capUsd, spreadBps: row.spreadBps,
    unitUsd: unit % WAD === 0n ? (unit / WAD).toString() : (Number(unit) / 1e18).toString(),
  };
}

/** True when the pool id is the placeholder of an indexed-only gear (not a real pool). */
export const isPlaceholderPool = (poolId: string | null | undefined): boolean => !poolId || poolId.toLowerCase() === ZERO_POOL;

/** Adds every indexed gear the record does not list to `deployment.gears` (in place, so every holder of the object sees it).
 *  Returns the added entries; a gear the record already lists is never touched. */
export function adoptIndexedGears(deployment: Deployment, rows: readonly IndexedGear[]): RecordGear[] {
  const known = new Set(deployment.gears.map((g) => g.id.toLowerCase()));
  const added: RecordGear[] = [];
  for (const row of rows) {
    if (known.has(row.id.toLowerCase())) continue;
    const gear = recordGearFromIndexed(row);
    if (!gear) continue;
    deployment.gears.push(gear);
    known.add(gear.id);
    added.push(gear);
  }
  return added;
}

/** Every indexed listing (gears rows with their GearListed event data). */
export async function readIndexedGears(sql: Sql): Promise<IndexedGear[]> {
  const rows = await sql<{ id: string; underlying: string; underlyingB: string | null; power: string; token: string; capUsd: string; spreadBps: number; gearIndex: string | null; unitWad: string | null }[]>`
    SELECT g.id, g.underlying, g.underlying_b AS "underlyingB", g.power::text AS power, g.token, g.cap_usd::text AS "capUsd", g.spread_bps AS "spreadBps",
      e.data->>'gear' AS "gearIndex", e.data->>'unitWad' AS "unitWad"
    FROM gears g
    LEFT JOIN LATERAL (SELECT data FROM entity_events WHERE scope = 'gear' AND ref = g.id AND kind = 'listed' ORDER BY block LIMIT 1) e ON true
    ORDER BY g.listed_block NULLS LAST, g.id`;
  return rows.map((r) => ({ ...r, gearIndex: r.gearIndex === null || !/^\d+$/.test(r.gearIndex) ? null : Number(r.gearIndex) }));
}

/** The message every service logs when the chain lists gears the record does not: loud, with the fix. */
export function staleRecordMessage(ids: readonly string[]): string {
  return `deployment record is missing ${ids.length} gear(s) listed on chain (${ids.join(", ")}): run app/scripts/deploy/record-sync.ts, commit the record and redeploy the services`;
}

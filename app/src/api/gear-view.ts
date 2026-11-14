// One view of a gear, built from Postgres rows only (no RPC): used by /gears, /tolls and /exit.
import { parseUnits } from "viem";
import type { Deployment } from "../lib/deployments";
import { WAD, wadToUsdg } from "../lib/fixed";
import type { GearRow } from "../db/queries/gears";
import type { PauseRow } from "../db/queries/status";
import { SECONDS_PER_DAY, SIGMA_MAX_AGE_SEC, tollPerDayTwinWad } from "../db/queries/tolls";
import { type ErrorCode, tollBpsText } from "./quote/model";

export interface GearView {
  symbol: string; id: string; underlying: string; underlyingB: string | null; power: string; token: string; gear: string | null;
  price: string | null; valuePerToken: string; valueSource: "trade" | "listing"; nf: string;
  tollPerDayBps: string; tollPer30DaysBps: string; holdersReceive: boolean; tollFormulaBps: string | null;
  sigmaBps: string | null; sigmaAgeSec: number | null; sigmaWarning: "floor" | null;
  spreadBps: number; cap: string; openValue: string; status: string; session: string; buyable: boolean; reason: ErrorCode | null;
  sellMode: "instant" | "instant_min"; pausedBy: string | null;
}

const round6 = (wad: bigint): string => tollBpsText(((wad + 5n * 10n ** 7n) / 10n ** 8n) * 10n ** 8n); // 6 decimals of a bp

export function symbolOf(deployment: Deployment, id: string): string {
  return deployment.gears.find((g) => g.id.toLowerCase() === id.toLowerCase())?.symbol ?? id;
}

/** Toll per day (WAD fraction) shown for a gear: the indexed on-chain value; the twin when no accrual has been indexed yet. */
export function tollPerDayOf(row: GearRow): bigint {
  if (row.tollPerSecWad !== null) return BigInt(row.tollPerSecWad) * SECONDS_PER_DAY;
  if (row.sigmaBps !== null) return tollPerDayTwinWad(BigInt(Math.round(Number(row.power) * 1e6)) * 10n ** 12n, BigInt(row.sigmaBps));
  return 0n;
}

export function buildGearView(row: GearRow, deployment: Deployment, pauses: readonly PauseRow[], now: Date): GearView {
  const cfg = deployment.gears.find((g) => g.id.toLowerCase() === row.id.toLowerCase());
  const nf = BigInt(row.nf);
  const unit = cfg ? parseUnits(cfg.unitUsd, 18) : WAD;
  const value = row.lastValueWad !== null ? BigInt(row.lastValueWad) : (unit * nf) / WAD;
  const supply = BigInt(row.supply);
  const open = wadToUsdg((supply * value) / WAD);
  const cap = BigInt(row.capUsd);
  const session = row.session ?? "UNKNOWN";
  const toll = tollPerDayOf(row);
  const powerWad = BigInt(Math.round(Number(row.power) * 1e6)) * 10n ** 12n;
  const sigmaAge = row.sigmaAt ? Math.max(0, Math.floor((now.getTime() - row.sigmaAt.getTime()) / 1000)) : null;
  const pause = pauses.find((p) => p.scope === "global" || (p.scope === "gear" && p.ref?.toLowerCase() === row.id.toLowerCase()) || (p.scope === "underlying" && p.ref === row.underlying));
  let reason: ErrorCode | null = null;
  if (pause || row.status !== "active") reason = "PAUSED";
  else if (row.priceFresh === false || row.priceTs === null) reason = "STALE";
  else if (session === "CLOSED" || session === "UNKNOWN" || session === "HALTED") reason = "CLOSED";
  else if (cap > 0n && open >= cap) reason = "CAP_REACHED";
  return {
    symbol: cfg?.symbol ?? row.id, id: row.id, underlying: row.underlying, underlyingB: row.underlyingB, power: row.power, token: row.token, gear: cfg?.gear ?? null,
    price: row.priceWad, valuePerToken: value.toString(), valueSource: row.lastValueWad !== null ? "trade" : "listing", nf: row.nf,
    tollPerDayBps: round6(toll), tollPer30DaysBps: round6(toll * 30n), holdersReceive: toll < 0n,
    tollFormulaBps: row.sigmaBps !== null ? round6(tollPerDayTwinWad(powerWad, BigInt(row.sigmaBps))) : null,
    sigmaBps: row.sigmaBps, sigmaAgeSec: sigmaAge, sigmaWarning: sigmaAge !== null && sigmaAge > SIGMA_MAX_AGE_SEC ? "floor" : null,
    spreadBps: row.spreadBps, cap: row.capUsd, openValue: open.toString(), status: row.status, session,
    buyable: reason === null, reason, sellMode: session === "OPEN" || session === "EXTENDED" ? "instant" : "instant_min",
    pausedBy: pause ? (pause.actor ?? "guardian") : null,
  };
}

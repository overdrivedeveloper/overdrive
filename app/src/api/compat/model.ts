// The website contract (web/src/services/contract.ts, from the team handoff) as pure rules: the 14 service error codes, how
// our API codes map onto them, and how each /v1 document becomes the shape the site reads. No I/O here, so every rule has
// a table test. Amounts stay integer strings; a value we do not have is null, never 0.
import { formatUnits } from "viem";
import type { Deployment } from "../../lib/deployments";

export const SERVICE_ERROR_CODES = [
  "WRONG_CHAIN", "NOT_DEPLOYED", "MARKET_CLOSED", "FEED_STALE", "FEED_PAUSED", "CAP_REACHED", "RACE_VOL_LIMIT", "INSUFFICIENT_BALANCE",
  "ALLOWANCE_REQUIRED", "QUOTE_EXPIRED", "SLIPPAGE_EXCEEDED", "INSUFFICIENT_COLLATERAL", "EXIT_QUEUED", "SERVICE_UNAVAILABLE",
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];
export interface ServiceError { code: ServiceErrorCode; message: string; retryable: boolean; retryAfterMs?: number }

const RETRYABLE: ReadonlySet<ServiceErrorCode> = new Set(["MARKET_CLOSED", "FEED_STALE", "FEED_PAUSED", "CAP_REACHED", "RACE_VOL_LIMIT", "QUOTE_EXPIRED", "SLIPPAGE_EXCEEDED", "SERVICE_UNAVAILABLE"]);
const MESSAGES: Record<ServiceErrorCode, string> = {
  WRONG_CHAIN: "This request names a different chain than the one this service reads.",
  NOT_DEPLOYED: "This gear or contract is not deployed on this network.",
  MARKET_CLOSED: "The market is closed: buys and backer minting wait for the next session.",
  FEED_STALE: "The price is not fresh enough to execute against.",
  FEED_PAUSED: "This feed or gear is paused.",
  CAP_REACHED: "This gear is at its open-value cap for this size.",
  RACE_VOL_LIMIT: "Race needs a fresh volatility reading at or below 40% for this market.",
  INSUFFICIENT_BALANCE: "The wallet does not hold enough for this amount, or the amount is below the minimum.",
  ALLOWANCE_REQUIRED: "An approval is needed before this transaction.",
  QUOTE_EXPIRED: "This quote has expired. Ask for a new one.",
  SLIPPAGE_EXCEEDED: "The price moved past your slippage limit.",
  INSUFFICIENT_COLLATERAL: "The vault would fall below its required collateral ratio.",
  EXIT_QUEUED: "A sell now is queued and paid at the next fresh price, never below your minimum.",
  SERVICE_UNAVAILABLE: "The service cannot answer this request right now.",
};

export function serviceError(code: ServiceErrorCode, message?: string, retryAfterMs?: number): ServiceError {
  return { code, message: message ?? MESSAGES[code], retryable: RETRYABLE.has(code), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

/** HTTP status of each code: 4xx for the caller's request, 409 for "valid but not now", 503 when we cannot serve. */
export const STATUS_OF: Record<ServiceErrorCode, 400 | 404 | 409 | 429 | 503> = {
  WRONG_CHAIN: 400, NOT_DEPLOYED: 404, MARKET_CLOSED: 409, FEED_STALE: 409, FEED_PAUSED: 409, CAP_REACHED: 409, RACE_VOL_LIMIT: 409,
  INSUFFICIENT_BALANCE: 409, ALLOWANCE_REQUIRED: 409, QUOTE_EXPIRED: 409, SLIPPAGE_EXCEEDED: 409, INSUFFICIENT_COLLATERAL: 409, EXIT_QUEUED: 409, SERVICE_UNAVAILABLE: 503,
};

export class CompatError extends Error {
  constructor(readonly body: ServiceError, readonly status: 400 | 404 | 409 | 429 | 503 = STATUS_OF[body.code]) {
    super(body.message);
    this.name = "CompatError";
  }
}

/**
 * Our /v1 error (`{ error, reason }`, from the oracle guard, the Governor or the route itself) as a service code.
 * MARKET_CLOSED and FEED_STALE come only from the guard's CLOSED / STALE readings (routes classify reverts with classifyRevert).
 */
export function fromApiError(code: string | null | undefined, reason: string | null | undefined, side: "buy" | "sell" | null = null): ServiceErrorCode {
  switch (code) {
    case "CLOSED": return "MARKET_CLOSED";
    case "STALE": return "FEED_STALE";
    case "PAUSED": return reason === "NOT_DEPLOYED" ? "NOT_DEPLOYED" : "FEED_PAUSED";
    case "CAP_REACHED": return "CAP_REACHED";
    case "BELOW_MIN": return reason === "UNDERCOLLATERALIZED" || reason === "MIN_COLLATERAL" ? "INSUFFICIENT_COLLATERAL" : "INSUFFICIENT_BALANCE";
    case "RESERVE_FLOOR": return side === "sell" ? "EXIT_QUEUED" : "SERVICE_UNAVAILABLE";
    case "QUEUED": return "EXIT_QUEUED";
    case "NOT_FOUND": return "NOT_DEPLOYED";
    default: return "SERVICE_UNAVAILABLE";
  }
}

// ---------- units ----------

/** "123.45" moved `places` to the left (bps -> percent is 2). Exact decimal text, no float. */
export function shiftDecimal(value: string, places: number): string {
  const negative = value.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? value.slice(1) : value).split(".");
  let digits = whole + frac;
  let point = whole.length - places;
  if (point <= 0) { digits = "0".repeat(1 - point) + digits; point = 1; }
  if (point > digits.length) { digits = digits + "0".repeat(point - digits.length); }
  let out = `${digits.slice(0, point)}.${digits.slice(point)}`.replace(/0+$/, "").replace(/\.$/, "").replace(/^0+(?=\d)/, "");
  if (out === "") out = "0";
  return negative && !/^0(\.0*)?$/.test(out) ? `-${out}` : out;
}
export const bpsToPct = (bps: string | number | null | undefined): string | null => (bps === null || bps === undefined ? null : shiftDecimal(String(bps), 2));
export const usdgText = (raw: string | null | undefined): string | null => (raw === null || raw === undefined ? null : formatUnits(BigInt(raw), 6));
export const wadText = (raw: string | null | undefined): string | null => (raw === null || raw === undefined ? null : formatUnits(BigInt(raw), 18));

// ---------- shapes ----------

export type Gear = "Cruise" | "Sport" | "Race" | "Eco" | "Reverse";
export type Availability = "available" | "not_deployed" | "closed" | "paused" | "stale" | "capacity_limited";
export interface Stamp { chainId: number; blockNumber: string; observedAt: string }
export interface Token { address: string; symbol: string; decimals: number }
export interface Amount { token: Token; baseUnits: string }
export interface Snapshot<T> { data: T | null; stamp: Stamp; stale: boolean; unavailableReason?: string }

export const gearTitle = (g: string | null | undefined): Gear | null => {
  const k = (g ?? "").toUpperCase();
  return k === "CRUISE" ? "Cruise" : k === "SPORT" ? "Sport" : k === "RACE" ? "Race" : k === "ECO" ? "Eco" : k === "REVERSE" ? "Reverse" : null;
};

export const stampOf = (deployment: Pick<Deployment, "chainId">, doc: { asOfBlock?: string; asOf?: string }, now: Date): Stamp => ({
  chainId: deployment.chainId, blockNumber: doc.asOfBlock ?? "0", observedAt: doc.asOf ?? now.toISOString(),
});
export const usdgToken = (d: Deployment): Token => ({ address: d.external.usdg, symbol: "USDG", decimals: 6 });
export const gearToken = (d: Deployment, symbol: string): Token | null => {
  const g = d.gears.find((x) => x.symbol === symbol);
  return g && /^0x[0-9a-fA-F]{40}$/.test(g.token) ? { address: g.token, symbol: g.symbol, decimals: 18 } : null;
};

/** Race on an index market needs a fresh volatility reading at or below 40% (spec: SPY/QQQ, all five gears, Race gated). */
export const RACE_VOL_UNDERLYINGS: readonly string[] = ["SPY", "QQQ"];
export const RACE_VOL_MAX_BPS = 4000;
export function raceVolBlocked(g: { gear: string | null; underlying: string; sigmaBps: string | null; sigmaWarning: string | null }, underlyings = RACE_VOL_UNDERLYINGS): boolean {
  if ((g.gear ?? "").toUpperCase() !== "RACE" || !underlyings.includes(g.underlying)) return false;
  return g.sigmaBps === null || g.sigmaWarning !== null || Number(g.sigmaBps) > RACE_VOL_MAX_BPS;
}
const raceEligible = (g: { underlying: string; sigmaBps: string | null; sigmaWarning: string | null }, underlyings = RACE_VOL_UNDERLYINGS) =>
  !raceVolBlocked({ gear: "RACE", underlying: g.underlying, sigmaBps: g.sigmaBps, sigmaWarning: g.sigmaWarning }, underlyings);

export interface GearDoc {
  symbol: string; id: string; underlying: string; power: string; token: string; gear: string | null; price: string | null; valuePerToken: string; nf: string;
  tollPerDayBps: string; tollFormulaBps: string | null; sigmaBps: string | null; sigmaWarning: string | null; spreadBps: number; cap: string; openValue: string;
  status: string; session: string; buyable: boolean; reason: string | null; sellMode: string; pausedBy: string | null;
}

export function availabilityOf(d: Deployment, g: GearDoc, underlyings = RACE_VOL_UNDERLYINGS): { availability: Availability; reason?: string } {
  if (!gearToken(d, g.symbol)) return { availability: "not_deployed", reason: "NOT_DEPLOYED" };
  if (g.reason === "PAUSED" || g.pausedBy) return { availability: "paused", reason: "FEED_PAUSED" };
  if (g.reason === "STALE") return { availability: "stale", reason: "FEED_STALE" };
  if (g.reason === "CLOSED") return { availability: "closed", reason: "MARKET_CLOSED" };
  if (g.reason === "CAP_REACHED") return { availability: "capacity_limited", reason: "CAP_REACHED" };
  if (raceVolBlocked(g, underlyings)) return { availability: "capacity_limited", reason: "RACE_VOL_LIMIT" };
  return g.buyable ? { availability: "available" } : { availability: "paused", reason: "FEED_PAUSED" };
}

export function marketGearOf(d: Deployment, g: GearDoc, underlyings = RACE_VOL_UNDERLYINGS) {
  const cfg = d.gears.find((x) => x.symbol === g.symbol);
  const a = availabilityOf(d, g, underlyings);
  const deployed = a.availability !== "not_deployed";
  return {
    id: g.symbol, underlying: g.underlying, gear: gearTitle(g.gear ?? cfg?.gear) ?? "Sport", power: g.power,
    token: gearToken(d, g.symbol), poolId: cfg?.poolId && /^0x[0-9a-fA-F]{64}$/.test(cfg.poolId) ? cfg.poolId : null,
    availability: a.availability, ...(a.reason ? { reason: a.reason } : {}),
    canBuy: a.availability === "available",
    canSell: deployed && a.availability !== "paused" && (g.sellMode === "instant" || g.sellMode === "instant_min"),
    canQueueSell: deployed && g.sellMode === "queued",
    capUsd: usdgText(g.cap) ?? "0", openValueUsd: usdgText(g.openValue), spreadBps: g.spreadBps,
  };
}

export function gearSnapshotOf(d: Deployment, g: GearDoc, observedAt: string, underlyings = RACE_VOL_UNDERLYINGS) {
  return {
    gearId: g.symbol, underlyingPrice: wadText(g.price), valuePerToken: wadText(g.valuePerToken), priceCurrency: "USDG" as const, normalisation: wadText(g.nf),
    annualVolatilityPct: bpsToPct(g.sigmaBps), dailyTollPct: bpsToPct(g.tollFormulaBps), usageDailyTollPct: bpsToPct(g.tollPerDayBps),
    availability: availabilityOf(d, g, underlyings).availability, feedUpdatedAt: observedAt, raceEligible: raceEligible(g, underlyings),
  };
}

export interface GovernorDoc {
  live: boolean; equityWad: string; hedgeStale: boolean; buysPaused: boolean; exitReserve: { balanceUsdg: string; floorUsdg: string };
  underlyings: Array<{ delta: string; gamma: string; hedgeDelta: string }>;
}
export function governorSnapshotOf(g: GovernorDoc) {
  const sum = (k: "delta" | "gamma" | "hedgeDelta") => g.underlyings.reduce((acc, u) => acc + BigInt(u[k]), 0n).toString();
  return {
    equityUsd: wadText(g.equityWad)!, exitReserveUsd: usdgText(g.exitReserve.balanceUsdg)!, exitReserveFloorUsd: usdgText(g.exitReserve.floorUsdg)!,
    deltaUsd: wadText(sum("delta"))!, gammaUsd: wadText(sum("gamma"))!, hedgeDeltaUsd: wadText(sum("hedgeDelta"))!,
    riskState: g.buysPaused ? ("paused" as const) : g.hedgeStale || !g.live ? ("reduced" as const) : ("normal" as const),
  };
}

export interface VaultDoc {
  id: string; owner: string; gear: string; status: string; collateralUsdg: string; debtTokens: string; healthRatioBps: string; computedRatioBps: string;
  requiredBps: string; maintenanceBps: string; belowMaintenance: boolean; weekendUplift: { active: boolean; upliftBps: number };
}
export function backerVaultOf(d: Deployment, v: VaultDoc) {
  const token = gearToken(d, v.gear) ?? { address: "0x0000000000000000000000000000000000000000", symbol: v.gear, decimals: 18 };
  const maint = BigInt(v.maintenanceBps);
  const computed = BigInt(v.computedRatioBps);
  return {
    id: v.id, owner: v.owner, gearId: v.gear, collateral: { token: usdgToken(d), baseUnits: v.collateralUsdg }, debt: { token, baseUnits: v.debtTokens },
    collateralRatioPct: BigInt(v.debtTokens) === 0n ? null : bpsToPct(v.computedRatioBps), initialRatioPct: bpsToPct(v.requiredBps)!, maintenanceRatioPct: bpsToPct(v.maintenanceBps)!,
    health: BigInt(v.debtTokens) === 0n || maint === 0n ? null : shiftDecimal(((computed * 10_000n) / maint).toString(), 4),
    weekendUpliftPct: bpsToPct(v.weekendUplift.active ? v.weekendUplift.upliftBps : 0)!,
    canMint: v.status === "open" && !v.belowMaintenance && computed > BigInt(v.requiredBps), status: v.status,
  };
}

export interface BalanceDoc { gear: string; token: string; balance: string; valueUsdg: string | null; tollPaidUsdg: string | null }
export function positionOf(d: Deployment, b: BalanceDoc) {
  return {
    gearId: b.gear, quantity: { token: gearToken(d, b.gear) ?? { address: b.token, symbol: b.gear, decimals: 18 }, baseUnits: b.balance },
    valueUsd: usdgText(b.valueUsdg), accruedTollUsd: usdgText(b.tollPaidUsdg),
  };
}

/** The bounded minimum for a slippage limit: floor(out * (10000 - bps) / 10000). */
export const minimumOf = (out: bigint, slippageBps: number): bigint => (out * BigInt(10_000 - slippageBps)) / 10_000n;
/** Expected USDG (6 dp) for a queued sell: the minter's own amount when it gives one (queued only because the exit reserve
 * cannot pay now), else the tokens (18 dp) at the minter's sell price per token (WAD, after the spread), the same maths a
 * sell paid now uses. null when the minter has no price: the estimate is then unavailable, never shown as 0. */
export function queuedSellEstimate(tokens: bigint, amountOut: string | null | undefined, pricePerTokenWad: string | null | undefined): bigint | null {
  const out = amountOut ? BigInt(amountOut) : 0n;
  if (out > 0n) return out;
  const price = pricePerTokenWad ? BigInt(pricePerTokenWad) : 0n;
  const est = (tokens * price) / 10n ** 30n;
  return est > 0n ? est : null;
}
/** The settlement rule a queued quote carries (the EXIT_QUEUED words). */
export const QUEUED_SETTLEMENT = serviceError("EXIT_QUEUED").message;

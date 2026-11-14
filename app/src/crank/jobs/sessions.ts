// R12, R13: pushes the NYSE calendar to IODMarketHours.setSessionsWithKinds and checks the weekend uplift.
import { encodeFunctionData, keccak256, stringToHex, type Hex } from "viem";
import { IODBackerAbi, IODMarketHoursAbi } from "../../abi";
import { raiseAlert } from "../alerts";
import type { CrankContext } from "../context";
import { contractAddress, sessionMarkets } from "../gears";
import { computeSessions, KIND_CODE, MAX_SESSIONS, mergeWindows, parseStoredKinded, type KindedSession, type Session } from "../sessions";

/** Push when the on-chain horizon is under this many days away. */
export const REFRESH_BEFORE_SECONDS = 7n * 86_400n;
/** Alert when the on-chain calendar has less than this left. */
export const HORIZON_ALERT_SECONDS = 3n * 86_400n;
/** IODBacker lead before a >= 24 h close (todo 07a DEFAULT_UPLIFT_LEAD) and the shortest closed stretch that gets an uplift. */
export const UPLIFT_LEAD_SECONDS = 2n * 3_600n;
export const MIN_CLOSED_FOR_UPLIFT_SECONDS = 24n * 3_600n;
/** Slack before the crank calls an uplift state wrong (the contract derives it from the same calendar on its own clock). */
const UPLIFT_GRACE_SECONDS = 300n;

export function sessionHash(sessions: readonly KindedSession[]): string {
  return keccak256(stringToHex(JSON.stringify(sessions.map((s) => [s.open.toString(), s.close.toString(), s.kind]))));
}

export function sessionsMeta(sessions: readonly KindedSession[]): Record<string, unknown> {
  return {
    sessionsHash: sessionHash(sessions),
    horizon: sessions.at(-1)?.close.toString() ?? "0",
    sessions: mergeWindows(sessions).map((s) => ({ open: s.open.toString(), close: s.close.toString() })),
    kinded: sessions.map((s) => ({ open: s.open.toString(), close: s.close.toString(), kind: s.kind })),
  };
}

// Compare trading hours only in the window already covered by BOTH calendars: expired intervals and an extension beyond that
// window need no transaction.
function sameCoverage(prior: readonly KindedSession[], next: readonly KindedSession[], now: bigint, end: bigint): boolean {
  const clip = (sessions: readonly KindedSession[]) => sessions
    .filter((s) => s.close > now && s.open < end)
    .map((s) => ({ open: s.open < now ? now : s.open, close: s.close > end ? end : s.close, kind: s.kind }));
  return sessionHash(clip(prior)) === sessionHash(clip(next));
}

/** What the contract holds, read from the chain (the chain is the truth, not the last push the crank remembers). */
export async function readOnChainCalendar(context: CrankContext): Promise<KindedSession[]> {
  const address = contractAddress(context, "ODMarketHours");
  const [sessions, kinds] = await Promise.all([
    context.clients.stateClient.readContract({ address, abi: IODMarketHoursAbi, functionName: "sessions" }),
    context.clients.stateClient.readContract({ address, abi: IODMarketHoursAbi, functionName: "sessionKinds" }),
  ]);
  return sessions.map((s, i) => ({ open: s.open, close: s.close, kind: Number(kinds[i]) === 1 ? "extended" : "regular" }));
}

export type UpliftFinding = { market: string; problem: "weekend_uplift_missing" | "weekend_uplift_still_on" };

/** Expected uplift state from the merged windows: on from `lead` before a close that lasts at least 24 h until the reopen,
 * off otherwise. Returns undefined inside the grace slack around a change. */
export function expectedUplift(windows: readonly Session[], nowSeconds: bigint): boolean | undefined {
  for (let i = 0; i < windows.length - 1; i++) {
    const closeAt = windows[i]!.close;
    const reopenAt = windows[i + 1]!.open;
    if (reopenAt - closeAt < MIN_CLOSED_FOR_UPLIFT_SECONDS) continue;
    const from = closeAt - UPLIFT_LEAD_SECONDS;
    if (nowSeconds >= from - UPLIFT_GRACE_SECONDS && nowSeconds < from + UPLIFT_GRACE_SECONDS) return undefined;
    if (nowSeconds >= from && nowSeconds < reopenAt) return nowSeconds >= from + UPLIFT_GRACE_SECONDS && nowSeconds < reopenAt ? true : undefined;
    if (nowSeconds >= reopenAt && nowSeconds < reopenAt + UPLIFT_GRACE_SECONDS) return undefined;
  }
  return false;
}

/** R13: reads `IODBacker.upliftActive(market)` for every stock market and compares it with the calendar. */
export async function checkUplift(context: CrankContext, nowSeconds: bigint, windows: readonly Session[]): Promise<UpliftFinding[]> {
  const backer = context.deployment.contracts.ODBacker;
  const markets = sessionMarkets(context.deployment).filter((m) => m.kind === "stock");
  if (!backer || !markets.length) return [];
  const expected = expectedUplift(windows, nowSeconds);
  if (expected === undefined) return [];
  const reads = await context.clients.stateClient.multicall({
    allowFailure: true,
    contracts: markets.map((m) => ({ address: backer as Hex, abi: IODBackerAbi, functionName: "upliftActive" as const, args: [m.id] as const })),
  });
  const findings: UpliftFinding[] = [];
  reads.forEach((read, i) => {
    if (read.status !== "success") return;
    const active = (read.result as readonly [boolean, number])[0];
    if (expected && !active) findings.push({ market: markets[i]!.symbol, problem: "weekend_uplift_missing" });
    if (!expected && active) findings.push({ market: markets[i]!.symbol, problem: "weekend_uplift_still_on" });
  });
  for (const f of findings) {
    await raiseAlert(context, { key: `${f.problem}:${f.market}`, level: "critical", text: `${f.problem} for ${f.market}: the backer weekend uplift does not match the calendar` });
  }
  return findings;
}

export function createSessionsJob(context: CrankContext) {
  return async (): Promise<Record<string, unknown>> => {
    const now = context.now(await context.metadata());
    const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
    const stockMarkets = sessionMarkets(context.deployment);
    // ETH and BTC are alwaysOpen markets: they get no windows. With no stock market listed there is nothing to push.
    if (!stockMarkets.length) return { calendarUpdateNeeded: false, noSessionMarkets: true };

    const next = computeSessions(now, "us_equity");
    if (next.length > MAX_SESSIONS) throw new Error("Session calendar exceeds the contract limit");
    const stored = await readOnChainCalendar(context);
    const horizon = stored.at(-1)?.close ?? 0n;
    const nextHorizon = next.at(-1)?.close ?? 0n;
    const overlapEnd = horizon < nextHorizon ? horizon : nextHorizon;
    const upliftFindings = await checkUplift(context, nowSeconds, mergeWindows(stored.length ? stored : next)).catch((error: unknown) => {
      context.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Weekend uplift check failed");
      return [] as UpliftFinding[];
    });
    const remaining = horizon - nowSeconds;
    if (stored.length > 0 && remaining < HORIZON_ALERT_SECONDS) {
      await raiseAlert(context, { key: "sessions_horizon_low", level: "warn", text: `The on-chain session calendar ends in ${remaining / 3600n} h; the crank will push a new one` });
    }
    if (stored.length && horizon - nowSeconds >= REFRESH_BEFORE_SECONDS && sameCoverage(stored, next, nowSeconds, overlapEnd)) {
      return { calendarUpdateNeeded: false, horizon: horizon.toString(), upliftFindings: upliftFindings.length };
    }
    const result = await context.tx.submit({
      label: "sessions", to: contractAddress(context, "ODMarketHours"),
      data: encodeFunctionData({
        abi: IODMarketHoursAbi, functionName: "setSessionsWithKinds",
        args: [next.map((s) => ({ open: s.open, close: s.close })), next.map((s) => KIND_CODE[s.kind as "regular" | "extended"])],
      }),
    });
    if (result.simulated) return { dryRun: true, proposedSessionsHash: sessionHash(next), calendarUpdateNeeded: true, upliftFindings: upliftFindings.length };
    return { ...sessionsMeta(next), dryRun: false, calendarUpdateNeeded: true, upliftFindings: upliftFindings.length };
  };
}

export { parseStoredKinded };

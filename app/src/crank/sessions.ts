// Pure calendar maths for the crank: NYSE 24/5 windows (overnight, pre-market, regular, post-market) with DST-safe New York
// boundaries, plus the merge and boundary helpers. Nothing here touches the chain or the clock.
import { CALENDAR_YEARS, EARLY_CLOSE_DATES, FULL_DAY_CLOSURES } from "./holidays";

export interface Session { open: bigint; close: bigint }
export type SessionKind = "regular" | "extended" | "always_on" | "closed";
export interface KindedSession extends Session { kind: SessionKind }

/** IODMarketHours limits (R12): at most 64 sessions, each under 7 days, the last close within 30 days. */
export const MAX_SESSIONS = 64;
export const MAX_SESSION_SECONDS = 7n * 86_400n - 1n;
export const MAX_HORIZON_SECONDS = 30n * 86_400n;
/** `Session` enum values the contract accepts in a pushed calendar (OPEN = regular, EXTENDED). */
export const KIND_CODE: Record<"regular" | "extended", number> = { regular: 0, extended: 1 };
export const MAX_UINT64 = 2n ** 64n - 1n;

const DAY = 86_400_000;
const ny = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function localParts(time: number): Record<string, number> {
  return Object.fromEntries(ny.formatToParts(time).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}
const dateKey = (calendarDay: number): string => new Date(calendarDay).toISOString().slice(0, 10);

const REGULAR_OPEN_MINUTE = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTE = 16 * 60;
const EARLY_CLOSE_MINUTE = 13 * 60;
const EXTENDED_END_MINUTE = 20 * 60;
const OVERNIGHT_END_MINUTE = 4 * 60;

/** Instant of `minute` (minutes after midnight, New York time) on the local calendar date encoded by `calendarDay`
 * (a date at UTC midnight, not a New York instant). Each boundary is converted separately so DST never assumes a fixed offset. */
export function etInstant(calendarDay: number, minute: number): bigint {
  const target = calendarDay + minute * 60_000;
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = localParts(instant);
    const represented = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
    const adjustment = target - represented;
    instant += adjustment;
    if (!adjustment) return BigInt(instant / 1000);
  }
  throw new Error("Could not resolve New York session boundary");
}

export function isTradingDay(calendarDay: number): boolean {
  const weekday = new Date(calendarDay).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if (!CALENDAR_YEARS.has(new Date(calendarDay).getUTCFullYear())) throw new Error("Session holiday calendar needs updating beyond 2026 to 2028");
  return !FULL_DAY_CLOSURES.has(dateKey(calendarDay));
}

/** US equity calendar: one entry per regular or extended stretch, the way `NyseCalendar.kindAt` classifies time.
 *   overnight 20:00 (previous evening) to 04:00 and pre-market 04:00 to 09:30 -> extended
 *   regular 09:30 to 16:00 (13:00 on an early close)                          -> regular
 *   post-market until 20:00                                                    -> extended
 * The evening before a full holiday and the holiday itself are gaps (closed). Neighbouring stretches of one kind merge.
 * The list starts with the stretch that contains `now` and stops at the 64-session or 30-day limit of the contract. */
function usEquity(now: Date, days: number): KindedSession[] {
  const p = localParts(now.getTime());
  const today = Date.UTC(p.year!, p.month! - 1, p.day!);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const limit = nowSeconds + BigInt(days) * 86_400n;
  const pieces: KindedSession[] = [];
  const push = (open: bigint, close: bigint, kind: "regular" | "extended") => {
    const last = pieces.at(-1);
    if (last && last.kind === kind && last.close === open) last.close = close;
    else pieces.push({ open, close, kind });
  };
  for (let day = today - DAY; day <= today + days * DAY + DAY; day += DAY) {
    if (!isTradingDay(day)) continue;
    const regularClose = EARLY_CLOSE_DATES.has(dateKey(day)) ? EARLY_CLOSE_MINUTE : REGULAR_CLOSE_MINUTE;
    push(etInstant(day - DAY, EXTENDED_END_MINUTE), etInstant(day, OVERNIGHT_END_MINUTE), "extended");
    push(etInstant(day, OVERNIGHT_END_MINUTE), etInstant(day, REGULAR_OPEN_MINUTE), "extended");
    push(etInstant(day, REGULAR_OPEN_MINUTE), etInstant(day, regularClose), "regular");
    push(etInstant(day, regularClose), etInstant(day, EXTENDED_END_MINUTE), "extended");
  }
  const result = pieces.filter((s) => s.close > nowSeconds && s.close <= limit).slice(0, MAX_SESSIONS);
  for (const s of result) if (s.close - s.open > MAX_SESSION_SECONDS) throw new Error("Session longer than the contract allows");
  return result;
}

/** The calendar to push for a market kind. `crypto` (ETH, BTC) is one open-ended always-on window and is never pushed
 * (those markets are `alwaysOpen` in the guard); `us_equity` is the 24/5 list above. */
export function computeSessions(now: Date, kind: "us_equity" | "crypto", days = 30): KindedSession[] {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(days) || days < 1 || days > 30) throw new Error("Session horizon must be 1 to 30 days and now must be a valid date");
  if (kind === "crypto") return [{ open: BigInt(Math.floor(now.getTime() / 1000)), close: MAX_UINT64, kind: "always_on" }];
  return usEquity(now, days);
}

/** Neighbouring sessions that touch merge into one window: the 24/5 "market is open" windows. */
export function mergeWindows(sessions: readonly Session[]): Session[] {
  const windows: Session[] = [];
  for (const session of sessions) {
    const last = windows.at(-1);
    if (last && last.close === session.open) last.close = session.close;
    else windows.push({ open: session.open, close: session.close });
  }
  return windows;
}

/** Every open or close of the merged windows after `now`, soonest first. */
export function nextBoundaries(sessions: readonly Session[], now: Date): { at: Date; kind: "open" | "close" }[] {
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const out: { at: Date; kind: "open" | "close" }[] = [];
  for (const window of mergeWindows(sessions)) {
    if (window.open > nowSeconds && window.open < MAX_UINT64) out.push({ at: new Date(Number(window.open) * 1000), kind: "open" });
    if (window.close > nowSeconds && window.close < MAX_UINT64) out.push({ at: new Date(Number(window.close) * 1000), kind: "close" });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Parses `{ open, close, kind }` strings from service_status.meta.kinded; undefined when anything is malformed. */
export function parseStoredKinded(value: unknown): KindedSession[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const out: KindedSession[] = [];
  for (const item of value as { open?: unknown; close?: unknown; kind?: unknown }[]) {
    if (!item || typeof item.open !== "string" || typeof item.close !== "string" || !/^\d+$/.test(item.open) || !/^\d+$/.test(item.close)) return undefined;
    if (item.kind !== "regular" && item.kind !== "extended") return undefined;
    const session = { open: BigInt(item.open), close: BigInt(item.close), kind: item.kind } as KindedSession;
    if (session.close <= session.open || (out.length && session.open < out.at(-1)!.close)) return undefined;
    out.push(session);
  }
  return out;
}

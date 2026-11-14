// R14: a deterministic venue for tests, dry runs and the boot test. Positions are kept in units (WAD) so marks move their
// USD value; fills take slippage against the trader, a partial fill ratio, funding per hour, a depth limit, a 24/7 flag,
// injected failures, and a "filled then timed out" failure for the idempotence test (R10).
import { USDG_TO_WAD, WAD } from "../../lib/fixed";
import type { IHedgeVenue, VenueFill, VenueName } from "../types";

export interface MockVenueOptions {
  name?: VenueName;
  /** WAD USD per unit, by underlying. An underlying without a mark is not listed. */
  marks: Record<string, bigint>;
  /** raw USDG collateral */
  collateralUsd?: bigint;
  slippageBps?: number;
  /** share of a request that fills, bps (10000 = all) */
  fillRatioBps?: number;
  /** paid by longs to shorts per hour, bps of notional (negative: shorts pay) */
  fundingBpsPerHour?: number;
  /** raw USDG visible per side; default unlimited */
  depthUsd?: bigint;
  /** true: trades every hour (HIP-3 style). false: only when `sessionOpen` says so. */
  alwaysOpen?: boolean;
  /** underlyings hedged on an index proxy */
  proxies?: string[];
  fundable?: boolean;
  postsEquity?: boolean;
}

type Failure = { kind: "throw"; error: Error } | { kind: "fill_then_timeout" };

export class MockVenue implements IHedgeVenue {
  readonly name: VenueName;
  readonly postsEquity: boolean;
  readonly fundable: boolean;
  readonly units = new Map<string, bigint>();
  readonly fills: (VenueFill & { underlying: string; clientId: string })[] = [];
  readonly calls = { trade: 0, lookup: 0 };
  sessionOpen = true;
  markAgeMs = 0;
  private cash: bigint;
  private failures: Failure[] = [];
  private health: { ok: boolean; reason?: string } = { ok: true };

  constructor(private readonly options: MockVenueOptions) {
    this.name = options.name ?? "mock";
    this.cash = options.collateralUsd ?? 10n ** 15n;
    this.postsEquity = options.postsEquity ?? true;
    this.fundable = options.fundable ?? false;
  }

  readonly basis = (underlying: string) => ({ proxy: (this.options.proxies ?? []).includes(underlying), ...((this.options.proxies ?? []).includes(underlying) ? { note: "index proxy" } : {}) });

  setMark(underlying: string, px: bigint): void { this.options.marks[underlying] = px; }
  setHealthy(ok: boolean, reason?: string): void { this.health = ok ? { ok } : { ok, reason: reason ?? "down" }; }
  /** The next trade throws `error`. */
  failNext(error = new Error("mock venue: injected failure")): void { this.failures.push({ kind: "throw", error }); }
  /** The next trade fills on the venue but the caller sees a timeout. */
  fillThenTimeoutNext(): void { this.failures.push({ kind: "fill_then_timeout" }); }
  deposit(usd: bigint): void { this.cash += usd; }

  private mark(underlying: string): bigint {
    const px = this.options.marks[underlying];
    if (px === undefined || px <= 0n) throw new Error(`mock venue: no market for ${underlying}`);
    return px;
  }

  canTrade(underlying: string): boolean {
    return this.options.marks[underlying] !== undefined && (this.options.alwaysOpen === true || this.sessionOpen);
  }

  async netPositionUsd(underlying: string): Promise<bigint> {
    const units = this.units.get(underlying) ?? 0n;
    if (units === 0n) return 0n;
    return (units * this.mark(underlying)) / WAD / USDG_TO_WAD;
  }

  async marginEquityUsd(): Promise<bigint> {
    let total = this.cash;
    for (const [u, units] of this.units) total += (units * this.mark(u)) / WAD / USDG_TO_WAD;
    return total;
  }

  async markPrice(underlying: string): Promise<{ px: bigint; ageMs: number }> {
    return { px: this.mark(underlying), ageMs: this.markAgeMs };
  }

  async maxTradeUsd(): Promise<bigint> { return this.options.depthUsd ?? 10n ** 18n; }

  async healthy(): Promise<{ ok: boolean; reason?: string }> { return this.health; }

  async fillByClientId(_underlying: string, clientId: string): Promise<VenueFill | null> {
    this.calls.lookup++;
    const f = this.fills.find((x) => x.clientId === clientId);
    return f ? { ref: f.ref, filledUsd: f.filledUsd, avgPx: f.avgPx, feesUsd: f.feesUsd } : null;
  }

  async trade(underlying: string, deltaUsd: bigint, opts: { maxSlippageBps: number; clientId: string }): Promise<VenueFill> {
    this.calls.trade++;
    const failure = this.failures.shift();
    if (failure?.kind === "throw") throw failure.error;
    if (!this.health.ok) throw new Error("mock venue: unhealthy");
    if (!this.canTrade(underlying)) throw new Error(`mock venue: ${underlying} market closed`);
    const slip = this.options.slippageBps ?? 0;
    if (slip > opts.maxSlippageBps) throw new Error("mock venue: slippage above the limit");
    if (this.fills.some((f) => f.clientId === opts.clientId)) throw new Error("mock venue: duplicate client id");
    const filledUsd = (deltaUsd * BigInt(this.options.fillRatioBps ?? 10_000)) / 10_000n;
    const mark = this.mark(underlying);
    const avgPx = filledUsd >= 0n ? (mark * BigInt(10_000 + slip)) / 10_000n : (mark * BigInt(10_000 - slip)) / 10_000n;
    const units = (filledUsd * USDG_TO_WAD * WAD) / avgPx;
    this.units.set(underlying, (this.units.get(underlying) ?? 0n) + units);
    this.cash -= filledUsd;
    const fill = { ref: `mock-${this.fills.length + 1}`, filledUsd, avgPx, feesUsd: 0n };
    this.fills.push({ ...fill, underlying, clientId: opts.clientId });
    if (failure?.kind === "fill_then_timeout") throw new Error("mock venue: request timed out");
    return fill;
  }

  /** Applies funding for `hours`: a positive rate means longs pay shorts. */
  accrueFunding(hours: number): void {
    const rate = BigInt(Math.round((this.options.fundingBpsPerHour ?? 0) * hours * 1e6));
    for (const [u, units] of this.units) {
      const notional = (units * this.mark(u)) / WAD / USDG_TO_WAD;
      this.cash -= (notional * rate) / (10_000n * 1_000_000n);
    }
  }
}

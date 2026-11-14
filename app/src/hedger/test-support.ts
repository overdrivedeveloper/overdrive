// Test fixtures for the hedger: a fake Governor (chain exposure), an indexed book that mirrors it unless told otherwise,
// and a deps builder with an in-memory store. Test-only; nothing here is imported by the service.
import pino from "pino";
import { createMemoryHedgerStore } from "../db/queries/hedges";
import { usdgToWad } from "../lib/fixed";
import type { ChainExposureReader, IndexedReader, IndexedRow } from "./exposure";
import type { HedgeMarket } from "./markets";
import type { CycleDeps } from "./service";
import { newHedgerState } from "./state";
import type { Exposure, HedgerSettings, Hex, IHedgeVenue } from "./types";

export const USD = (n: number | bigint): bigint => BigInt(n) * 1_000_000n;
export const silent = pino({ level: "silent" });

export const testSettings = (over: Partial<HedgerSettings> = {}): HedgerSettings => ({
  dryRun: false, bandBps: 50, hardBandBps: 200, intervalSeconds: 1800, cooldownSeconds: 120, minTradeUsd: USD(25),
  maxSlippageBps: 100, maxBookShareBps: 2500, cycleSeconds: 60, equityIntervalSeconds: 3600, gammaBudgetBps: 40,
  maxInputAgeSeconds: 900, maxVenueMarginUsd: 0n, initialMarginBps: 2000, proxyMaxBps: 1000, venueMarkMaxAgeMs: 60_000,
  disagreeBps: 50, disagreeFloorUsd: USD(25), ...over,
});

export const market = (symbol: string, alwaysOpen = false): HedgeMarket => ({
  market: `0x${Buffer.from(symbol).toString("hex").padEnd(64, "0")}` as Hex, symbol, kind: alwaysOpen ? "crypto" : "stock", alwaysOpen,
});

/** A fake Governor: raw USDG per symbol, equity shared. */
export class FakeGovernor implements ChainExposureReader {
  delta = new Map<string, bigint>();
  gamma = new Map<string, bigint>();
  equityUsd = USD(10_000_000);
  block = 100n;
  timestampMs = 0;
  unreadable = new Set<string>();
  reads: { symbol: string; block: bigint }[] = [];
  async head() { return { block: this.block, timestampMs: this.timestampMs }; }
  async exposure(m: Hex, symbol: string, block: bigint): Promise<Exposure> {
    this.reads.push({ symbol, block });
    if (this.unreadable.has(symbol)) throw new Error("execution reverted");
    return {
      market: m, symbol, deltaUsdWad: usdgToWad(this.delta.get(symbol) ?? 0n), gammaUsdWad: usdgToWad(this.gamma.get(symbol) ?? 0n),
      openValueWad: 0n, equityWad: usdgToWad(this.equityUsd), asOfBlock: block, source: "chain",
    };
  }
}

/** Mirrors the fake Governor (same block, now) unless an override is set for the symbol. */
export class FakeIndexed implements IndexedReader {
  override = new Map<string, IndexedRow | null>();
  constructor(private readonly gov: FakeGovernor, private readonly now: () => number) {}
  async latest(symbol: string, atOrBefore: bigint): Promise<IndexedRow | null> {
    if (this.override.has(symbol)) return this.override.get(symbol)!;
    return { block: atOrBefore, ts: new Date(this.now()), deltaUsd: this.gov.delta.get(symbol) ?? 0n, gammaUsd: this.gov.gamma.get(symbol) ?? 0n, equityUsd: this.gov.equityUsd };
  }
}

export function makeDeps(opts: { markets: HedgeMarket[]; venues: IHedgeVenue[]; settings?: Partial<HedgerSettings>; nowMs?: number }) {
  const clock = { now: opts.nowMs ?? 1_800_000_000_000 };
  const gov = new FakeGovernor();
  gov.timestampMs = clock.now;
  const indexed = new FakeIndexed(gov, () => clock.now);
  const mem = createMemoryHedgerStore();
  const markAge = new Map<string, number>();
  const deps: CycleDeps = {
    markets: opts.markets, chain: gov, indexed, venues: opts.venues, store: mem.store, settings: testSettings(opts.settings),
    state: newHedgerState(), now: () => clock.now, logger: silent,
    markAgeMs: async (m) => markAge.get(m.symbol) ?? 0,
  };
  /** Moves the clock and keeps the chain head current. */
  const advance = (ms: number) => { clock.now += ms; gov.timestampMs = clock.now; gov.block += 1n; };
  return { deps, gov, indexed, mem, markAge, clock, advance };
}

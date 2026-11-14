// A deterministic stand-in for ODHook + IODMinter + V4Quoter, until todos 05 and 06 are built. It follows the contract
// interfaces (Quote struct, error names) and has three entry points that share one pricing rule: `minterQuote`, `v4Quote`
// and `execute`. The fork variant of the parity test replaces it with the real contracts.
import { WAD, USDG_TO_WAD } from "../lib/fixed";
import type { ApiChain, BackerHealth, ChainQuoter, QuoteInput } from "../api/chain-reads";
import type { BlockQuote, RawQuote } from "../api/quote/model";
import { closedSellValue } from "../api/quote/model";

export class MockRevert extends Error {
  constructor(readonly errorName: string, readonly args: readonly unknown[] = []) { super(`MockRevert ${errorName}`); }
}
const b32 = (text: string): `0x${string}` => `0x${Buffer.from(text).toString("hex").padEnd(64, "0")}`;

export interface MockGear {
  id: string;
  valueWad: bigint;          // value per token, USD WAD
  lastValueWad: bigint;      // last live value (closed-market sells)
  refValueWad: bigint;       // reference (pool) value; 0 = none
  spreadBps: number;
  session: number;           // Session enum
  fresh: boolean;
  status: "LISTED" | "BUYS_PAUSED" | "SELL_ONLY" | "SETTLED";
  splitPending: boolean;
  capUsdg: bigint;           // cap, USDG 6 dp
  openUsdg: bigint;
  minTradeUsdg: bigint;
  tollPerDayWad: bigint;
}
export interface MockBook { reserveUsdg: bigint; floorUsdg: bigint; freeCashUsdg: bigint }

export class MockHook {
  block = 1_000n;
  constructor(readonly gears: Map<string, MockGear>, readonly book: MockBook) {}

  private gear(id: string): MockGear {
    const g = this.gears.get(id.toLowerCase());
    if (!g) throw new MockRevert("NotGearPool");
    return g;
  }

  /** The one pricing rule. Throws the same errors the contracts do. */
  private price(i: QuoteInput): RawQuote {
    const g = this.gear(i.gear);
    const closed = g.session >= 2;
    if (i.side === "buy") {
      if (g.status !== "LISTED") throw new MockRevert("BuysClosed", [i.gear, b32("MANUAL")]);
      if (g.splitPending) throw new MockRevert("BuysClosed", [i.gear, b32("SPLIT_PENDING")]);
      if (!g.fresh) throw new MockRevert("BuysClosed", [i.gear, b32("STALE")]);
      if (closed) throw new MockRevert("BuysClosed", [i.gear, b32(g.session === 4 ? "HALTED" : "CLOSED")]);
      if (this.book.reserveUsdg < this.book.floorUsdg) throw new MockRevert("BuysPaused", [b32("RESERVE_FLOOR")]);
      if (i.exactIn < g.minTradeUsdg) throw new MockRevert("BelowMinimum");
      if (g.openUsdg + i.exactIn > g.capUsdg) throw new MockRevert("CapExceeded", [i.gear, g.openUsdg + i.exactIn, g.capUsdg]);
      const price = (g.valueWad * BigInt(10_000 + g.spreadBps)) / 10_000n;
      const tokens = (i.exactIn * USDG_TO_WAD * WAD) / price;
      return { amountIn: i.exactIn, amountOut: tokens, valuePerTokenWad: g.valueWad, pricePerTokenWad: price, spreadBps: g.spreadBps, protocolFeeUsdg: 0n, tollPerDayWad: g.tollPerDayWad, session: g.session, queued: false };
    }
    const value = closed ? closedSellValue(g.lastValueWad, g.refValueWad) : g.valueWad;
    const price = (value * BigInt(10_000 - g.spreadBps)) / 10_000n;
    const usdg = (i.exactIn * price) / WAD / USDG_TO_WAD;
    const payable = this.book.freeCashUsdg + this.book.reserveUsdg;
    const queued = (closed && g.refValueWad === 0n) || usdg > payable;
    return { amountIn: i.exactIn, amountOut: queued ? 0n : usdg, valuePerTokenWad: value, pricePerTokenWad: price, spreadBps: g.spreadBps, protocolFeeUsdg: 0n, tollPerDayWad: g.tollPerDayWad, session: g.session, queued };
  }

  /** IODMinter.quote: a revert becomes a thrown MockRevert, a queued sell comes back with queued = true. */
  minterQuote(i: QuoteInput): BlockQuote { return { ...this.price(i), blockNumber: this.block }; }
  /** V4Quoter through the hook: amounts only. A queued sell reverts UseQueue on this path, as on the real hook. */
  v4Quote(i: QuoteInput): RawQuote & { blockNumber: bigint } {
    const q = this.price(i);
    if (q.queued) throw new MockRevert("UseQueue");
    return { ...q, valuePerTokenWad: null, pricePerTokenWad: null, spreadBps: null, protocolFeeUsdg: null, tollPerDayWad: null, session: null, blockNumber: this.block };
  }
  /** Executes the swap in the same block: the amounts actually received. */
  execute(i: QuoteInput): { amountIn: bigint; amountOut: bigint } {
    const q = this.price(i);
    if (q.queued) throw new MockRevert("UseQueue");
    const g = this.gear(i.gear);
    if (i.side === "buy") { g.openUsdg += i.exactIn; this.book.freeCashUsdg += i.exactIn; }
    else { const paid = q.amountOut; const fromCash = paid < this.book.freeCashUsdg ? paid : this.book.freeCashUsdg; this.book.freeCashUsdg -= fromCash; this.book.reserveUsdg -= paid - fromCash; g.openUsdg = g.openUsdg > paid ? g.openUsdg - paid : 0n; }
    return { amountIn: q.amountIn, amountOut: q.amountOut };
  }

  /** An ApiChain whose reads count calls (`calls`) and optionally wait (`delayMs`) so coalescing is observable. */
  asChain(extra: Partial<ApiChain> = {}, options: { delayMs?: number } = {}): ApiChain & { calls: { quote: number; minter: number; other: number } } {
    const calls = { quote: 0, minter: 0, other: 0 };
    const wait = () => (options.delayMs ? new Promise<void>((r) => setTimeout(r, options.delayMs)) : Promise.resolve());
    const quoter: ChainQuoter = { quote: async (i) => { calls.quote++; await wait(); return this.v4Quote(i); } };
    const never = (name: string) => async (): Promise<never> => { calls.other++; throw new Error(`mock chain: ${name} not provided`); };
    const chain: ApiChain & { calls: typeof calls } = {
      calls,
      blockNumber: async () => { calls.other++; return this.block; },
      quoter,
      minterQuote: async (i) => { calls.minter++; await wait(); return this.minterQuote(i); },
      minterTollPerDay: async (id) => { calls.other++; return this.gear(id).tollPerDayWad; },
      governor: {
        equity: never("equity"), freeCash: async () => { calls.other++; return this.book.freeCashUsdg; }, stressLoss: never("stressLoss"), hedgeStale: never("hedgeStale"),
        buysPaused: async () => { calls.other++; return { paused: false, reason: "" }; }, exposure: never("exposure"),
        exitReserve: async () => { calls.other++; return this.book.reserveUsdg; }, exitReserveFloor: async () => { calls.other++; return this.book.floorUsdg; },
      },
      backerHealth: never("backerHealth") as unknown as (v: bigint) => Promise<BackerHealth>,
      feeSplits: async () => { calls.other++; return { protocolSpreadShareBps: 1000, tollFeeBps: 1000, distributable: 0n, nextDistributionAt: 0n }; },
      upliftActive: async () => { calls.other++; return { active: false, upliftBps: 0 }; },
      backerVault: never("backerVault") as unknown as ApiChain["backerVault"],
      backerBatchWindow: never("backerBatchWindow") as unknown as ApiChain["backerBatchWindow"],
      backerMintPaused: async () => { calls.other++; return false; },
      backerIsOperator: async () => { calls.other++; return false; },
      queuedSell: never("queuedSell") as unknown as ApiChain["queuedSell"],
      ...extra,
    };
    return chain;
  }
}

export function mockGear(id: string, over: Partial<MockGear> = {}): MockGear {
  return { id, valueWad: 100n * WAD, lastValueWad: 100n * WAD, refValueWad: 99n * WAD, spreadBps: 40, session: 0, fresh: true, status: "LISTED", splitPending: false,
    capUsdg: 1_000_000_000_000n, openUsdg: 0n, minTradeUsdg: 1_000_000n, tollPerDayWad: 986_300_000_000_000n, ...over };
}
export const mockBook = (over: Partial<MockBook> = {}): MockBook => ({ reserveUsdg: 500_000_000_000n, floorUsdg: 100_000_000_000n, freeCashUsdg: 500_000_000_000n, ...over });

export function mockHookFor(deployment: { gears: ReadonlyArray<{ id: string }> }, gearOver: Partial<MockGear> = {}, book: Partial<MockBook> = {}): MockHook {
  return new MockHook(new Map(deployment.gears.map((g) => [g.id.toLowerCase(), mockGear(g.id.toLowerCase(), gearOver)])), mockBook(book));
}


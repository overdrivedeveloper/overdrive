// The quote service. The executable path is V4Quoter through the hook (`source: "v4_quoter"`); IODMinter.quote is asked in
// parallel and the two are compared field by field. At most `maxRpc` chain calls per request, identical in-flight requests
// are coalesced and an answer is kept `cacheMs` (the amount is part of the key, so a cached quote is never for another size).
import { createHash } from "node:crypto";
import type { TtlCache } from "../cache";
import type { ApiChain, QuoteInput } from "../chain-reads";
import { decodeRevert } from "../../chain/revert";
import { ApiError } from "../errors";
import { parityFailures as parityFailuresOrNone } from "./parity";
import { classifyRevert, minOutSuggested, queuedMinOut, sellModeOf, type BlockQuote, type RawQuote, type Refusal, type SellMode, type Side } from "./model";

export interface QuoteOutcome {
  gearId: string;
  side: Side;
  blockNumber: bigint;
  /** null when the trade cannot execute (no price is shown for a closed or stale buy). */
  v4: RawQuote | null;
  /** "v4_quoter" when the hook route executes; "minter" when a sell executes on the direct IODMinter.sell path (I9-3: the
   * hook route was short of tokens); null when the trade cannot execute. */
  source: "v4_quoter" | "minter" | null;
  minter: RawQuote | null;
  refusal: Refusal | null;
  buyable: boolean;
  sellMode: SellMode | null;
  parity: string[];
  minOutSuggested: bigint | null;
  quoteId: string;
  asOfMs: number;
}

export interface QuoteServiceOptions { chain: ApiChain; cache: TtlCache; maxRpc: number; cacheMs: number; now: () => number }

type Revertish = { errorName: string; args: readonly unknown[] };
function revertOf(error: unknown): Revertish | undefined {
  const record = error as Partial<Revertish> | null;
  if (record && typeof record.errorName === "string" && Array.isArray(record.args)) return record as Revertish;
  const decoded = decodeRevert(error);
  return decoded ? { errorName: decoded.name, args: decoded.args } : undefined;
}

export function createQuoteService(options: QuoteServiceOptions) {
  async function load(i: QuoteInput): Promise<QuoteOutcome> {
    let rpc = 0;
    const meter = <T>(call: () => Promise<T>): Promise<T> => {
      if (++rpc > options.maxRpc) throw new Error("quote RPC budget exceeded");
      return call();
    };
    const settle = async <T>(call: () => Promise<T>): Promise<{ ok: T } | { revert: Revertish }> => {
      try { return { ok: await meter(call) }; } catch (error) {
        const revert = revertOf(error);
        if (revert) return { revert };
        throw new ApiError(502, "UPSTREAM", "The chain could not be read right now.");
      }
    };
    const [v4, minter] = await Promise.all([settle(() => options.chain.quoter.quote(i)), settle(() => options.chain.minterQuote(i))]);
    const base = { gearId: i.gear, side: i.side, asOfMs: options.now() };
    const quoteId = (block: bigint, out: bigint) => createHash("sha256").update(`${i.gear}:${i.side}:${i.exactIn}:${block}:${out}`).digest("hex").slice(0, 32);
    const refuse = (refusal: Refusal, block: bigint, minterRaw: RawQuote | null = null): QuoteOutcome => ({
      ...base, blockNumber: block, v4: null, source: null, minter: minterRaw, refusal, buyable: false, sellMode: null, parity: [], minOutSuggested: null, quoteId: quoteId(block, 0n),
    });
    const block = "ok" in minter ? minter.ok.blockNumber : "ok" in v4 ? v4.ok.blockNumber : 0n;

    if ("revert" in v4) {
      const refusal = classifyRevert(v4.revert.errorName, v4.revert.args);
      const poolShort = i.side === "sell" && v4.revert !== undefined && refusal.reason === "PoolManagerShort";
      if (poolShort && "ok" in minter && !minter.ok.queued && minter.ok.amountOut > 0n) {
        // I9-3: the hook can only front what the PoolManager holds (accepted risk L-7). The minter pays a sell of any size
        // itself, so the executable path is IODMinter.sell: the intent route builds that call with this quote's minimum.
        const m = minter.ok;
        return { ...base, blockNumber: m.blockNumber, v4: null, source: "minter", minter: m, refusal: null, buyable: true, sellMode: sellModeOf(m), parity: [], minOutSuggested: minOutSuggested(m.amountOut), quoteId: quoteId(m.blockNumber, m.amountOut) };
      }
      if (refusal.code === "QUEUED" || (poolShort && "ok" in minter && minter.ok.queued)) {
        // A sell the hook cannot pay now: the minter's own quote carries the queue terms (the next-fresh-price rule).
        if ("ok" in minter && minter.ok.queued) {
          const m = minter.ok;
          // I8-2: a closed or halted market quotes amountOut 0. The suggested minimum then comes from the last good
          // value, never 0: a ticket is filled by anyone at the next live price.
          const read = options.chain.minterValuePerToken;
          const last = m.amountOut > 0n || !read ? null : await (async () => meter(() => read(i.gear)))().catch(() => null);
          return { ...base, blockNumber: m.blockNumber, v4: null, source: null, minter: m, refusal: refusal.code === "QUEUED" ? refusal : { code: "QUEUED", reason: "USE_QUEUE" }, buyable: false, sellMode: "queued", parity: [], minOutSuggested: queuedMinOut(i.exactIn, m.amountOut, last), quoteId: quoteId(m.blockNumber, m.amountOut) };
        }
        return refuse({ code: "UPSTREAM", reason: "PARITY_MISMATCH" }, block);
      }
      return refuse(refusal, block);
    }
    // The executable path says it can run. The minter must agree, field by field; if not, fail closed.
    if ("revert" in minter) return refuse({ code: "UPSTREAM", reason: "PARITY_MISMATCH" }, v4.ok.blockNumber);
    const parity = parityFailuresOrNone(v4.ok, minter.ok);
    if (parity.length) return { ...refuse({ code: "UPSTREAM", reason: "PARITY_MISMATCH" }, v4.ok.blockNumber, minter.ok), parity };
    const out = v4.ok.amountOut;
    return {
      ...base, blockNumber: v4.ok.blockNumber, v4: v4.ok, source: "v4_quoter", minter: minter.ok, refusal: null, buyable: true,
      sellMode: i.side === "sell" ? sellModeOf(minter.ok) : null, parity: [], minOutSuggested: minOutSuggested(out), quoteId: quoteId(v4.ok.blockNumber, out),
    };
  }

  return {
    quote(i: QuoteInput): Promise<QuoteOutcome> {
      // Exact amount in the key: a quote is only ever reused for the identical trade. The tier keeps account-specific answers apart.
      const key = `quote:${i.gear}:${i.side}:${i.exactIn}:${i.account ? "acct" : "anon"}`;
      return options.cache.getOrLoad(key, options.cacheMs, () => load(i));
    },
  };
}
export type QuoteService = ReturnType<typeof createQuoteService>;
export type { BlockQuote };

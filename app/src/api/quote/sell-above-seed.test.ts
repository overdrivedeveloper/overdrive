// I9-3 regression (independent audit 9). The hook can only front the input token the PoolManager holds (ODHook
// PoolManagerShort, accepted risk L-7; mainnet seeds one token per gear). A sell above that used to be refused as
// UPSTREAM although IODMinter.sell pays it. The quote service now answers such a sell from the minter (direct path).
import { expect, test } from "bun:test";
import { encodeErrorResult, parseAbi } from "viem";
import { TtlCache } from "../cache";
import { classifyRevert, type BlockQuote } from "./model";
import { createQuoteService } from "./quoter";

const GEAR = `0x${"11".repeat(32)}`;
const TOKEN = `0x${"22".repeat(20)}` as const;
const HOOK = `0x${"33".repeat(20)}` as const;
const SEED = 10n ** 18n; // script/config/mainnet.json hookSeed.gearWadPerGear
const hookAbi = parseAbi(["error PoolManagerShort(address token, uint256 have, uint256 need)"]);

/** What the chain answers: the minter prices any size; the hook path reverts above what the PoolManager holds. */
function chain() {
  const price = 99n * 10n ** 16n; // 0.99 USDG per token after spread
  const minterQuote = async (i: { exactIn: bigint }): Promise<BlockQuote> => ({
    amountIn: i.exactIn, amountOut: (i.exactIn * price) / 10n ** 30n, valuePerTokenWad: 10n ** 18n, pricePerTokenWad: price,
    spreadBps: 100, protocolFeeUsdg: 0n, tollPerDayWad: 0n, session: 0, queued: false, blockNumber: 7n,
  });
  return {
    minterQuote,
    quoter: {
      async quote(i: { exactIn: bigint }): Promise<BlockQuote> {
        if (i.exactIn > SEED) {
          const inner = encodeErrorResult({ abi: hookAbi, errorName: "PoolManagerShort", args: [TOKEN, SEED, i.exactIn] });
          // Uniswap v4 wraps a hook revert: WrappedError(target, selector, reason, details)
          throw { errorName: "WrappedError", args: [HOOK, "0x575e24b4", inner, "0x"] };
        }
        const m = await minterQuote(i);
        return { ...m, valuePerTokenWad: null, pricePerTokenWad: null, spreadBps: null, protocolFeeUsdg: null, tollPerDayWad: null, session: null };
      },
    },
  };
}
const service = () => createQuoteService({ chain: chain() as never, cache: new TtlCache(), maxRpc: 3, cacheMs: 0, now: () => 1_800_000_000_000 });

test("control: a sell of the seed (one token) is quoted on the hook path, unchanged", async () => {
  const o = await service().quote({ gear: GEAR, side: "sell", exactIn: SEED });
  expect(o.buyable).toBe(true);
  expect(o.sellMode).toBe("instant");
  expect(o.source).toBe("v4_quoter");
  expect(o.v4).not.toBeNull();
});

test("a 100 token sell above the seed is executable on the direct minter path with the quoted minimum", async () => {
  const o = await service().quote({ gear: GEAR, side: "sell", exactIn: 100n * SEED });
  expect(o.buyable).toBe(true);
  expect(o.refusal).toBeNull();
  expect(o.source).toBe("minter");
  expect(o.v4).toBeNull();
  expect(o.sellMode).toBe("instant");
  expect(o.minter?.amountOut).toBe(99_000_000n);
  expect(o.minOutSuggested).toBe((99_000_000n * 9_950n) / 10_000n);
});

test("a buy above the seed keeps its behaviour: still refused UPSTREAM, never moved to the minter", async () => {
  const hookShortOnBuy = chain();
  hookShortOnBuy.quoter.quote = async () => { throw { errorName: "WrappedError", args: [HOOK, "0x575e24b4", encodeErrorResult({ abi: hookAbi, errorName: "PoolManagerShort", args: [TOKEN, 1n, 2n] }), "0x"] }; };
  const o = await createQuoteService({ chain: hookShortOnBuy as never, cache: new TtlCache(), maxRpc: 3, cacheMs: 0, now: () => 1_800_000_000_000 }).quote({ gear: GEAR, side: "buy", exactIn: 5_000_000n });
  expect(o.buyable).toBe(false);
  expect(o.source).toBeNull();
  expect(o.refusal?.code).toBe("UPSTREAM");
});

test("a short hook with a queued minter quote still takes the queue path", async () => {
  const c = chain();
  const direct = c.minterQuote;
  c.minterQuote = async (i) => ({ ...(await direct(i)), queued: true, amountOut: 0n });
  const o = await createQuoteService({ chain: { ...c, minterQuote: c.minterQuote } as never, cache: new TtlCache(), maxRpc: 3, cacheMs: 0, now: () => 1_800_000_000_000 }).quote({ gear: GEAR, side: "sell", exactIn: 100n * SEED });
  expect(o.sellMode).toBe("queued");
  expect(o.buyable).toBe(false);
  expect(o.source).toBeNull();
});

test("PoolManagerShort has its own case in classifyRevert and is still UPSTREAM", () => {
  expect(classifyRevert("PoolManagerShort", [TOKEN, SEED, 2n * SEED])).toEqual({ code: "UPSTREAM", reason: "PoolManagerShort" });
});

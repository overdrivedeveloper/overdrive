import { expect, test } from "bun:test";
import { encodeErrorResult } from "viem";
import { IODMinterAbi } from "../../abi";
import { decodeRevert, WRAPPED_ERROR_ABI } from "../../chain/revert";
import { breakevenDays, classifyRevert, closedSellValue, minOutSuggested, sellModeOf, tollBpsText } from "./model";
import { mockBook, mockGear, WAD, idOf } from "../test-support";
import { MockHook } from "../../testing/mock-hook";

const b32 = (t: string) => `0x${Buffer.from(t).toString("hex").padEnd(64, "0")}`;

test("closed_sell_is_min_of_last_and_pool_or_queued", () => {
  expect(closedSellValue(100n, 90n)).toBe(90n);
  expect(closedSellValue(80n, 90n)).toBe(80n);
  const id = idOf("g");
  // closed with a reference value: instant_min, paying the lower value; the minter's own quote carries the same number
  const closed = new MockHook(new Map([[id, mockGear(id, { session: 2, lastValueWad: 100n * WAD, refValueWad: 90n * WAD, spreadBps: 0 })]]), mockBook());
  const q = closed.minterQuote({ gear: id, side: "sell", exactIn: WAD });
  expect(q.valuePerTokenWad).toBe(90n * WAD);
  expect(q.amountOut).toBe(90_000_000n); // 1 token at 90 USD, USDG 6 dp
  expect(sellModeOf(q)).toBe("instant_min");
  // closed and no reference value: queued (the minter's queued flag), paid at the next fresh price
  const noRef = new MockHook(new Map([[id, mockGear(id, { session: 2, refValueWad: 0n })]]), mockBook());
  expect(sellModeOf(noRef.minterQuote({ gear: id, side: "sell", exactIn: WAD }))).toBe("queued");
  // cannot be paid now (nothing in cash or reserve): queued as well
  const broke = new MockHook(new Map([[id, mockGear(id)]]), mockBook({ freeCashUsdg: 0n, reserveUsdg: 0n }));
  expect(sellModeOf(broke.minterQuote({ gear: id, side: "sell", exactIn: WAD }))).toBe("queued");
  expect(() => broke.v4Quote({ gear: id, side: "sell", exactIn: WAD })).toThrow("UseQueue");
  // open: instant
  expect(sellModeOf({ queued: false, session: 0 })).toBe("instant");
});

test("revert names map to API codes, unknown fails closed", () => {
  expect(classifyRevert("BuysClosed", [idOf("g"), b32("STALE")]).code).toBe("STALE");
  expect(classifyRevert("BuysClosed", [idOf("g"), b32("CLOSED")]).code).toBe("CLOSED");
  expect(classifyRevert("BuysClosed", [idOf("g"), b32("SPLIT_PENDING")])).toEqual({ code: "PAUSED", reason: "SPLIT_PENDING" });
  expect(classifyRevert("CapExceeded", []).code).toBe("CAP_REACHED");
  expect(classifyRevert("BelowMinimum", []).code).toBe("BELOW_MIN");
  expect(classifyRevert("BuysPaused", [b32("RESERVE_FLOOR")]).code).toBe("RESERVE_FLOOR");
  expect(classifyRevert("SomethingNew", []).code).toBe("UPSTREAM");
});

test("breakeven days is spread over toll; a negative toll has none and says holders receive", () => {
  expect(breakevenDays(40, 986_300_000_000_000n)).toBeCloseTo(40 / 9.863, 1);
  expect(breakevenDays(40, -(10n ** 14n))).toBeNull();
  expect(tollBpsText(-(10n ** 14n))).toBe("-1");
  expect(minOutSuggested(10_000n)).toBe(9_950n);
});

test("classify_unwraps_the_v4_wrapped_errors", () => {
  const inner = encodeErrorResult({ abi: IODMinterAbi, errorName: "BuysClosed", args: [idOf("g") as `0x${string}`, b32("CLOSED") as `0x${string}`] });
  const useQueue = encodeErrorResult({ abi: IODMinterAbi, errorName: "UseQueue" });
  const wrap = (reason: `0x${string}`) => encodeErrorResult({ abi: WRAPPED_ERROR_ABI, errorName: "WrappedError", args: ["0x00000000000000000000000000000000000000c3", "0x7e87ce7d", reason, "0x1234"] });
  const unexpected = (data: `0x${string}`) => encodeErrorResult({ abi: WRAPPED_ERROR_ABI, errorName: "UnexpectedRevertBytes", args: [data] });
  const classify = (data: `0x${string}`) => { const d = decodeRevert({ data })!; return classifyRevert(d.name, d.args); };
  expect(classify(wrap(inner)).code).toBe("CLOSED");
  expect(classify(wrap(useQueue)).code).toBe("QUEUED");
  expect(classify(unexpected(wrap(inner))).code).toBe("CLOSED"); // the live V4Quoter shape (0x6190b2b0)
  expect(unexpected("0x").slice(0, 10)).toBe("0x6190b2b0");
  expect(classify(wrap("0xdeadbeef")).code).toBe("UPSTREAM");
});

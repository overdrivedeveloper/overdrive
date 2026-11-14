import { describe, expect, test } from "bun:test";
import { formatUnits, minOutFor, OverdriveIntentMismatch, Overdrive, parseUnits, quoteExpired, summarizeQuote, verifyIntent, DEPLOYMENTS, type DeploymentAddresses, type QuoteResponse } from "../src";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const dep: DeploymentAddresses = {
  chainId: 4663, network: "test", external: { usdg: A(1), permit2: A(2) },
  contracts: { ODMinter: A(0xa), ODHook: A(0xb), ODFees: "" },
  gears: [{ id: "g", symbol: "TSLA-SPORT", token: A(0xc), poolId: "0x" }],
};
const good = { tx: { to: A(0xa), value: "0" }, approvals: [{ token: A(1), spender: A(0xa) }] };

describe("units", () => {
  test("parse and format round trip, exact", () => {
    expect(parseUnits("25.5", 6)).toBe(25_500_000n);
    expect(formatUnits(25_500_000n, 6)).toBe("25.5");
    expect(formatUnits("1", 18)).toBe("0.000000000000000001");
    expect(formatUnits(-1_500_000n, 6)).toBe("-1.5");
    expect(parseUnits("0", 6)).toBe(0n);
  });
  test("rejects over-precise and malformed amounts", () => {
    expect(() => parseUnits("1.0000001", 6)).toThrow(RangeError);
    for (const bad of ["", "-1", "1e3", "abc", "1.2.3"]) expect(() => parseUnits(bad, 6)).toThrow(TypeError);
  });
  test("minOutFor rounds down and validates bps", () => {
    expect(minOutFor(1_000_001n, 50)).toBe(995_000n);
    expect(minOutFor("100", 0)).toBe(100n);
    expect(() => minOutFor(1n, 10_001)).toThrow(RangeError);
    expect(() => minOutFor(1n, 0.5)).toThrow(RangeError);
  });
});

describe("quote helpers", () => {
  const base = { buyable: true, side: "buy", amountIn: "5", amountOut: "7", minOutSuggested: "6", tollPerDayBps: "12", breakevenDays: 3, expiresAt: "2026-01-01T00:00:00Z", stale: false, reason: null, code: null, message: null, sellMode: null } as unknown as QuoteResponse;
  test("buyable quote becomes bigint amounts", () => {
    const s = summarizeQuote(base);
    expect(s.buyable && s.amountOut).toBe(7n);
  });
  test("a blocked quote carries the reason and no amounts", () => {
    const s = summarizeQuote({ ...base, buyable: false, reason: "market closed", code: "CLOSED" } as QuoteResponse);
    expect(s).toMatchObject({ buyable: false, reason: "market closed", code: "CLOSED" });
    expect("amountOut" in s).toBe(false);
  });
  test("expiry", () => {
    expect(quoteExpired(base, new Date("2026-01-01T00:00:01Z"))).toBe(true);
    expect(quoteExpired(base, new Date("2025-12-31T00:00:00Z"))).toBe(false);
  });
});

describe("verifyIntent against the committed deployment", () => {
  test("accepts a target, spender and token from the file (case-insensitive)", () => {
    expect(() => verifyIntent(good, dep)).not.toThrow();
    expect(() => verifyIntent({ tx: { to: A(0xa).toUpperCase().replace("0X", "0x") }, approvals: [{ token: A(0xc), spender: A(2) }] }, dep)).not.toThrow();
  });
  test("rejects a foreign target, spender, token, value and empty address", () => {
    const fields = (i: unknown) => { try { verifyIntent(i as never, dep); return "ok"; } catch (e) { return e instanceof OverdriveIntentMismatch ? e.field : "other"; } };
    expect(fields({ ...good, tx: { to: A(0x99) } })).toBe("tx.to");
    expect(fields({ ...good, tx: { to: "" } })).toBe("tx.to");
    expect(fields({ ...good, tx: { to: A(0xa), value: "1" } })).toBe("tx.value");
    expect(fields({ ...good, approvals: [{ token: A(1), spender: A(0x99) }] })).toBe("approvals[0].spender");
    expect(fields({ ...good, approvals: [{ token: A(0x99), spender: A(0xa) }] })).toBe("approvals[0].token");
    expect(fields({})).toBe("tx.to");
  });
  test("fails closed on an unknown chain and on a file with no addresses", () => {
    expect(() => verifyIntent(good, 999_999)).toThrow(OverdriveIntentMismatch);
    expect(() => verifyIntent(good, { ...dep, contracts: { ODMinter: "" } })).toThrow(/no contract addresses/);
    // the anvil file in this checkout has empty contracts, so it must refuse everything
    for (const d of DEPLOYMENTS) if (Object.values(d.contracts).every((v) => v === "")) expect(() => verifyIntent(good, d.chainId)).toThrow(OverdriveIntentMismatch);
  });
  test("client with chainId checks offline and never calls /v1/config", async () => {
    const urls: string[] = [];
    const fetcher = (async (u: string | URL | Request) => { urls.push(String(u)); return new Response(JSON.stringify({ tx: { to: A(0x99), data: "0x", value: "0" }, approvals: [] }), { status: 200 }); }) as typeof fetch;
    const client = new Overdrive({ baseUrl: "https://api.test", fetch: fetcher, chainId: 31337 });
    await expect(client.intent("buy", {} as never)).rejects.toBeInstanceOf(OverdriveIntentMismatch);
    expect(urls).toEqual(["https://api.test/v1/intent/buy"]);
  });
});

import { describe, expect, test } from "bun:test";
import { logged, parseSafeBatch } from "./hook-seed";

const A = "0x00000000000000000000000000000000000000aa";
const ok = { version: "1.0", chainId: "4663", meta: { name: "mainnet-hook-remove" }, transactions: [{ to: A, value: "0", data: "0x426a8493" + "00".repeat(96) }, { to: A, value: "0", data: "0x12345678" }] };

describe("parseSafeBatch", () => {
  test("reads chain id, name and every transaction", () => {
    const b = parseSafeBatch(JSON.stringify(ok));
    expect(b.chainId).toBe("4663");
    expect(b.name).toBe("mainnet-hook-remove");
    expect(b.txs).toHaveLength(2);
    expect(b.txs[0]!.to).toBe("0x00000000000000000000000000000000000000AA");
    expect(b.txs[1]!.value).toBe(0n);
  });
  test("refuses a value, a bad address, empty calldata and an empty batch", () => {
    const tx = ok.transactions[0]!;
    expect(() => parseSafeBatch(JSON.stringify({ ...ok, transactions: [{ ...tx, value: "1" }] }))).toThrow("value");
    expect(() => parseSafeBatch(JSON.stringify({ ...ok, transactions: [{ ...tx, to: "0x12" }] }))).toThrow("bad to");
    expect(() => parseSafeBatch(JSON.stringify({ ...ok, transactions: [{ ...tx, data: "0x" }] }))).toThrow("bad data");
    expect(() => parseSafeBatch(JSON.stringify({ ...ok, transactions: [] }))).toThrow("no transactions");
    expect(() => parseSafeBatch(JSON.stringify({ ...ok, chainId: 4663 }))).toThrow("chainId");
  });
});

describe("logged", () => {
  test("finds the value after a label", () => {
    expect(logged("== Logs ==\n  ODHookSeed: 0xAbC0000000000000000000000000000000000001\n", "ODHookSeed:")).toBe("0xAbC0000000000000000000000000000000000001");
    expect(() => logged("nothing", "HookSeedBatch:")).toThrow("no");
  });
});

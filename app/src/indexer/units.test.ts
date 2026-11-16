import { describe, expect, test } from "bun:test";
import { asBigInt, bytes32Text, gearStatusName, marketSymbol, parseChainTimestamp, sessionName } from "./units";

describe("units", () => {
  test("parsing helpers", () => {
    expect(asBigInt("0x10")).toBe(16n);
    expect(asBigInt("12")).toBe(12n);
    expect(asBigInt("zz", 7n)).toBe(7n);
    expect(parseChainTimestamp("0x10")?.getTime()).toBe(16_000);
    expect(parseChainTimestamp("nope")).toBeUndefined();
    expect(gearStatusName(1)).toBe("active");
    expect(gearStatusName(2)).toBe("paused");
    expect(gearStatusName(4)).toBe("retired");
    expect(sessionName(2)).toBe("CLOSED");
    expect(sessionName(99)).toBe("UNKNOWN");
    expect(bytes32Text(`0x${Buffer.from("HALTED").toString("hex").padEnd(64, "0")}`)).toBe("HALTED");
  });
});

describe("marketSymbol", () => {
  test("a market listed after the deployment file decodes to its symbol, not raw hex (fork G07: MCKA)", () => {
    expect(marketSymbol(`0x${Buffer.from("MCKA").toString("hex").padEnd(64, "0")}`)).toBe("MCKA");
  });
  test("a pair hash, zero, a short value or a non-printable id passes through unchanged", () => {
    const pair = "0x53a0b92e86a2442720353fd0555f985c34c582969c5f45ba30cf5194eaff582d"; // not-a-key: the ETH/BTC oracle pair key
    expect(marketSymbol(pair)).toBe(pair);
    expect(marketSymbol(`0x${"0".repeat(64)}`)).toBe(`0x${"0".repeat(64)}`);
    expect(marketSymbol("0x1234")).toBe("0x1234");
    expect(marketSymbol("ETH")).toBe("ETH");
  });
});

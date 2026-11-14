import { describe, expect, test } from "bun:test";
import { asBigInt, bytes32Text, gearStatusName, parseChainTimestamp, sessionName } from "./units";

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

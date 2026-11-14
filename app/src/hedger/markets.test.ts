import { expect, test } from "bun:test";
import { oracleMarkAgeMs } from "./markets";

test("a closed feed with a good last price is not stale for the hedger; an unfresh read is; an open feed ages normally", () => {
  const now = 1_800_000_000_000;
  expect(oracleMarkAgeMs({ fresh: true, session: 2, updatedAt: BigInt(now / 1000 - 86_400) }, now)).toBe(0);
  expect(oracleMarkAgeMs({ fresh: false, session: 2, updatedAt: 0n }, now)).toBe(Number.POSITIVE_INFINITY);
  expect(oracleMarkAgeMs({ fresh: true, session: 0, updatedAt: BigInt(now / 1000 - 30) }, now)).toBe(30_000);
  expect(oracleMarkAgeMs({ fresh: true, session: 0, updatedAt: BigInt(now / 1000 - 3600) }, now)).toBe(3_600_000);
});

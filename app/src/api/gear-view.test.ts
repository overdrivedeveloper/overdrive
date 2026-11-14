import { expect, test } from "bun:test";
import { buildGearView, projectNf } from "./gear-view";
import type { GearRow } from "../db/queries/gears";

const WAD = 10n ** 18n;
const ID = `0x${"22".repeat(32)}`;
const dep = { gears: [{ id: ID, symbol: "ETH-SPORT", gear: "x", unitUsd: "100", token: "0x0" }] } as any;
const DAY = 86_400;
const TOLL_PER_SEC = (WAD * 1n) / (1000n * BigInt(DAY)); // 0.1 percent a day
const t0 = new Date("2026-11-01T00:00:00Z");
const row = (over: Partial<GearRow> = {}): GearRow => ({
  id: ID, marketA: "ETH", marketB: null, underlying: "ETH", underlyingB: null, power: "2", token: "0x0", capUsd: "0", spreadBps: 10, status: "active",
  nf: WAD.toString(), lastAccrual: t0, tollPerSecWad: TOLL_PER_SEC.toString(), tollAt: t0, priceWad: null, priceTs: t0, session: "OPEN", priceFresh: true,
  sigmaBps: null, sigmaAt: null, lastValueWad: (100n * WAD).toString(), supply: "0", tradeNf: WAD.toString(), ...over,
});

test("value_per_token_follows_the_current_nf_not_the_last_trade", () => {
  const now = new Date(t0.getTime() + DAY * 1000);
  const v = buildGearView(row(), dep, [], now);
  const value = BigInt(v.valuePerToken);
  expect(value).toBeLessThan(100n * WAD);
  expect(Number(value) / 1e18).toBeCloseTo(99.9, 1); // about 0.1 percent of toll in a day
  expect(v.valueSource).toBe("trade_nf");
  expect(BigInt(v.nf)).toBeLessThan(WAD);
});

test("value_is_the_trade_value_at_the_trade_instant_and_listing_without_trades", () => {
  expect(buildGearView(row(), dep, [], t0).valuePerToken).toBe((100n * WAD).toString());
  const noTrade = buildGearView(row({ lastValueWad: null, tradeNf: null }), dep, [], new Date(t0.getTime() + DAY * 1000));
  expect(noTrade.valueSource).toBe("listing");
  expect(Number(noTrade.valuePerToken) / 1e18).toBeCloseTo(99.9, 1);
  expect(buildGearView(row({ tradeNf: null }), dep, [], t0).valueSource).toBe("trade");
});

test("project_nf_holders_receive_raises_nf", () => {
  expect(projectNf(WAD, (-TOLL_PER_SEC).toString(), t0, new Date(t0.getTime() + DAY * 1000))).toBeGreaterThan(WAD);
  expect(projectNf(WAD, null, t0, t0)).toBe(WAD);
});

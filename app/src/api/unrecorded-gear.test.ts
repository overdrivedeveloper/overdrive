// A gear listed through the timelock after the deploy, indexed from its GearListed event, while the deployment record still
// has no entry for it (testnet 46630 after batch 1). The API must still list it under its symbol and quote it.
import { afterAll, expect, test } from "bun:test";
import pino from "pino";
import type { Hex } from "viem";
import type { Deployment } from "../lib/deployments";
import { adoptIndexedGears, listedSymbol, readIndexedGears, recordGearFromIndexed } from "../lib/gear-catalog";
import { createIndexerState, createIngest } from "../indexer/ingest";
import { FakeChain, fakeReader, listGear, settings } from "../indexer/test-support";
import { marketId } from "../indexer/units";
import { createApiApp } from "./app";
import { TtlCache } from "./cache";
import { addr, apiDeployment, harness, idOf, mockHookFor, WAD } from "./test-support";

const h = await harness("unrecorded_gear");
afterAll(async () => { await h?.close(); });

const ETH = marketId("ETH");
const GEAR_ID = idOf("ETH-SPORT") as Hex;
const TOKEN = addr("ETH-SPORT");

test("an indexed GearListed gear with no record entry is listed under its symbol and quotes", async () => {
  if (!h) return;
  // the record the services boot with: no ETH market, no ETH gear (the shape of 46630.json after batch 1)
  const record: Deployment = apiDeployment();
  expect(record.gears.some((g) => g.id === GEAR_ID)).toBe(false);

  // the indexer sees the listing on chain and stores it
  const chain = new FakeChain();
  chain.gearParams.set(GEAR_ID, { capUsdWad: 250_000n * WAD, spreadBps: 30 });
  chain.add([listGear(record, GEAR_ID, ETH, TOKEN, 1)]);
  const errors: unknown[] = [];
  const loud = pino({ level: "error" }, { write: (line: string) => { errors.push(JSON.parse(line)); } });
  const state = await createIndexerState({ settings: settings(), source: chain, reader: fakeReader(), sql: h.raw, logger: loud, deployment: apiDeployment() });
  const ingest = createIngest(state);
  for (let i = 0; i < 10; i++) if ((await ingest.tick()).ingested === 0n) break;
  // the indexer says loudly that the record lags the chain
  expect(errors.some((e) => String((e as { msg?: string }).msg).includes("deployment record is missing 1 gear(s)"))).toBe(true);
  await h.raw`INSERT INTO prices (underlying, ts, block, price_wad, session, fresh) VALUES ('ETH', now(), 1, ${(3000n * WAD).toString()}, 'OPEN', true)`;

  // the chain knows the gear (the mock hook stands in for the real pool and minter)
  const hook = mockHookFor({ gears: [...record.gears, { id: GEAR_ID }] });
  const app = createApiApp({ ...h.deps, deployment: record, chain: hook.asChain(), cache: new TtlCache(), logger: pino({ level: "silent" }) });

  const gears = (await (await app.request("/v1/gears")).json()) as { gears: Array<{ id: string; symbol: string; gear: string | null; underlying: string; price: string | null }> };
  const eth = gears.gears.find((g) => g.id === GEAR_ID);
  expect(eth).toBeDefined();
  expect(eth!.symbol).toBe("ETH-SPORT");
  expect(eth!.gear).toBe("SPORT");
  expect(eth!.underlying).toBe("ETH");
  expect(eth!.price).toBe((3000n * WAD).toString());

  for (const key of ["ETH-SPORT", "eth-sport", GEAR_ID]) {
    const quote = await app.request(`/v1/quote?gear=${key}&side=buy&usdg=5000000`);
    expect(quote.status).toBe(200);
    expect(((await quote.json()) as { gear: string }).gear).toBe("ETH-SPORT");
  }

  const compat = await app.request("/v1/compat/trade.quote", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: record.chainId, account: addr("holder"), gearId: "ETH-SPORT", side: "buy", input: { token: { address: record.external.usdg, symbol: "USDG", decimals: 6 }, baseUnits: "5000000" }, slippageBps: 50 }),
  });
  expect(compat.status).toBe(200);

  // a gear the record does list keeps the record's entry (pool id and all)
  const recorded = record.gears.find((g) => g.symbol === "TSLA-SPORT")!;
  expect(recorded.poolId).toBe(idOf("pool-TSLA-SPORT") as Hex);
});

test("record-shaped entries from indexed rows: symbol, power, pair ticker, unit", async () => {
  expect(listedSymbol("ETH", null, 4)).toBe("ETH-REV");
  expect(listedSymbol("NVDA", "TSLA", 1)).toBe("NVDA/TSLA-SPORT");
  const row = { id: GEAR_ID, underlying: "ETH", underlyingB: null, power: "3", token: TOKEN, capUsd: "250000", spreadBps: 30, gearIndex: null, unitWad: (100n * WAD).toString() };
  const g = recordGearFromIndexed(row)!;
  expect(g).toMatchObject({ symbol: "ETH-RACE", gear: "RACE", power: "3", marketA: "ETH", marketB: null, unitUsd: "100", capUsd: "250000" });
  const pair = recordGearFromIndexed({ ...row, underlying: "NVDA/TSLA", underlyingB: "TSLA", power: "2", gearIndex: 1 })!;
  expect(pair).toMatchObject({ symbol: "NVDA/TSLA-SPORT", marketA: "NVDA", marketB: "TSLA" });
  const d = apiDeployment();
  const before = d.gears.length;
  expect(adoptIndexedGears(d, [row, { ...row, id: d.gears[0]!.id }]).map((x) => x.symbol)).toEqual(["ETH-RACE"]);
  expect(d.gears.length).toBe(before + 1);
  expect(adoptIndexedGears(d, [row])).toEqual([]);
  if (h) expect(Array.isArray(await readIndexedGears(h.sql))).toBe(true);
});

test("the snapshot prices a listed gear's market that the record does not list, and a failed read never fails the snapshot", async () => {
  if (!h) return;
  const { takeSnapshot } = await import("../indexer/snapshot");
  const BTC = marketId("BTC");
  await h.raw`INSERT INTO gears (id, market_a, market_b, underlying, underlying_b, power, power_wad, token, cap_usd, spread_bps, status)
    VALUES (${idOf("BTC-SPORT")}, ${BTC}, NULL, 'BTC', NULL, 2, ${(2n * WAD).toString()}, ${addr("BTC-SPORT").toLowerCase()}, 1000, 30, 'active') ON CONFLICT DO NOTHING`;
  const at = { block: 99n, ts: new Date("2026-11-19T12:00:00Z") };
  const reader = fakeReader({ price: async (m) => { if (m === marketId("ETH")) throw new Error("rpc down"); return { priceWad: 7n * WAD, fresh: true, source: "chainlink", session: "OPEN" }; } });
  const done = await takeSnapshot(reader, h.raw, apiDeployment(), at);
  expect(done.ok).toBe(true);
  const rows = await h.raw<{ underlying: string; price_wad: string }[]>`SELECT underlying, price_wad::text FROM prices WHERE ts = ${at.ts.toISOString()} ORDER BY underlying`;
  expect(rows.find((r) => r.underlying === "BTC")?.price_wad).toBe((7n * WAD).toString());
  expect(rows.some((r) => r.underlying === "ETH")).toBe(false);
});

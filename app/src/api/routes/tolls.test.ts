import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tollBpsText } from "../quote/model";
import { SECONDS_PER_DAY, tollPerDayTwinWad } from "../../db/queries/tolls";
import { FORMULA_MD, formulaConstants } from "../formula";
import { harness, POWERS, WAD } from "../test-support";

const h = await harness("tolls");
afterAll(async () => { await h?.close(); });
const bps = (wad: bigint) => tollBpsText(((wad + 5n * 10n ** 7n) / 10n ** 8n) * 10n ** 8n);

test("published vectors of the twin: TSLA Sport 60%, SPY Sport 18%, NVDA Cruise 50%", () => {
  expect(Number(tollBpsText(tollPerDayTwinWad(2n * WAD, 6000n)))).toBeCloseTo(9.863, 3); // about 0.099% a day
  expect(Number(tollBpsText(tollPerDayTwinWad(2n * WAD, 1800n)))).toBeCloseTo(0.8877, 3); // about 0.009%
  expect(Number(tollBpsText(tollPerDayTwinWad(15n * WAD / 10n, 5000n)))).toBeCloseTo(2.5685, 3); // about 0.026%
  expect(tollPerDayTwinWad(WAD / 2n, 5000n)).toBeLessThan(0n); // Eco: negative
});

test("toll_equals_getter_and_formula_all_powers", async () => {
  if (!h) return;
  await h.seedIndexer();
  for (const p of POWERS) {
    const symbol = `TSLA-${p.gear}`;
    const twin = tollPerDayTwinWad(p.powerWad, 5000n);
    const id = h.deployment.gears.find((g) => g.symbol === symbol)!.id.toLowerCase();
    h.hook.gears.get(id)!.tollPerDayWad = twin; // IODMinter.tollPerDay(gearId) on chain
    await h.seedGear(symbol, { sigmaBps: 5000, toll: twin / SECONDS_PER_DAY });
  }
  const res = await h.app.request("/v1/tolls");
  const body = (await res.json()) as any;
  expect(body.tolls.length).toBe(5);
  for (const row of body.tolls) {
    const id = h.deployment.gears.find((g) => g.symbol === row.symbol)!.id;
    const getter = await h.chain.minterTollPerDay(id);
    expect(row.tollPerDayBps).toBe(bps(getter)); // equals the contract getter
    expect(row.tollFormulaBps).toBe(row.tollPerDayBps); // and the published formula at the posted sigma
    expect(row.holdersReceive).toBe(row.power === "0.5" || false);
    expect(Math.abs(Number(row.tollPer30DaysBps) - Number(bps(getter * 30n)))).toBeLessThan(1e-5); // 30 days of the same daily number
  }
  const reverse = body.tolls.find((r: any) => r.power === "-1");
  expect(Number(reverse.tollPerDayBps)).toBeGreaterThan(0); // p = -1 pays the toll like a convex gear
  expect(h.chain.calls.minter + h.chain.calls.quote + h.chain.calls.other).toBe(2 * 0 + h.chain.calls.other); // route read no quote
});

test("a sigma older than two hours is shown with a floor warning, never hidden", async () => {
  if (!h) return;
  await h.seedGear("NVDA/TSLA-SPORT", { sigmaBps: 3000, sigmaAgeSec: 7_300, toll: 1000n });
  const body = (await (await h.app.request("/v1/tolls")).json()) as any;
  const row = body.tolls.find((r: any) => r.symbol === "NVDA/TSLA-SPORT");
  expect(row.sigmaWarning).toBe("floor");
  expect(row.sigmaBps).toBe("3000");
});

test("pair_gear_sigma_is_read_under_the_oracle_pair_key_not_leg_a", async () => {
  if (!h) return;
  await h.seedGear("NVDA/TSLA-SPORT", { sigmaBps: 3000, sigmaAgeSec: 60, toll: 1000n });
  // a newer post for leg A alone (NVDA's bytes32 id) must not stand in for the pair
  const nvda = `0x${Buffer.from("NVDA").toString("hex").padEnd(64, "0")}`;
  await h.raw`INSERT INTO vol_posts (gear_or_underlying, ts, block, tx_hash, log_index, sigma_bps) VALUES (${nvda}, ${new Date(Date.now() + 1000).toISOString()}, 2, ${"0x" + "77".repeat(32)}, 0, 9000)`; // not-a-key: tx hash
  h.deps.cache.clear();
  const body = (await (await h.app.request("/v1/tolls")).json()) as any;
  expect(body.tolls.find((r: any) => r.symbol === "NVDA/TSLA-SPORT").sigmaBps).toBe("3000");
  await h.raw`DELETE FROM vol_posts WHERE gear_or_underlying = ${nvda}`;
});

test("the formula page is the vol engine's document, constant for constant", async () => {
  const doc = join(import.meta.dir, "..", "..", "..", "..", "vol-engine", "FORMULA.md");
  const file = readFileSync(doc, "utf8");
  expect(FORMULA_MD).toBe(file);
  expect(Object.keys(formulaConstants(file)).length).toBeGreaterThan(25);
  if (!h) return;
  const body = (await (await h.app.request("/v1/tolls/formula")).json()) as any;
  expect(body.constants).toEqual(formulaConstants(file));
  expect(body.constants.markup).toBe("1.15");
});

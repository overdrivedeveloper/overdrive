import { afterAll, expect, test } from "bun:test";
import { harness, idOf, WAD } from "../test-support";
import { healthBps, liquidationPriceWad } from "./backers";
import type { BackerHealth } from "../chain-reads";

const OWNER = "0x00000000000000000000000000000000000b4c4e";
let uplift = false;
// fixtures: [gear power, collateral USDG (6 dp), debt value (WAD), required, maintenance]. Race: 250 / 200, others 200 / 150 (weekend uplift raises required and maintenance)
const FIXTURES: Record<string, { collateral: bigint; debt: bigint; req: bigint; maint: bigint }> = {
  "TSLA-SPORT": { collateral: 2_000_000_000n, debt: 1000n * WAD, req: 20000n, maint: 15000n },
  "TSLA-RACE": { collateral: 2_600_000_000n, debt: 1000n * WAD, req: 25000n, maint: 20000n },
  "TSLA-REVERSE": { collateral: 1_700_000_000n, debt: 1000n * WAD, req: 20000n, maint: 15000n },
};
let currentVault = new Map<string, string>();
const h = await harness("backers", { chain: {
  backerHealth: async (id) => {
    const symbol = currentVault.get(id.toString())!;
    const f = FIXTURES[symbol]!;
    const bump = uplift ? 2500n : 0n;
    const b: BackerHealth = { collateralUsdg: f.collateral, debtValueWad: f.debt, ratioBps: healthBps(f.collateral, f.debt), requiredBps: f.req + bump, maintenanceBps: f.maint + bump };
    return b;
  },
  upliftActive: async () => ({ active: uplift, upliftBps: uplift ? 2500 : 0 }),
} });
afterAll(async () => { await h?.close(); });

test("health_equals_liquidator_function", async () => {
  if (!h) return;
  await h.seedIndexer();
  let n = 1;
  for (const symbol of Object.keys(FIXTURES)) {
    await h.seedGear(symbol, {});
    const gear = h.deployment.gears.find((g) => g.symbol === symbol)!;
    currentVault.set(String(n), symbol);
    await h.raw`INSERT INTO backer_vaults (id, owner, gear, collateral, debt_tokens, status) VALUES (${n}, ${OWNER}, ${gear.id.toLowerCase()}, ${FIXTURES[symbol]!.collateral.toString()}, 1, 'open')`;
    n++;
  }
  for (const on of [false, true]) {
    uplift = on;
    h.deps.cache.sweep(Number.MAX_SAFE_INTEGER);
    const body = (await (await h.app.request(`/v1/backers/${OWNER}`)).json()) as any;
    expect(body.vaults.length).toBe(3);
    for (const v of body.vaults) {
      const f = FIXTURES[v.gear]!;
      expect(v.healthRatioBps).toBe(healthBps(f.collateral, f.debt).toString()); // the liquidator's function
      expect(v.healthRatioBps).toBe(v.computedRatioBps); // and the contract getter's number
      expect(v.weekendUplift.active).toBe(on);
      expect(BigInt(v.maintenanceBps)).toBe(f.maint + (on ? 2500n : 0n));
      // the liquidation price is where the ratio meets maintenance: moving price there moves the ratio to maintenance
      const power = Number(h.deployment.gears.find((g) => g.symbol === v.gear)!.power);
      const price = 250n * WAD;
      const star = BigInt(v.liquidationPrice);
      const ratioAtStar = Number(v.healthRatioBps) * Math.pow(Number(price) / Number(star), power);
      expect(Math.abs(ratioAtStar - Number(v.maintenanceBps)) / Number(v.maintenanceBps)).toBeLessThan(0.001);
    }
    const race = body.vaults.find((v: any) => v.gear === "TSLA-RACE");
    expect(race.requiredBps).toBe(on ? "27500" : "25000");
    expect(race.belowMaintenance).toBe(false);
  }
  const one = (await (await h.app.request("/v1/vaults/1")).json()) as any;
  expect(one.vault.id).toBe("1");
  expect((await h.app.request("/v1/vaults/99")).status).toBe(404);
  expect(liquidationPriceWad(WAD, 0n, 15000n, 2)).toBeNull();
});
void idOf;

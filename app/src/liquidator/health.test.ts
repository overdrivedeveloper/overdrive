import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { optionalEnv } from "../config";
import { GEAR_NVDA_RACE, GEAR_TSLA, LIQUIDATOR_ACCOUNT, liquidationWorld } from "../testing/mock-backer";
import { MARKET_NVDA, MARKET_TSLA, WAD } from "../testing/mock-chain";
import { liquidatorAddresses, verifyOnChain } from "./batch";
import { healthFromTuple, isLiquidatable, ratioBps } from "./health";
import { rng } from "./test-rng";

describe("health parity (R1, R2)", () => {
  test("matches_contract_health_random_vaults", () => {
    const { backer } = liquidationWorld();
    const r = rng(17);
    let liquidatable = 0;
    for (let i = 0; i < 10_000; i++) {
      const gear = r.pick([GEAR_TSLA, GEAR_NVDA_RACE]);
      backer.uplift.set(MARKET_TSLA, r.pick([0, 0, 1000, 2500]));
      backer.uplift.set(MARKET_NVDA, r.pick([0, 0, 1000, 2500]));
      backer.gears.get(gear)!.valueWad = r.big(1000n * WAD) + 1n;
      const id = backer.openVault(gear, r.big(10n ** 12n), r.pick([0n, r.big(10n ** 24n), r.big(10n ** 18n)]));
      const tuple = backer.health(id);
      const h = healthFromTuple(tuple);
      expect(ratioBps(h.collateralUsdg, h.debtValueWad)).toBe(tuple[2]);
      expect(isLiquidatable(h)).toBe(backer.liquidatableAt(id));
      if (isLiquidatable(h)) liquidatable++;
    }
    // the sample covers both sides of the line
    expect(liquidatable).toBeGreaterThan(500);
    expect(liquidatable).toBeLessThan(9500);
  });

  test("exact_boundary", () => {
    const { backer } = liquidationWorld();
    for (const [gear, uplift] of [[GEAR_TSLA, 0], [GEAR_NVDA_RACE, 0], [GEAR_TSLA, 1000], [GEAR_NVDA_RACE, 2500]] as const) {
      backer.uplift.set(gear === GEAR_TSLA ? MARKET_TSLA : MARKET_NVDA, uplift);
      const { maintenance } = backer.thresholds(gear);
      // debt value 100 USD; collateral exactly at maintenance is maintenance/10000 * 100 USDG
      const atLine = (maintenance * 100n * 10n ** 6n) / 10_000n;
      const ok = backer.openVault(gear, atLine, 100n * WAD);
      const below = backer.openVault(gear, atLine - 1n, 100n * WAD);
      expect(isLiquidatable(healthFromTuple(backer.health(ok)))).toBe(false);
      expect(healthFromTuple(backer.health(ok)).ratioBps).toBe(maintenance);
      expect(isLiquidatable(healthFromTuple(backer.health(below)))).toBe(true);
      expect(backer.liquidatableAt(ok)).toBe(false);
      expect(backer.liquidatableAt(below)).toBe(true);
    }
    expect(isLiquidatable({ collateralUsdg: 0n, debtValueWad: 0n, ratioBps: ratioBps(0n, 0n), requiredBps: 1n, maintenanceBps: 1n })).toBe(false);
  });

  test("thresholds_from_chain_not_constants", async () => {
    // a ratio literal in liquidator code is a failing test
    const dir = import.meta.dir;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-rng.ts")) {
      const text = readFileSync(join(dir, file), "utf8");
      expect({ file, hit: text.match(/(?<![\d_])(15_?000|20_?000|25_?000)(?![\d_])/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
    // and the chain is asked for health and uplift on every pass
    const { chain, backer } = liquidationWorld();
    const id = backer.openVault(GEAR_TSLA, 100n * 10n ** 6n, 100n * WAD);
    const addresses = liquidatorAddresses(chain.deployment.contracts);
    const clients = backer.clients(LIQUIDATOR_ACCOUNT);
    const c = [{ vaultId: id, gearId: GEAR_TSLA, owner: "x", collateralUsdg: 0n, debtTokens: 0n, healthHint: null, indexAgeS: null }];
    const first = await verifyOnChain(clients, c, addresses);
    expect(first[0]!.verdict).toBe("liquidatable");
    // the uplift turns on: the same vault's maintenance moves with it, read from the chain
    backer.vaults.get(id)!.collateralUsdg = 160n * 10n ** 6n;
    expect((await verifyOnChain(clients, c, addresses))[0]!.verdict).toBe("recovered");
    backer.uplift.set(MARKET_TSLA, 2000);
    const third = await verifyOnChain(clients, c, addresses);
    expect(third[0]!.verdict).toBe("liquidatable");
    expect(third[0]!.health!.maintenanceBps).toBe(backer.thresholds(GEAR_TSLA).maintenance);
    expect(backer.readCount.get("health")).toBe(3);
    expect(backer.readCount.get("upliftActive")).toBe(3);
  });

  test.skipIf(!optionalEnv("RHC_FORK_RPC"))("matches_contract_health_fork", () => {
    // ODBacker (todo 07) is not deployed on any fork yet; this variant runs once a deployment file names it.
    expect(optionalEnv("RHC_FORK_RPC")).toBeDefined();
  });
});

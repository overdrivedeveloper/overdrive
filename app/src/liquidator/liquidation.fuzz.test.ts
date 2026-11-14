import { describe, expect, test } from "bun:test";
import { GEAR_NVDA_RACE, GEAR_TSLA, LIQUIDATOR_ACCOUNT, liquidationWorld } from "../testing/mock-backer";
import { MARKET_NVDA, MARKET_TSLA, WAD } from "../testing/mock-chain";
import { buildPlans, liquidatorAddresses, verifyOnChain } from "./batch";
import { decodeLiquidationLogs } from "./state";
import { rng } from "./test-rng";

describe("liquidation invariant (fuzz)", () => {
  test("healthy_never_sealed_bonus_exact", async () => {
    let sealedVaults = 0;
    for (let run = 0; run < 300; run++) {
      const r = rng(1000 + run);
      const { chain, backer } = liquidationWorld();
      const clients = backer.clients(LIQUIDATOR_ACCOUNT);
      const addresses = liquidatorAddresses(chain.deployment.contracts);
      const n = 1 + r.int(15);
      for (let i = 0; i < n; i++) backer.openVault(r.pick([GEAR_TSLA, GEAR_NVDA_RACE]), r.big(500n * 10n ** 6n) + 1n, r.big(200n * WAD) + 1n);
      for (let step = 0; step < 3; step++) {
        for (const g of backer.gears.values()) g.valueWad = r.big(3n * WAD) + WAD / 10n; // the price path
        backer.uplift.set(MARKET_TSLA, r.pick([0, 0, 1500]));
        backer.uplift.set(MARKET_NVDA, r.pick([0, 0, 1500]));
        const ids = [...backer.vaults.keys()];
        const verified = await verifyOnChain(clients, ids.map((id) => ({ vaultId: id, gearId: backer.vaults.get(id)!.gearId, owner: "x", collateralUsdg: 0n, debtTokens: 0n, healthHint: null, indexAgeS: null })), addresses);
        for (const plan of buildPlans(verified, { maxVaults: 20, gasBudget: 30_000_000n })) {
          // invariant 1: no vault whose chain ratio is at or above maintenance is in a sealed batch
          for (const id of plan.vaultIds) {
            const [, , ratio, , maintenance] = backer.health(id);
            expect(ratio < maintenance).toBe(true);
          }
          backer.seal(plan.gearId, plan.vaultIds, true);
          const batchId = backer.nextBatch - 1n;
          // the chain keeps only unhealthy vaults: every planned vault was kept
          expect(backer.batches.get(batchId)!.vaultIds).toEqual(plan.vaultIds);
          sealedVaults += plan.vaultIds.length;
          const sealedValue = backer.batches.get(batchId)!.sealedValueWad;
          chain.warp(backer.sealDelay);
          const from = backer.logs.length;
          backer.executeBatch(batchId, true, false);
          // invariant 2: each bonus is exactly 5% of the debt value (rounded up to USDG), the insurance being large
          for (const e of decodeLiquidationLogs(backer.logs.slice(from), addresses.backer).liquidated) {
            const debtUsdg = ((e.debtTokens * sealedValue) / WAD + 10n ** 12n - 1n) / 10n ** 12n;
            const due = (debtUsdg * 500n) / 10_000n;
            expect(e.bonusUsdg).toBe(due);
            expect(e.badDebtUsdg).toBe(0n);
          }
        }
        chain.warp(3600);
      }
    }
    expect(sealedVaults).toBeGreaterThan(300);
  });
});

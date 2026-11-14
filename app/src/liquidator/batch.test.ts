import { describe, expect, test } from "bun:test";
import { encodeFunctionData, getAddress, type Hex } from "viem";
import { IODBackerAbi, IODGearAbi, IODGovernorAbi } from "../abi";
import { GEAR_NVDA_RACE, GEAR_TSLA, LIQUIDATOR_ACCOUNT, liquidationWorld, type MockBacker } from "../testing/mock-backer";
import { WAD } from "../testing/mock-chain";
import { assertLiquidatorCall, buildPlans, encodeExecute, encodeSeal, liquidatorAddresses, verifyOnChain } from "./batch";
import type { Candidate } from "./types";

const U = 10n ** 6n;
const cand = (backer: MockBacker, vaultId: bigint, gearId: Hex = backer.vaults.get(vaultId)?.gearId ?? GEAR_TSLA): Candidate =>
  ({ vaultId, gearId, owner: "x", collateralUsdg: 0n, debtTokens: 0n, healthHint: null, indexAgeS: null });

function world() {
  const w = liquidationWorld();
  const verify = (c: Candidate[]) => verifyOnChain(w.backer.clients(LIQUIDATOR_ACCOUNT), c, liquidatorAddresses(w.chain.deployment.contracts));
  return { ...w, verify };
}

describe("verification and plans (R3, R5, R9, R10)", () => {
  test("recovered_vault_dropped_after_chain_reread", async () => {
    const { backer, verify } = world();
    const a = backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD); // under 150%
    const b = backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    // between the scan and the send, the backer of b tops up
    backer.vaults.get(b)!.collateralUsdg = 200n * U;
    const v = await verify([cand(backer, a), cand(backer, b)]);
    expect(v.map((x) => x.verdict)).toEqual(["liquidatable", "recovered"]);
    const plans = buildPlans(v, { maxVaults: 20, gasBudget: 10_000_000n });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.vaultIds).toEqual([a]);
  });

  test("in_batch_vault_dropped", async () => {
    const { backer, verify } = world();
    const a = backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    const b = backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    backer.sealAsOther(GEAR_TSLA, [b]);
    const v = await verify([cand(backer, a), cand(backer, b)]);
    expect(v[1]!.verdict).toBe("in_batch");
    expect(buildPlans(v, { maxVaults: 20, gasBudget: 10_000_000n })[0]!.vaultIds).toEqual([a]);
  });

  test("only_open_backer_vault_ids", async () => {
    const { backer, verify } = world();
    const real = backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    const noDebt = backer.openVault(GEAR_TSLA, 100n * U, 0n);
    const unknown = 999n; // an id the backer never issued (a holder's address cast to a number, a typo)
    const wrongGear = backer.openVault(GEAR_NVDA_RACE, 100n * U, 100n * WAD);
    const v = await verify([cand(backer, real), cand(backer, noDebt), cand(backer, unknown, GEAR_TSLA), cand(backer, wrongGear, GEAR_TSLA)]);
    expect(v.map((x) => x.verdict)).toEqual(["liquidatable", "no_debt", "malformed", "gear_mismatch"]);
    // a forged verdict without a vault() view or with a batch id never enters a plan
    const { vault: _drop, ...noVault } = v[0]!;
    const forged = [{ ...noVault, vaultId: 77n }, { ...v[0]!, vaultId: 78n, vault: { ...v[0]!.vault!, batchId: 3n } }];
    const plans = buildPlans([...v, ...forged], { maxVaults: 20, gasBudget: 10_000_000n });
    expect(plans.flatMap((p) => p.vaultIds)).toEqual([real]);
  });

  test("calldata_is_seal_or_execute_only", () => {
    const { chain } = world();
    const backer = getAddress(chain.deployment.contracts.ODBacker!);
    expect(assertLiquidatorCall(backer, encodeSeal(GEAR_TSLA, [1n, 2n]), backer).name).toBe("sealBatch");
    expect(assertLiquidatorCall(backer, encodeExecute(5n), backer)).toEqual({ name: "executeBatch", args: [5n] });
    // any other backer function is refused
    const withdraw = encodeFunctionData({ abi: IODBackerAbi, functionName: "withdraw", args: [1n, 1n, backer] });
    expect(() => assertLiquidatorCall(backer, withdraw, backer)).toThrow("refuses withdraw");
    // any other target is refused, whatever the data says
    const governor = getAddress(chain.deployment.contracts.ODGovernor!);
    const hook = getAddress(chain.deployment.contracts.ODHook!);
    expect(() => assertLiquidatorCall(governor, encodeSeal(GEAR_TSLA, [1n]), backer)).toThrow("only IODBacker");
    expect(() => assertLiquidatorCall(hook, encodeExecute(1n), backer)).toThrow("only IODBacker");
    // a gear token transfer (a holder's balance) cannot even be decoded as a backer call
    const transfer = encodeFunctionData({ abi: IODGearAbi, functionName: "transfer", args: [backer, 1n] });
    expect(() => assertLiquidatorCall(backer, transfer, backer)).toThrow();
    expect(IODGovernorAbi.length).toBeGreaterThan(0);
  });

  test("one_bad_vault_does_not_block_batch", async () => {
    const { backer, chain, verify } = world();
    const bad = backer.openVault(GEAR_TSLA, 1n * U, 100n * WAD); // the deepest: sorted first
    const good = backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    const good2 = backer.openVault(GEAR_TSLA, 110n * U, 100n * WAD);
    // health() reverts for the bad vault only
    const health = chain.readers.get("ODBacker.health")!;
    chain.readers.set("ODBacker.health", (args) => { if (args[0] === bad) throw new Error("execution reverted"); return health(args); });
    const v = await verify([cand(backer, bad), cand(backer, good), cand(backer, good2)]);
    expect(v.map((x) => x.verdict)).toEqual(["read_failed", "liquidatable", "liquidatable"]);
    expect(buildPlans(v, { maxVaults: 20, gasBudget: 10_000_000n })[0]!.vaultIds).toEqual([good, good2]);
    // a malformed row (bad gear id) is also isolated
    const v2 = await verify([cand(backer, good, "0x1234" as Hex), cand(backer, good2)]);
    expect(v2[1]!.verdict).toBe("liquidatable");
    expect(v2[0]!.verdict).not.toBe("liquidatable");
  });

  test("worst_health_first_and_bounded", async () => {
    const { backer, verify } = world();
    const ids: bigint[] = [];
    for (let i = 0; i < 30; i++) ids.push(backer.openVault(GEAR_TSLA, BigInt(140 - i) * U, 100n * WAD));
    const race = backer.openVault(GEAR_NVDA_RACE, 10n * U, 100n * WAD); // deepest of all, other gear
    const v = await verify([...ids, race].map((id) => cand(backer, id)));
    const plans = buildPlans(v, { maxVaults: 20, gasBudget: 100_000_000n });
    expect(plans.map((p) => p.gearId)).toEqual([GEAR_NVDA_RACE, GEAR_TSLA]);
    expect(plans[1]!.vaultIds).toHaveLength(20);
    expect(plans[1]!.vaultIds).toEqual([...ids].reverse().slice(0, 20)); // lowest collateral first
    // the gas budget bounds too
    expect(buildPlans(v, { maxVaults: 20, gasBudget: 600_000n }).find((p) => p.gearId === GEAR_TSLA)!.vaultIds).toHaveLength(3);
    expect(plans[1]!.expectedBonusUsdg).toBeGreaterThan(0n);
  });
});

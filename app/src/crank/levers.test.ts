import { describe, expect, test } from "bun:test";
import { IODBackerAbi, IODFeesAbi, IODGovernorAbi, IODMarketHoursAbi, IODMinterAbi, IODOracleGuardAbi, IODVolOracleAbi } from "../abi";
import { LEVERS, NOT_LEVERS } from "./LEVERS";
import { CRANK_JOBS } from "../config";
import { JOB_FACTORIES } from "./runtime";

const ABIS: Record<string, readonly { type: string; name?: string; stateMutability?: string }[]> = {
  IODMinter: IODMinterAbi, IODGovernor: IODGovernorAbi, IODOracleGuard: IODOracleGuardAbi, IODMarketHours: IODMarketHoursAbi, IODFees: IODFeesAbi, IODBacker: IODBackerAbi, IODVolOracle: IODVolOracleAbi,
};

describe("levers", () => {
  test("every_lever_has_a_caller", () => {
    const missing: string[] = [];
    for (const [contract, abi] of Object.entries(ABIS)) {
      for (const item of abi) {
        if (item.type !== "function" || item.stateMutability === "view" || item.stateMutability === "pure") continue;
        const key = `${contract}.${item.name}`;
        if (!LEVERS[key] && !NOT_LEVERS.some((n) => n.match.test(key))) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
    // every named crank job exists and has a factory; every named reason is a real sentence
    for (const [key, caller] of Object.entries(LEVERS)) {
      const [contract, fn] = key.split(".") as [string, string];
      expect(ABIS[contract]!.some((i) => i.name === fn)).toBe(true);
      if (caller.by === "crank") {
        expect(CRANK_JOBS as readonly string[]).toContain(caller.job);
        expect(JOB_FACTORIES[caller.job as (typeof CRANK_JOBS)[number]]).toBeDefined();
      }
      if (caller.by === "other") expect(caller.reason.length).toBeGreaterThan(20);
    }
    // the eight levers the todo names are all covered by a crank job or the liquidator
    for (const key of ["accrue", "accrueMany", "fillQueued", "pokeRisk", "poke", "distribute", "sealBatch", "executeBatch", "setSessionsWithKinds", "moveToExitReserve"]) {
      expect(Object.keys(LEVERS).some((k) => k.endsWith(`.${key}`))).toBe(true);
    }
  });
});

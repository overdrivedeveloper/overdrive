import { describe, expect, test } from "bun:test";
import { toHex } from "viem";
import { GEAR_TSLA, LIQUIDATOR_ACCOUNT, liquidationWorld } from "../testing/mock-backer";
import { MARKET_TSLA, WAD } from "../testing/mock-chain";
import { liquidatorAddresses, verifyOnChain } from "./batch";
import { priceDecision } from "./policy";

const reason = (t: string) => toHex(t, { size: 32 });

function setup() {
  const w = liquidationWorld();
  // deep under water: 100 USD of debt, 50 USDG of collateral
  const id = w.backer.openVault(GEAR_TSLA, 50n * 10n ** 6n, 100n * WAD);
  const verify = () => verifyOnChain(w.backer.clients(LIQUIDATOR_ACCOUNT), [{ vaultId: id, gearId: GEAR_TSLA, owner: "x", collateralUsdg: 0n, debtTokens: 0n, healthHint: null, indexAgeS: null }], liquidatorAddresses(w.chain.deployment.contracts));
  return { ...w, id, verify };
}

describe("price policy (R4)", () => {
  test("stale_halted_split_or_no_reference_skips", async () => {
    const cases: [Partial<{ fresh: boolean; buysPaused: boolean; reason: `0x${string}`; refP: bigint }>, string][] = [
      [{ fresh: false }, "stale"],
      [{ buysPaused: true, reason: reason("HALTED") }, "halted"],
      [{ buysPaused: true, reason: reason("SPLIT_PENDING") }, "split_pending"],
      [{ buysPaused: true, reason: reason("CONTINUITY") }, "continuity"],
      [{ buysPaused: true, reason: reason("REF_UNAVAILABLE") }, "no_reference"],
      [{ refP: 0n }, "no_reference"],
    ];
    for (const [patch, verdict] of cases) {
      const s = setup();
      Object.assign(s.chain.prices.get(MARKET_TSLA)!, patch);
      const [v] = await s.verify();
      expect(v!.verdict).toBe(verdict as never);
      expect(v!.reason).toBeTruthy();
    }
    // a manual buy pause is not a price doubt: the liquidation of existing vaults goes on
    const s = setup();
    Object.assign(s.chain.prices.get(MARKET_TSLA)!, { buysPaused: true, reason: reason("MANUAL") });
    expect((await s.verify())[0]!.verdict).toBe("liquidatable");
  });

  test("closed_market_uses_chain_verdict_only", async () => {
    const s = setup();
    // closed with a held last-good price (fresh inside maxAgeClosed): the contract's health() is the verdict
    Object.assign(s.chain.prices.get(MARKET_TSLA)!, { session: 2, fresh: true });
    const [v] = await s.verify();
    expect(v!.verdict).toBe("liquidatable");
    expect(v!.closedMarket).toBe(true);
    // the off-chain world says the price crashed further, but the contract's held value says healthy: healthy it is
    s.backer.vaults.get(s.id)!.collateralUsdg = 300n * 10n ** 6n;
    s.chain.prices.get(MARKET_TSLA)!.p = 1n;
    expect((await s.verify())[0]!.verdict).toBe("recovered");
    // closed and past the held-price age: not fresh, nothing happens
    Object.assign(s.chain.prices.get(MARKET_TSLA)!, { fresh: false, p: 100n * WAD });
    s.backer.vaults.get(s.id)!.collateralUsdg = 1n;
    expect((await s.verify())[0]!.verdict).toBe("stale");
    expect(priceDecision({ p: WAD, refP: WAD, session: 2, fresh: true, buysPaused: false, reason: `0x${"0".repeat(64)}`, updatedAt: 0n })).toEqual({ ok: true, closed: true });
  });
});

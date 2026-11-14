import { beforeEach, describe, expect, test } from "bun:test";
import { FakeChain, MARKET_ETH, MARKET_NVDA, MARKET_TSLA, REASON, STOCK_TSLA, WAD, nullSql } from "../testing/mock-chain";
import { resetAlertMemory, setAlertSender, type Alert } from "./alerts";
import { createPokeJob } from "./jobs/poke";

let chain: FakeChain;
const alerts: Alert[] = [];
beforeEach(() => {
  chain = new FakeChain();
  for (const m of [MARKET_TSLA, MARKET_NVDA, MARKET_ETH]) chain.addMarketPrice(m);
  alerts.length = 0;
  resetAlertMemory();
  setAlertSender(async (a) => { alerts.push(a); });
});
const pokes = () => chain.sent.filter((s) => s.name === "poke");

describe("poke", () => {
  test("pokes_on_cadence_and_faster_near_a_split", async () => {
    const poke = createPokeJob(chain.context(nullSql));
    const first = await poke();
    expect(first.poked).toBe(3);
    // within 5 minutes nothing is due
    chain.warp(120);
    expect((await poke()).poked).toBe(0);
    chain.warp(200);
    expect((await poke()).poked).toBe(3);
    // a pending uiMultiplier change on TSLA makes it every minute
    chain.stock.set(STOCK_TSLA, { ui: WAD, pending: 2n * WAD, effectiveAt: chain.nowSeconds + 3600n });
    chain.warp(61);
    const near = await poke();
    expect(near.poked).toBe(3);
    expect(near.pendingMultiplierChanges).toEqual(["TSLA"]);
    chain.warp(61);
    expect((await poke()).poked).toBe(3);
    // a forced pass (right after a session boundary) pokes at once
    expect((await poke(true)).poked).toBe(3);
    expect(pokes().length).toBe(3 + 3 + 3 + 3 + 3);
  });

  test("alerts_on_halt_and_split_reasons_and_never_sets_multiplier", async () => {
    chain.prices.get(MARKET_TSLA)!.reason = REASON.SPLIT_PENDING;
    chain.prices.get(MARKET_TSLA)!.buysPaused = true;
    chain.prices.get(MARKET_NVDA)!.reason = REASON.HALTED;
    chain.stock.set(STOCK_TSLA, { ui: WAD, pending: 2n * WAD, effectiveAt: chain.nowSeconds + 3600n });
    const result = await createPokeJob(chain.context(nullSql))();
    expect(result.alerts).toEqual(["SPLIT_PENDING:TSLA", "HALTED:NVDA"]);
    expect(alerts.map((a) => a.key)).toEqual(["guard:SPLIT_PENDING:TSLA", "guard:HALTED:NVDA"]);
    expect(alerts[0]!.text).toContain("TSLA");
    expect(alerts[1]!.level).toBe("critical");
    // the only call the job ever sends is poke(market): no multiplier is applied by the crank, so none can be applied twice
    expect(chain.sent.length).toBeGreaterThan(0);
    expect(chain.sent.every((s) => s.contract === "ODOracleGuard" && s.name === "poke")).toBe(true);
    expect(chain.stock.get(STOCK_TSLA)!.ui).toBe(WAD);
  });

  test("one_failing_market_does_not_stop_the_others", async () => {
    chain.failing.add(`poke:${MARKET_TSLA}`);
    const result = await createPokeJob(chain.context(nullSql))();
    expect(result.poked).toBe(2);
    expect((result.failed as string[]).length).toBe(1);
  });
});

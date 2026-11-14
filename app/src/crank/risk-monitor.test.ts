import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { FakeChain, MARKET_TSLA, WAD } from "../testing/mock-chain";
import { resetAlertMemory, setAlertSender, type Alert } from "./alerts";
import { createRiskMonitorJob, evaluateRisk, type ChainRiskView, type RiskInputs } from "./jobs/risk-monitor";

const suite = testDatabaseUrl() ? describe : describe.skip;
const USDG = 10n ** 6n;

/** A toy ERC-4626 with the Governor's rules: internal NAV accounting (a plain transfer changes nothing) and virtual shares. */
class ToyVault {
  tracked = 0n; supply = 0n; balance = 0n;
  readonly offset = 10n ** 6n;
  donate(x: bigint) { this.balance += x; }
  deposit(a: bigint) { const shares = (a * (this.supply + this.offset)) / (this.tracked + 1n); this.tracked += a; this.balance += a; this.supply += shares; }
  convertToAssets(shares: bigint) { return (shares * (this.tracked + 1n)) / (this.supply + this.offset); }
  get naivePrice() { return this.supply === 0n ? 0n : (this.balance * 10n ** 12n) / this.supply; }
}

suite("risk-monitor", () => {
  let db: TestDatabase;
  let chain: FakeChain;
  const alerts: Alert[] = [];
  beforeAll(async () => { db = (await createTestDatabase("riskmon"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => db.close(), 60_000);
  let paused = false;
  let price = 10n ** 12n; // share price, 12 dp
  let reserve = 500n * USDG, floor = 100n * USDG, hedgeStale = false;
  const setLedger = async (equity: bigint, peak = equity) => {
    await db.sql`truncate governor_ledger, exit_reserve_log`;
    await db.sql`delete from service_status where job = 'indexer'`;
    await db.sql`insert into governor_ledger (ts, underlying, delta, gamma, hedge_delta, equity, exit_reserve, block) values (now() - interval '1 day', 'TSLA', 0, 0, 0, ${peak.toString()}, 0, 1), (now(), 'TSLA', 0, 0, 0, ${equity.toString()}, 0, 2)`;
    await db.sql`insert into exit_reserve_log (ts, block, balance, "floor") values (now(), 2, ${reserve.toString()}, ${floor.toString()})`;
    await db.sql`insert into service_status (job, last_ok, last_run) values ('indexer', now(), now())`;
  };
  beforeEach(() => {
    chain = new FakeChain();
    chain.nowSeconds = BigInt(Math.floor(Date.now() / 1000)); // the indexed rows use database time
    chain.addMarketPrice(MARKET_TSLA);
    chain.roles.add("*");
    paused = false; price = 10n ** 12n; reserve = 500n * USDG; floor = 100n * USDG; hedgeStale = false;
    alerts.length = 0; resetAlertMemory(); setAlertSender(async (a) => { alerts.push(a); });
    const r = chain.readers;
    r.set("ODGovernor.decimals", () => 12);
    r.set("ODGovernor.convertToAssets", () => price);
    r.set("ODGovernor.exitReserve", () => reserve);
    r.set("ODGovernor.exitReserveFloor", () => floor);
    r.set("ODGovernor.stressLoss", () => [0n, 100n * WAD]);
    r.set("ODGovernor.hedgeStale", () => hedgeStale);
    r.set("ODGovernor.buysPaused", () => [paused, "0x" + "00".repeat(32)]);
    chain.mutators.set("ODGovernor.setBuysPaused", (args) => { paused = args[0] as boolean; return 80_000n; });
  });
  const make = (autopause: boolean) => {
    const ctx = chain.context(db.sql, { CRANK_AUTOPAUSE: autopause ? "1" : "0" });
    // the crank key (the mock never signs) holds the guardian role through "*"
    ctx.clients = { ...ctx.clients, walletClient: { account: { address: "0x00000000000000000000000000000000000000c1" } } } as never;
    return createRiskMonitorJob(ctx);
  };
  const names = () => chain.sent.map((s) => `${s.name}${s.name === "setBuysPaused" ? `(${s.args[0]})` : ""}`);

  test("donation_scenario_does_not_pause", async () => {
    const vault = new ToyVault();
    const job = make(true);
    const naive: bigint[] = [];
    const real: bigint[] = [];
    const step = async () => {
      price = vault.convertToAssets(10n ** 12n);
      real.push(price);
      naive.push(vault.naivePrice);
      await setLedger(vault.tracked * 10n ** 12n || WAD);
      const r = await job();
      expect(r.agreed).toEqual([]);
      expect(r.paused).toBe(false);
    };
    vault.deposit(1_000n * USDG);       // seed by deposit only (never a transfer)
    await step();
    vault.donate(5_000_000n * USDG);    // a plain transfer into the Governor: no NAV change, no share price change
    await step();
    vault.deposit(1n);                  // a tiny deposit
    await step();
    vault.deposit(2_000_000n * USDG);   // a large one
    await step();
    // the vault's own price stayed flat; "equity / totalSupply" would have swung wildly, which is the hazard VAULT-1 names
    const spread = (xs: bigint[]) => Number(xs.reduce((a, b) => (a > b ? a : b)) - xs.reduce((a, b) => (a < b ? a : b))) / Number(xs[0]);
    expect(spread(real)).toBeLessThan(0.01);
    expect(spread(naive.filter((n) => n > 0n))).toBeGreaterThan(0.5);
    expect(names().every((n) => n === "pokeRisk")).toBe(true);
    expect(paused).toBe(false);
  });

  test("real_loss_pauses_when_both_agree", async () => {
    const job = make(true);
    await setLedger(1_000n * WAD);
    expect((await job()).paused).toBe(false);            // healthy pass records the share-price peak
    price = 7n * 10n ** 11n;                              // the vault's price falls 30%
    await setLedger(700n * WAD, 1_000n * WAD);            // and the indexed equity shows the same loss
    const result = await job();
    expect(result).toMatchObject({ paused: true, agreed: ["drawdown"] });
    expect(names()).toEqual(["pokeRisk", "pokeRisk", "setBuysPaused(true)"]);
    expect(paused).toBe(true);
    const log = await db.sql<{ scope: string; action: string; reason: string }[]>`select scope, action, reason from pause_log`;
    expect(log).toMatchObject([{ scope: "global", action: "pause" }]);
    expect(log[0]!.reason).toContain("drawdown");
    const critical = alerts.find((a) => a.level === "critical")!;
    expect(critical.text).toContain("48 h timelock");
    // already paused: no second pause transaction
    await job();
    expect(names().filter((n) => n.startsWith("setBuysPaused")).length).toBe(1);
  });

  test("disagreement_alerts_only", async () => {
    const job = make(true);
    await setLedger(1_000n * WAD);
    await job();
    price = 6n * 10n ** 11n;                              // the contract says -40%
    await setLedger(1_000n * WAD);                        // the indexed equity says nothing happened
    const result = await job();
    expect(result).toMatchObject({ paused: false, agreed: [], disagreed: ["drawdown"] });
    expect(names().some((n) => n.startsWith("setBuysPaused"))).toBe(false);
    expect(alerts.some((a) => /one view only/.test(a.text))).toBe(true);
    // a stale indexer snapshot cannot confirm anything either
    await setLedger(600n * WAD, 1_000n * WAD);
    await db.sql`update service_status set last_ok = now() - interval '2 hours' where job = 'indexer'`;
    expect((await job())).toMatchObject({ paused: false, agreed: [] });
    // both agree but autopause is off: alert only
    await setLedger(600n * WAD, 1_000n * WAD);
    const off = await make(false)();
    expect(off).toMatchObject({ paused: false, agreed: ["drawdown"] });
    expect(alerts.some((a) => /autopause is off/.test(a.text))).toBe(true);
  });

  test("only_pause_calls_are_ever_sent", async () => {
    const job = make(true);
    reserve = 10n * USDG;                                  // exit reserve far under its floor on both views
    hedgeStale = true;
    await setLedger(1_000n * WAD);
    await job();
    await job();
    for (const sent of chain.sent) {
      expect(["pokeRisk", "setBuysPaused"]).toContain(sent.name);
      expect(sent.contract).toBe("ODGovernor");
      if (sent.name === "setBuysPaused") expect(sent.args).toEqual([true]);
    }
    expect(names()).toContain("setBuysPaused(true)");
  });

  test("evaluate_risk_is_pure_and_symmetric", () => {
    const inputs: RiskInputs = { equity: 700n, peakEquity: 1000n, exitReserve: 100n, exitReserveFloor: 100n, stressLoss: null, stressBudget: null, hedgerDownSeconds: 2000, snapshotAgeSeconds: 10 };
    const view: ChainRiskView = { sharePrice: 70n, peakSharePrice: 100n, exitReserve: 100n, exitReserveFloor: 100n, stressLoss: 5n, stressBudget: 1n, hedgeStale: true };
    const r = evaluateRisk(inputs, view);
    expect(r.agreed.map((t) => t.name).sort()).toEqual(["drawdown", "hedge_stale"]);
    expect(r.disagreed.map((t) => t.name)).toEqual(["stress_over_budget"]);
    expect(r.agreed.find((t) => t.name === "hedge_stale")!.pausable).toBe(false);
    expect(r.triggers.length).toBe(3);
  });
});

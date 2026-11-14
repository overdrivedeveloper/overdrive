import { beforeEach, describe, expect, test } from "bun:test";
import { parseEther, type Address } from "viem";
import { FakeChain, nullSql } from "../testing/mock-chain";
import { resetAlertMemory, setAlertSender, type Alert } from "./alerts";
import { createGasWatchJob, watchedWallets, type WatchedWallet } from "./jobs/gas-watch";

describe("gas-watch", () => {
  const alerts: Alert[] = [];
  beforeEach(() => { alerts.length = 0; resetAlertMemory(); setAlertSender(async (a) => { alerts.push(a); }); });
  const crank = "0x00000000000000000000000000000000000000c1" as Address;
  const hedger = "0x00000000000000000000000000000000000000c2" as Address;
  const wallets: WatchedWallet[] = [{ bot: "crank", address: crank, minWei: parseEther("0.01") }, { bot: "hedger", address: hedger, minWei: parseEther("0.01") }];

  test("below_min_realerts_after_window", async () => {
    const chain = new FakeChain();
    chain.balances.set(crank, parseEther("0.001"));
    chain.balances.set(hedger, parseEther("1"));
    let now = 1_000_000_000_000;
    const notes: string[] = [];
    const job = createGasWatchJob(chain.context(nullSql, { GAS_WATCH_REALERT_HOURS: "6" }), { wallets, nowMs: () => now, notify: async (t) => { notes.push(t); } });
    expect(await job()).toMatchObject({ below: ["crank"] });
    expect(alerts.map((a) => a.key)).toEqual(["gas:crank"]);
    expect(alerts[0]!.text).toContain(crank);
    // 5 hours later: still the same alert, no repeat
    now += 5 * 3_600_000;
    await job();
    expect(alerts.length).toBe(1);
    // past 6 hours: it repeats
    now += 1.1 * 3_600_000;
    await job();
    expect(alerts.length).toBe(2);
    // topped up: one recovery note, no alert
    chain.balances.set(crank, parseEther("0.5"));
    await job();
    expect(notes.length).toBe(1);
    expect(alerts.length).toBe(2);
    expect(chain.sent.length).toBe(0);
  });

  test("watches_every_configured_role_by_public_address_only", () => {
    const ctx = chain0().context(nullSql);
    expect(watchedWallets(ctx, {})).toEqual([]);
    const found = watchedWallets(ctx, { NODE_ENV: "development", CRANK_PRIVATE_KEY: `0x${"11".repeat(32)}`, HEDGER_PRIVATE_KEY: `0x${"22".repeat(32)}` });
    expect(found.map((w) => w.bot)).toEqual(["crank", "hedger"]);
    expect(JSON.stringify(found, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("1111111111");
  });
});
const chain0 = () => new FakeChain();

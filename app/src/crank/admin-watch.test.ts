import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { FakeChain } from "../testing/mock-chain";
import { resetAlertMemory, setAlertSender, type Alert } from "./alerts";
import { createAdminWatchJob } from "./jobs/admin-watch";

const suite = testDatabaseUrl() ? describe : describe.skip;
suite("admin-watch", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("adminwatch"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => db.close(), 60_000);

  test("alerts_and_never_sends", async () => {
    const chain = new FakeChain();
    const alerts: Alert[] = [];
    resetAlertMemory();
    setAlertSender(async (a) => { alerts.push(a); });
    const owner = chain.deployment.admin.ownerSafe;
    let code: `0x${string}` = "0x";
    const ctx = chain.context(db.sql);
    (ctx.clients.stateClient as unknown as { getCode: (a: { address: string }) => Promise<string> }).getCode = async ({ address }) => (address === owner ? code : "0x");
    const job = createAdminWatchJob(ctx);
    expect(await job()).toMatchObject({ events: 0, alerts: 0 });
    // a timelock schedule, an execute, a cancel and a guardian pause arrive through the indexer
    await db.sql`insert into admin_events (tx_hash, log_index, block, ts, source, kind, op_id, target, eta) values
      ('0xaa', 0, 10, now(), 'timelock', 'scheduled', '0x01', '0x00000000000000000000000000000000000000e1', now() + interval '2 days'),
      ('0xab', 0, 11, now() + interval '1 second', 'timelock', 'executed', '0x01', '0x00000000000000000000000000000000000000e1', null),
      ('0xac', 0, 12, now() + interval '2 seconds', 'timelock', 'cancelled', '0x02', null, null)`;
    await db.sql`insert into pause_log (ts, block, tx_hash, log_index, scope, ref, action, actor, reason) values (now() + interval '3 seconds', 13, '0xad', 0, 'global', null, 'pause', '0x0000000000000000000000000000000000000f01', 'governor')`;
    const result = await job();
    expect(result).toMatchObject({ events: 3, pauses: 1, alerts: 4 });
    expect(alerts.map((a) => a.text).join("\n")).toMatch(/scheduled a call[\s\S]*executed a call[\s\S]*cancelled a call[\s\S]*Buys paused/);
    // seen events are not alerted twice
    expect(await job()).toMatchObject({ events: 0, pauses: 0, alerts: 0 });
    // code appearing at the owner address alerts once
    code = "0x6001600055";
    expect(await job()).toMatchObject({ alerts: 1 });
    expect(alerts.at(-1)!.text).toContain("code");
    // the watcher never sends a transaction
    expect(chain.sent.length).toBe(0);
  });
});

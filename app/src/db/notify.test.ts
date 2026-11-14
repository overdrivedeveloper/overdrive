import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { listenOverdriveEvents, notifyOverdriveEvents, OD_EVENTS_CHANNEL } from "./notify";

const suite = testDatabaseUrl() ? describe : describe.skip;

suite("od_events notify", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("notify"))!; });
  afterAll(async () => db.close(), 60_000);

  test("payload bigints arrive as strings on the od_events channel", async () => {
    expect(OD_EVENTS_CHANNEL).toBe("od_events");
    const seen: unknown[] = [];
    const stop = await listenOverdriveEvents(db.sql, (event) => { seen.push(event); });
    await notifyOverdriveEvents(db.sql, { kinds: ["trade", "snapshot"], block: 12345678901234567890n });
    for (let i = 0; i < 50 && seen.length === 0; i++) await Bun.sleep(20);
    await stop();
    expect(seen).toEqual([{ kinds: ["trade", "snapshot"], block: "12345678901234567890" }]);
  });
});

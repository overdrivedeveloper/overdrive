import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { keccak256, toHex, type Hex } from "viem";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { FakeChain, MARKET_ETH, MARKET_TSLA } from "../testing/mock-chain";
import { createQueuedSellsJob } from "./jobs/queued-sells";

const suite = testDatabaseUrl() ? describe : describe.skip;
const GEAR: Hex = keccak256(toHex("gear-q"));
const GEAR_B: Hex = keccak256(toHex("gear-q2"));
const acct = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

suite("queued-sells", () => {
  let db: TestDatabase;
  let chain: FakeChain;
  beforeAll(async () => { db = (await createTestDatabase("queuedsells"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => db.close(), 60_000);
  beforeEach(async () => {
    await db.sql`truncate queued_sells, gears`;
    chain = new FakeChain();
    chain.nowSeconds = BigInt(Date.parse("2026-11-17T15:00:00Z") / 1000);
    chain.addGear({ id: GEAR, marketA: MARKET_ETH });
    chain.addGear({ id: GEAR_B, marketA: MARKET_TSLA });
    chain.addMarketPrice(MARKET_ETH); chain.addMarketPrice(MARKET_TSLA);
    chain.mutators.set("ODMinter.fillQueued", () => 120_000n);
  });
  const queue = (tickets: { ticket: number; gear?: Hex; account: number; tokens?: bigint }[]) =>
    db.sql`insert into queued_sells (ticket, gear, account, tokens, min_proceeds, queued_block, queued_at, status)
      select t.ticket, t.gear, t.account, t.tokens, 0, 1, now() - interval '5 minutes', 'open'
      from jsonb_to_recordset(${JSON.stringify(tickets.map((t) => ({ ticket: String(t.ticket), gear: t.gear ?? GEAR, account: acct(t.account), tokens: String(t.tokens ?? 10n ** 21n) })))}::jsonb)
        as t(ticket numeric, gear text, account text, tokens numeric)`;
  const job = (max = "25") => createQueuedSellsJob(chain.context(db.sql, { CRANK_QUEUE_MAX_PER_PASS: max }));
  const fills = () => chain.sent.filter((s) => s.name === "fillQueued");
  const markFilled = async () => { await db.sql`update queued_sells set status = 'filled' where ticket::text = any(${fills().map((s) => String(s.args[0]))})`; chain.sent.length = 0; };

  test("bounded_per_pass_and_per_seller", async () => {
    // 3 sellers with 10 tickets each on one gear: at most 4 per seller per pass
    await queue(Array.from({ length: 30 }, (_, i) => ({ ticket: i + 1, account: (i % 3) + 1 })));
    const run = job();
    const first = await run();
    expect(first.filled).toBe(12);
    const perSeller = new Map<string, number>();
    const rows = await db.sql<{ ticket: string; account: string }[]>`select ticket::text, account from queued_sells`;
    for (const s of fills()) perSeller.set(rows.find((r) => r.ticket === String(s.args[0]))!.account, (perSeller.get(rows.find((r) => r.ticket === String(s.args[0]))!.account) ?? 0) + 1);
    expect([...perSeller.values()].every((n) => n <= 4)).toBe(true);
    await markFilled();
    expect((await run()).filled).toBe(12);
    // the quota bounds a pass with many sellers: 100 sellers, one ticket each, quota 25
    await markFilled();
    await db.sql`truncate queued_sells`;
    await queue(Array.from({ length: 100 }, (_, i) => ({ ticket: 1000 + i, account: 100 + i })));
    const quota = await job("25")();
    expect(quota.attempted).toBe(25);
    expect(fills().length).toBe(25);
    expect(quota.deferred).toBeGreaterThan(0);
  });

  test("backoff_per_ticket", async () => {
    await queue([{ ticket: 1, account: 1 }, { ticket: 2, account: 2 }]);
    chain.failing.add("fillQueued:1");
    const run = job();
    const first = await run();
    expect(first).toMatchObject({ attempted: 2, filled: 1, notFillable: 1 });
    await markFilled();
    // ticket 1 is backing off 10 minutes; ticket 2 is filled, so nothing is tried
    chain.warp(300);
    expect((await run()).attempted).toBe(0);
    // after 10 minutes it is tried again, fails again, and the next wait doubles to 20 minutes
    chain.warp(301);
    expect((await run()).attempted).toBe(1);
    chain.warp(601);
    expect((await run()).attempted).toBe(0);
    chain.warp(601);
    expect((await run()).attempted).toBe(1);
    // once fixed it fills
    chain.failing.clear();
    chain.warp(3 * 3600);
    expect((await run()).filled).toBe(1);
  });

  test("flood_sends_at_most_quota", async () => {
    // a zero-ETH wallet queues 20,000 tickets that cannot fill: no transaction is ever sent (each fails at the estimate)
    await db.sql`insert into queued_sells (ticket, gear, account, tokens, min_proceeds, queued_block, queued_at, status)
      select g, ${GEAR}, ${acct(7)}, 1000000000000000000000, 0, 1, now(), 'open' from generate_series(1, 20000) g`;
    chain.failing.add("fillQueued");
    const run = job();
    let attempted = 0;
    for (let pass = 0; pass < 12; pass++) {
      const r = await run();
      attempted += r.attempted as number;
      expect(r.attempted as number).toBeLessThanOrEqual(25);
      if (pass === 0) expect(r.attempted).toBe(4);
      chain.warp(11 * 60);
    }
    expect(fills().length).toBe(0);
    expect(attempted).toBeLessThan(60);
    // a dust flood is tried one ticket per pass
    await db.sql`update queued_sells set tokens = 1000`;
    chain.warp(24 * 3600);
    expect((await run()).attempted).toBeLessThanOrEqual(1);
    // fillable tickets from 5,000 different wallets: a pass still sends at most the quota
    chain.failing.clear();
    await db.sql`truncate queued_sells`;
    await db.sql`insert into queued_sells (ticket, gear, account, tokens, min_proceeds, queued_block, queued_at, status)
      select g, ${GEAR_B}, '0x' || lpad(to_hex(g), 40, '0'), 1000000000000000000000, 0, 1, now(), 'open' from generate_series(1, 5000) g`;
    const flood = await job()();
    expect(fills().length).toBeLessThanOrEqual(25);
    expect(flood.filled).toBeLessThanOrEqual(25);
  });

  test("dust_tickets_one_per_pass", async () => {
    await queue(Array.from({ length: 6 }, (_, i) => ({ ticket: i + 1, account: i + 1, tokens: 1000n })));
    expect((await job()()).dust).toBe(1);
    expect(fills().length).toBe(1);
  });
});

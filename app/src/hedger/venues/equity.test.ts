import { describe, expect, test } from "bun:test";
import { createMemoryHedgerStore } from "../../db/queries/hedges";
import { usdgToWad } from "../../lib/fixed";
import { market, silent, USD } from "../test-support";
import { newPostState, runHedgePosts, type PostDeps } from "./equity";
import { MockVenue } from "./mock-venue";

const PX = (n: number) => BigInt(n) * 10n ** 18n;
const HOUR = 3_600_000;

function setup() {
  const hl = new MockVenue({ name: "hyperliquid", marks: { TSLA: PX(400), NVDA: PX(200) }, alwaysOpen: true, collateralUsd: USD(100_000) });
  const arcus = new MockVenue({ name: "arcus", marks: { TSLA: PX(400) }, alwaysOpen: true, postsEquity: false });
  const mem = createMemoryHedgerStore();
  const posts: { market: string; delta: bigint; equity: bigint; asOf: bigint }[] = [];
  const clock = { now: 1_800_000_000_000 };
  let refuse: Error | undefined;
  const deps: PostDeps = {
    markets: [market("NVDA"), market("TSLA")], venues: [hl, arcus], store: mem.store, logger: silent, now: () => clock.now, dryRun: false,
    state: newPostState(), chainTimeS: async () => Math.floor(clock.now / 1000) - 2,
    governorConfig: async () => ({ hedgeMaxAgeS: 7_200, maxHedgeJumpBps: 2_000 }),
    postHedge: async (m, delta, equity, asOf) => { if (refuse) throw refuse; posts.push({ market: m, delta, equity, asOf }); },
  };
  return { hl, arcus, mem, posts, clock, deps, refuseWith: (e?: Error) => { refuse = e; } };
}

describe("hedge posting", () => {
  test("posts_after_cycle_and_heartbeat_before_hedge_max_age", async () => {
    const { hl, arcus, posts, clock, deps } = setup();
    await hl.trade("TSLA", USD(60_000), { maxSlippageBps: 100, clientId: "a" });
    await arcus.trade("TSLA", USD(40_000), { maxSlippageBps: 100, clientId: "b" });
    await hl.trade("NVDA", USD(-20_000), { maxSlippageBps: 100, clientId: "c" });
    const r = await runHedgePosts(deps, new Set(["TSLA"]));
    expect(r.TSLA!.action).toBe("posted");
    expect(r.NVDA!.action).toBe("posted"); // first post for a hedged name is always due
    const tsla = posts.find((p) => p.market === market("TSLA").market)!;
    expect(tsla.delta).toBe(usdgToWad(USD(100_000)));          // both venues' position
    // Hyperliquid equity (100,000) split by |notional| on Hyperliquid: TSLA 60,000 of 80,000; Arcus equity is on chain
    expect(tsla.equity).toBe((USD(100_000) * USD(60_000)) / USD(80_000));
    expect(Number(tsla.asOf)).toBeLessThanOrEqual(Math.floor(clock.now / 1000));
    // nothing traded and under hedgeMaxAge / 2: not due
    clock.now += HOUR - 1_000;
    expect((await runHedgePosts(deps)).TSLA!.action).toBe("not_due");
    // at hedgeMaxAge / 2 (one hour of two): the heartbeat re-posts even with no trade, asOf never older than before
    clock.now += 1_000;
    const beat = await runHedgePosts(deps);
    expect(beat.TSLA!.action).toBe("posted");
    expect(posts.length).toBe(4);
    expect(posts[3]!.asOf).toBeGreaterThanOrEqual(posts[0]!.asOf);
    // dry run computes and posts nothing
    deps.dryRun = true;
    clock.now += 2 * HOUR;
    expect((await runHedgePosts(deps)).TSLA!.action).toBe("would_post");
    expect(posts.length).toBe(4);
  });

  test("fails_closed_and_alerts_with_time_left", async () => {
    const { hl, mem, posts, clock, deps } = setup();
    await hl.trade("TSLA", USD(50_000), { maxSlippageBps: 100, clientId: "a" });
    await runHedgePosts(deps);
    expect(posts).toHaveLength(1);
    clock.now += 90 * 60_000;
    hl.setHealthy(false);
    const r = await runHedgePosts(deps);
    expect(r.TSLA!.action).toBe("missed");
    expect(r.TSLA!.timeLeftS).toBe(7_200 - 90 * 60);           // time before the chain pauses buys
    expect(posts).toHaveLength(1);
    const sig = mem.signals.find((s) => s.kind === "hedge_post_missed" && s.open)!;
    expect(sig.detail.timeLeftS).toBe(1_800);
    // a read error fails closed too
    hl.setHealthy(true);
    const broken = Object.assign(Object.create(hl), { netPositionUsd: async () => { throw new Error("timeout"); } });
    const r2 = await runHedgePosts({ ...deps, venues: [broken] });
    expect(r2.TSLA!.action).toBe("missed");
    expect(r2.TSLA!.reason).toContain("unreadable");
    // an equity fall past the jump bound is never posted (the contract would refuse); a rise is clamped down
    const r3 = await runHedgePosts(deps);
    expect(r3.TSLA!.action).toBe("posted");
    deps.state.last.get("TSLA")!.equityUsd = USD(200_000);
    clock.now += 2 * 60 * 60_000;
    const r4 = await runHedgePosts(deps);
    expect(r4.TSLA!.action).toBe("missed");
    expect(r4.TSLA!.reason).toContain("maxHedgeJumpBps");
    deps.state.last.get("TSLA")!.equityUsd = USD(10_000);
    const r5 = await runHedgePosts(deps);
    expect(r5.TSLA!.action).toBe("posted");
    expect(r5.TSLA!.equityUsd).toBe(USD(12_000));
  });

  test("refusal_halts_an_hour", async () => {
    const { hl, posts, clock, deps, refuseWith } = setup();
    await hl.trade("TSLA", USD(50_000), { maxSlippageBps: 100, clientId: "a" });
    await hl.trade("NVDA", USD(50_000), { maxSlippageBps: 100, clientId: "b" });
    refuseWith(new Error("execution reverted: StressBudget(1, 2)"));
    const r = await runHedgePosts(deps);
    expect(r.NVDA!.action).toBe("halted");
    expect(r.TSLA).toBeUndefined();                              // the pass stops at the refusal
    refuseWith(undefined);
    clock.now += HOUR - 1;
    const held = await runHedgePosts(deps);
    expect(held.TSLA!.action).toBe("halted");
    expect(posts).toHaveLength(0);
    clock.now += 1;
    const back = await runHedgePosts(deps);
    expect(back.TSLA!.action).toBe("posted");
    expect(back.NVDA!.action).toBe("posted");
  });
});

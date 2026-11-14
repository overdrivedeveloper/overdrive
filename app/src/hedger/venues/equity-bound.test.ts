// Audit M-5 regression: the hedger used its own jump bound (5% of THIS market's last post, no transit), so one trade in
// a second market re-split venue equity, the service called it a fall "the contract would refuse" and never posted that
// market again (the chain went HEDGE_STALE). It now clamps to IODGovernor.hedgeJumpRange, the contract's exact rule.
// `ContractModel` is a line-by-line port of ODGovernorRisk.jumpRange/hedgeJump (window per hedgeMaxAge, transit 0).
import { describe, expect, test } from "bun:test";
import { createMemoryHedgerStore } from "../../db/queries/hedges";
import { market, silent, USD } from "../test-support";
import { newPostState, runHedgePosts, type PostDeps } from "./equity";
import { MockVenue } from "./mock-venue";

const PX = (n: number) => BigInt(n) * 10n ** 18n;
const HOUR = 3_600_000;

class ContractModel {
  posted = new Map<string, bigint>();
  w = { start: 0, net: 0n, anchor: 0n };
  refusals = 0;
  constructor(readonly equityUsd: bigint, readonly bps: bigint, readonly ageS: number, readonly nowS: () => number) {}
  private window() {
    const now = this.nowS();
    return this.w.start === 0 || now >= this.w.start + this.ageS ? { start: now, net: 0n, anchor: this.equityUsd } : { ...this.w };
  }
  range(m: string) {
    const w = this.window();
    const cap = (w.anchor * this.bps) / 10_000n;
    const rLo = w.net > 0n ? -cap : -cap - w.net;
    const rHi = w.net < 0n ? cap : cap - w.net;
    const prev = this.posted.get(m) ?? 0n;
    const lo = prev + rLo, hi = prev + rHi;
    return { lo: lo > 0n ? lo : 0n, hi: hi > 0n ? hi : 0n };
  }
  post(m: string, next: bigint) {
    const { lo, hi } = this.range(m);
    if (next < lo || next > hi) { this.refusals++; throw new Error(`execution reverted: HedgeJump(${this.posted.get(m) ?? 0n}, ${next}, 0)`); }
    const w = this.window();
    w.net += next - (this.posted.get(m) ?? 0n);
    this.w = w;
    this.posted.set(m, next);
  }
}

function setup(governorEquityUsd = USD(1_000_000)) {
  const hl = new MockVenue({ name: "hyperliquid", marks: { TSLA: PX(400), NVDA: PX(200) }, alwaysOpen: true, collateralUsd: USD(100_000) });
  const clock = { now: 1_800_000_000_000 };
  const chain = new ContractModel(governorEquityUsd, 500n, 7_200, () => Math.floor(clock.now / 1000) - 2);
  const posts: { market: string; equity: bigint }[] = [];
  const deps: PostDeps = {
    markets: [market("NVDA"), market("TSLA")], venues: [hl], store: createMemoryHedgerStore().store, logger: silent,
    now: () => clock.now, dryRun: false, state: newPostState(), chainTimeS: async () => Math.floor(clock.now / 1000) - 2,
    governorConfig: async () => ({ hedgeMaxAgeS: 7_200 }),
    jumpRange: async (m) => chain.range(m),
    postHedge: async (m, _d, equity) => { chain.post(m, equity); posts.push({ market: m, equity }); },
  };
  return { hl, posts, clock, deps, chain };
}

describe("audit M-5: the hedger applies the contract's jump rule", () => {
  test("a trade in NVDA no longer stops TSLA's posts (the audit PoC, flipped)", async () => {
    const { hl, posts, clock, deps, chain } = setup();
    await hl.trade("TSLA", USD(60_000), { maxSlippageBps: 100, clientId: "a" });
    await runHedgePosts(deps, new Set(["TSLA"]));
    await hl.trade("NVDA", USD(-60_000), { maxSlippageBps: 100, clientId: "b" });
    for (let h = 1; h <= 4; h++) {
      clock.now += HOUR;
      const r = await runHedgePosts(deps, new Set(["NVDA"]));
      expect(r.TSLA!.action).toBe("posted");
    }
    expect(posts.filter((p) => p.market === market("TSLA").market).length).toBe(5);
    expect(chain.refusals).toBe(0);
  });

  test("a fall larger than the bound is stepped down over windows, never skipped", async () => {
    const { hl, clock, deps, chain } = setup(USD(200_000)); // bound = 10,000 per 2 h window
    await hl.trade("TSLA", USD(60_000), { maxSlippageBps: 100, clientId: "a" });
    chain.w = { start: 0, net: 0n, anchor: 0n };
    chain.posted.set(market("TSLA").market, USD(100_000) - USD(10_000));
    deps.state.last.set("TSLA", { asOf: 0, atMs: clock.now, equityUsd: USD(90_000) });
    hl.setMark("TSLA", PX(200)); // venue equity falls 30,000 (100,000 -> 70,000): three times the bound
    let last = 0n;
    for (let i = 0; i < 4; i++) {
      clock.now += 2 * HOUR;
      const r = await runHedgePosts(deps, new Set(["TSLA"]));
      expect(r.TSLA!.action).toBe("posted");
      last = r.TSLA!.equityUsd!;
    }
    expect(last).toBe(await hl.marginEquityUsd());
    expect(chain.refusals).toBe(0);
  });

  test("fuzz: 300 seeded cycles of trades, marks and waits: never refused, never missed for the bound", async () => {
    let seed = 0x5eed_1234;
    const rnd = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
    for (let run = 0; run < 3; run++) {
      const { hl, clock, deps, chain } = setup(USD(200_000 + rnd(2_000_000)));
      for (let i = 0; i < 100; i++) {
        const name = rnd(2) === 0 ? "TSLA" : "NVDA";
        const k = rnd(3);
        if (k === 0) await hl.trade(name, USD(rnd(80_000) - 40_000), { maxSlippageBps: 100, clientId: `c${run}-${i}` });
        else if (k === 1) hl.setMark(name, PX(name === "TSLA" ? 300 + rnd(200) : 150 + rnd(100)));
        clock.now += rnd(3 * HOUR);
        const r = await runHedgePosts(deps, new Set([name]));
        for (const rep of Object.values(r)) {
          expect(rep.action === "halted").toBe(false);
          if (rep.action === "missed") expect(rep.reason ?? "").not.toContain("jump");
        }
      }
      expect(chain.refusals).toBe(0);
    }
  });
});

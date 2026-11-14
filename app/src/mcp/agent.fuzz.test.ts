import { expect, test } from "bun:test";
import type { Hex } from "viem";
import { MockRevert } from "../testing/mock-router";
import { routerCallFromIntent, sendRouterCall, type RouterCall } from "./agent";
import { ToolError } from "./api-client";
import { fakeApi, MARKET_NVDA, MARKET_TSLA, MINTER, NOW_S, NVDA_SPORT, OWNER, rig, ROUTER, SPORT } from "./test-support";

// Seeded xorshift: the same 300 cases every run.
function prng(seed: number) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; }; }

test("never_sends_policy_violation", async () => {
  const rand = prng(20_261_113);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  let sentCount = 0, refusedCount = 0;
  for (let i = 0; i < 300; i += 1) {
    const markets: Hex[] = [MARKET_TSLA, MARKET_NVDA].filter(() => rand() < 0.6);
    const policy = {
      budgetUsdg: BigInt(Math.floor(rand() * 20_000_000)), maxPerTradeUsdg: BigInt(Math.floor(rand() * 12_000_000)), expiresAt: NOW_S + Math.floor((rand() - 0.2) * 7200),
      canSell: rand() < 0.5, canBack: rand() < 0.5, markets,
    };
    const r = rig({ policy });
    if (rand() < 0.1) r.router.revoke(OWNER, r.agent.account.address);
    for (let t = 0; t < 4; t += 1) {
      const gear = pick([SPORT, NVDA_SPORT] as const);
      const gearMarkets = [gear === SPORT ? MARKET_TSLA : MARKET_NVDA];
      const kind = pick(["buy", "sell", "back"] as const);
      const amount = BigInt(1 + Math.floor(rand() * 9_000_000));
      let call: RouterCall;
      if (kind === "back") call = routerCallFromIntent("back", { gearId: gear, vaultId: 0n, collateralUsdg: amount, mintTokens: 0n, minProceedsUsdg: 0n, deadline: BigInt(NOW_S + 300) }, OWNER, { gearId: gear, markets: gearMarkets });
      else call = routerCallFromIntent(kind, (await fakeApi().post(`/v1/intent/${kind}`, { gear, account: OWNER, usdg: amount.toString(), tokens: amount.toString(), minOut: "1", recipient: OWNER, deadlineSec: 300 })) as any, OWNER, { gearId: gear, minter: MINTER, markets: gearMarkets });
      // The oracle states the policy independently of the code under test.
      const p = r.router.policies.get(`${OWNER.toLowerCase()}:${r.agent.account.address.toLowerCase()}`)!;
      const forbidden = p.revoked || BigInt(NOW_S) >= p.expiresAt || (kind === "sell" && !p.canSell) || (kind === "back" && !p.canBack) || !markets.includes(gearMarkets[0]!)
        || (kind !== "sell" && (amount > p.maxPerTradeUsdg || p.spentUsdg + amount > p.budgetUsdg));
      const before = r.sent.length;
      const outcome = await sendRouterCall(r.agent, ROUTER, call, OWNER).then(() => "sent" as const, (e) => e);
      // Never a transaction the router would revert for policy reasons: a MockRevert here would mean it was signed and sent.
      expect(outcome instanceof MockRevert).toBe(false);
      if (forbidden) { expect(outcome).toBeInstanceOf(ToolError); expect(r.sent.length).toBe(before); refusedCount += 1; }
      else { expect(outcome).toBe("sent"); expect(r.sent.length).toBe(before + 1); sentCount += 1; }
    }
  }
  expect(sentCount).toBeGreaterThan(50);
  expect(refusedCount).toBeGreaterThan(200);
});

import { describe, expect, test } from "bun:test";
import { keccak256, toHex, type Hex } from "viem";
import { FakeChain, MARKET_ETH, MARKET_NVDA, MARKET_TSLA, WAD, nullSql } from "../testing/mock-chain";
import { createTollJob } from "./jobs/toll";

function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

describe("toll invariant", () => {
  test("no_gear_left_stale", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed);
      const chain = new FakeChain();
      chain.nowSeconds = BigInt(Date.parse("2026-11-16T03:00:00Z") / 1000);
      const markets = [MARKET_ETH, MARKET_TSLA, MARKET_NVDA];
      const ids: Hex[] = [];
      for (let i = 0; i < 25; i++) {
        const id = keccak256(toHex(`fuzz-${seed}-${i}`));
        ids.push(id);
        chain.addGear({ id, marketA: markets[i % 3]!, lastAccrual: chain.nowSeconds - BigInt(Math.floor(rand() * 7000)), supply: rand() < 0.2 ? 0n : WAD, tollPerSecWad: 1_000n });
      }
      chain.gasLimit = 60_000n + 90_000n * BigInt(8 + Math.floor(rand() * 40));
      const ctx = chain.context(nullSql);
      const maxAge = BigInt(ctx.config.CRANK_TOLL_MAX_AGE_SECONDS);
      const interval = 300n;
      const toll = createTollJob(ctx);
      for (let step = 0; step < 60; step++) {
        // random trades (a trade accrues the gear and may change supply) and a time jump of up to 3 h
        for (const id of ids) if (rand() < 0.15) { const g = chain.gears.get(id)!; g.lastAccrual = chain.nowSeconds; if (rand() < 0.3) g.supply = rand() < 0.5 ? 0n : WAD * BigInt(1 + Math.floor(rand() * 9)); }
        chain.warp(rand() < 0.1 ? Math.floor(rand() * 10_800) : Number(interval));
        await toll();
        for (const g of chain.gears.values()) {
          if (g.supply === 0n) continue;
          expect(chain.nowSeconds - g.lastAccrual).toBeLessThanOrEqual(maxAge + interval);
        }
      }
    }
  });
});

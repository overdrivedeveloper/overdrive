import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApiChain, GEAR_POOL_FEE, GEAR_POOL_TICK_SPACING, gearPoolKey } from "./chain-reads";

const USDG = "0x00000000000000000000000000000000000000a1";
const TOKEN = "0x00000000000000000000000000000000000000b2";
const HOOK = "0x00000000000000000000000000000000000000c3";
const GEAR = `0x${"11".repeat(32)}`;

test("pool_key_fee_and_spacing_match_the_hook_source", () => {
  const src = readFileSync(new URL("../../../contracts/src/hook/ODHook.sol", import.meta.url), "utf8");
  expect(GEAR_POOL_FEE).toBe(Number(/POOL_FEE\s*=\s*(\d+)/.exec(src)![1]));
  expect(GEAR_POOL_TICK_SPACING).toBe(Number(/TICK_SPACING\s*=\s*(\d+)/.exec(src)![1]));
  const key = gearPoolKey(USDG, TOKEN, HOOK);
  expect(key).toEqual({ currency0: USDG, currency1: TOKEN, fee: 0, tickSpacing: 60, hooks: HOOK });
  expect(gearPoolKey(TOKEN, USDG, HOOK).currency0).toBe(USDG);
});

test("quoter_sends_the_hook_pool_key_for_buy_and_sell", async () => {
  const seen: any[] = [];
  const client = {
    getBlockNumber: async () => 7n,
    readContract: async (r: any) => { seen.push(r.args[0]); return [5n, 0n]; },
  } as any;
  const deployment = { contracts: { ODMinter: HOOK, ODGovernor: HOOK, ODBacker: HOOK, ODHook: HOOK }, external: { usdg: USDG, v4Quoter: HOOK }, gears: [{ id: GEAR, token: TOKEN }] } as any;
  const chain = createApiChain(client, deployment);
  for (const side of ["buy", "sell"] as const) {
    const q = await chain.quoter.quote({ gear: GEAR, side, exactIn: 10n } as any);
    expect(q.amountOut).toBe(5n);
  }
  expect(seen[0].poolKey.fee).toBe(0);
  expect(seen[1].poolKey.fee).toBe(0);
  expect(seen[0].zeroForOne).toBe(true);
  expect(seen[1].zeroForOne).toBe(false);
});

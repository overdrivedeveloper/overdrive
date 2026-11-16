import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { harness } from "./test-support";

const h = await harness("norpc");
afterAll(async () => { await h?.close(); });

test("list_routes_make_no_rpc_calls", async () => {
  if (!h) return;
  await h.seedIndexer();
  await h.seedGear("TSLA-SPORT", { sigmaBps: 6000, toll: 11_000_000_000n, valueWad: 100n * 10n ** 18n, supply: 5n * 10n ** 18n });
  const paths = ["/health", "/v1/gears", "/v1/gears/TSLA-SPORT", "/v1/gears/TSLA-SPORT/history?range=30d", "/v1/tolls", "/v1/tolls/formula", "/v1/governor/history?range=7d",
    "/v1/status", "/v1/config", "/v1/risk", "/v1/hedges", "/v1/account/0x00000000000000000000000000000000000a11ce", "/openapi.json", "/docs"];
  for (const p of paths) expect((await h.app.request(p)).status).toBe(200);
  const c = h.chain.calls;
  expect(c.quote + c.minter + c.other).toBe(0);
});

test("the list and history route sources import no chain client", () => {
  const dir = join(import.meta.dir, "routes");
  const rpcFree = ["gears.ts", "gear-history.ts", "tolls.ts", "governor-history.ts", "status.ts", "config.ts", "risk.ts", "hedges.ts", "account.ts", "health.ts", "stats.ts"];
  for (const f of readdirSync(dir).filter((n) => rpcFree.includes(n))) {
    const text = readFileSync(join(dir, f), "utf8");
    expect(text).not.toMatch(/deps\.chain|chain\/(clients|rpc-pool)|createPublicClient/);
  }
});

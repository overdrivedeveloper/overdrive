import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";

const suite = testDatabaseUrl() ? describe : describe.skip;
const APP = join(import.meta.dir, "..", "..");
const FIXTURE = join(APP, "src", "testing", "fixtures", "deployment.fork.json");

/** A JSON-RPC node that answers the few calls the indexer makes at boot. */
function fakeNode(chainId: number, client: string) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
      const answer = (call: { id: number; method: string; params?: unknown[] }) => {
        const result = ((): unknown => {
          switch (call.method) {
            case "eth_chainId": return `0x${chainId.toString(16)}`;
            case "web3_clientVersion": return client;
            case "eth_blockNumber": return "0x3";
            case "eth_getLogs": return [];
            case "eth_getBlockByNumber": {
              const n = parseInt(String(call.params?.[0]), 16);
              return { number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, parentHash: `0x${(n - 1).toString(16).padStart(64, "0")}`, timestamp: `0x${(1_700_000_000 + n).toString(16)}` };
            }
            default: return null;
          }
        })();
        return { jsonrpc: "2.0", id: call.id, result };
      };
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    },
  });
}

suite("indexer boot", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("boot"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => db.close(), 60_000);

  function env(rpc: string, extra: Record<string, string> = {}): Record<string, string> {
    const url = new URL(testDatabaseUrl()!);
    url.pathname = `/${db.name}`;
    return {
      ...(process.env as Record<string, string>), NODE_ENV: "test", NETWORK: "fork", CHAIN_ID: "31337", DATABASE_URL: url.toString(), DEPLOYMENT_FILE: FIXTURE,
      RPC_URL_OVERRIDE: rpc, RPC_ROUTE_LOGS: "public", RPC_ROUTE_STATE: "public", RPC_ROUTE_TX: "public", PUBLIC_RPC_URL: rpc, LOG_LEVEL: "silent", ...extra,
    };
  }

  test("boots_with_real_env_shape_and_refuses_wrong_chain", async () => {
    // wrong chain: the node says 4663 while CHAIN_ID is 31337
    const wrong = fakeNode(4663, "anvil/v1");
    const refused = Bun.spawn(["bun", "run", "src/bin/indexer.ts"], { cwd: APP, env: env(`http://127.0.0.1:${wrong.port}`), stdout: "pipe", stderr: "pipe" });
    expect(await refused.exited).toBe(1);
    const failure = await db.sql`SELECT last_error FROM service_status WHERE job = 'indexer'`;
    expect(failure[0]!.last_error).toContain("expected CHAIN_ID");
    wrong.stop(true);
    // a fork that is not anvil is refused too
    const notAnvil = fakeNode(31337, "nitro/v3");
    const refusedNode = Bun.spawn(["bun", "run", "src/bin/indexer.ts"], { cwd: APP, env: env(`http://127.0.0.1:${notAnvil.port}`), stdout: "pipe", stderr: "pipe" });
    expect(await refusedNode.exited).toBe(1);
    notAnvil.stop(true);

    // right chain: boots, ingests, writes service_status
    await db.sql`DELETE FROM service_status`;
    const node = fakeNode(31337, "anvil/v1.0.0");
    const child = Bun.spawn(["bun", "run", "src/bin/indexer.ts"], { cwd: APP, env: env(`http://127.0.0.1:${node.port}`), stdout: "pipe", stderr: "pipe" });
    let row: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !row; i++) {
      await Bun.sleep(100);
      row = (await db.sql`SELECT job, last_error, meta FROM service_status WHERE job = 'indexer' AND last_ok IS NOT NULL`)[0];
    }
    child.kill("SIGTERM");
    await child.exited;
    node.stop(true);
    expect(row?.job).toBe("indexer");
    expect(row?.last_error ?? null).toBeNull();
    expect(JSON.stringify(row?.meta)).toContain("config");
  }, 30_000);
});

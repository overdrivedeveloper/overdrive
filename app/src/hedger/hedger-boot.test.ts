// R19: the real entry point boots with the production env shape (keystore only), against an anvil-identifying node that
// serves the deployment's Governor and oracle reads, takes the lock, runs one cycle with the mock venue in dry run, and
// writes service_status job 'hedger'. The keystore is created here at run time; no key file is committed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, concat, decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { IODGovernorAbi, IODOracleGuardAbi } from "../abi";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";

const suite = testDatabaseUrl() ? describe : describe.skip;
const APP = join(import.meta.dir, "..", "..");
const FIXTURE = join(APP, "src", "testing", "fixtures", "deployment.fork.json");
const ACCESS = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);
const TSLA = keccak256(stringToHex("TSLA"));
const HEAD = 500;
const NOW_S = () => Math.floor(Date.now() / 1000);

function encrypt(key: Hex, password: string): string {
  const salt = randomBytes(32), iv = randomBytes(16);
  const dk = scryptSync(Buffer.from(password.normalize("NFKD")), salt, 32, { N: 16, r: 8, p: 1 });
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(Buffer.from(key.slice(2), "hex")), c.final()]);
  const mac = keccak256(concat([bytesToHex(new Uint8Array(dk.subarray(16, 32))), bytesToHex(new Uint8Array(ct))])).slice(2);
  return JSON.stringify({ version: 3, crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ct.toString("hex"), kdf: "scrypt", kdfparams: { dklen: 32, n: 16, r: 8, p: 1, salt: salt.toString("hex") }, mac } });
}

/** An anvil-identifying node: Governor exposure 200,000 USD long TSLA, equity 10,000,000, a fresh oracle, role granted. */
function fakeNode() {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
      const answer = (call: { id: number; method: string; params?: unknown[] }) => {
        const result = ((): unknown => {
          switch (call.method) {
            case "eth_chainId": return "0x7a69";
            case "web3_clientVersion": return "anvil/v1.0.0";
            case "eth_blockNumber": return `0x${HEAD.toString(16)}`;
            case "eth_getBlockByNumber": return {
              number: `0x${HEAD.toString(16)}`, hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}`, timestamp: `0x${NOW_S().toString(16)}`,
              transactions: [], gasLimit: "0x1", gasUsed: "0x0", baseFeePerGas: "0x1", miner: `0x${"00".repeat(20)}`, logsBloom: `0x${"00".repeat(256)}`,
              difficulty: "0x0", extraData: "0x", nonce: "0x0000000000000000", size: "0x1", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`,
              transactionsRoot: `0x${"00".repeat(32)}`, sha3Uncles: `0x${"00".repeat(32)}`, uncles: [], mixHash: `0x${"00".repeat(32)}`,
            };
            case "eth_call": {
              const data = (call.params?.[0] as { data?: Hex; input?: Hex }).data ?? (call.params?.[0] as { input: Hex }).input;
              for (const abi of [IODGovernorAbi, IODOracleGuardAbi, ACCESS] as const) {
                let fn: string;
                try { fn = decodeFunctionData({ abi, data }).functionName; } catch { continue; }
                calls.push(fn);
                if (fn === "exposure") return encodeFunctionResult({ abi: IODGovernorAbi, functionName: "exposure", result: [200_000n * 10n ** 18n, 50_000n * 10n ** 18n, 100_000n * 10n ** 18n] });
                if (fn === "equity") return encodeFunctionResult({ abi: IODGovernorAbi, functionName: "equity", result: 10_000_000n * 10n ** 18n });
                if (fn === "read") return encodeFunctionResult({ abi: IODOracleGuardAbi, functionName: "read", result: { p: 400n * 10n ** 18n, refP: 0n, session: 1, fresh: true, buysPaused: false, reason: `0x${"00".repeat(32)}`, updatedAt: BigInt(NOW_S()) } });
                if (fn === "hasRole") return encodeFunctionResult({ abi: ACCESS, functionName: "hasRole", result: true });
              }
              return "0x";
            }
            default: return null;
          }
        })();
        return { jsonrpc: "2.0", id: call.id, result };
      };
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    },
  });
  return { server, calls };
}

suite("hedger boot", () => {
  let db: TestDatabase;
  let dir: string;
  beforeAll(async () => { db = (await createTestDatabase("hedgerboot"))!; await applyMigrations(db); dir = mkdtempSync(join(tmpdir(), "od-hedger-boot-")); });
  afterAll(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

  test("boots_with_production_env_shape_and_runs_one_cycle", async () => {
    // the deployment fixture plus one listed underlying
    const deployment = JSON.parse(readFileSync(process.env.DEPLOYMENT_FILE ?? FIXTURE, "utf8"));
    deployment.markets = [{ id: TSLA, symbol: "TSLA", kind: "stock", feed: "0x0D60a5792aa62C61E5b749De34A325C30F9D9208", stockToken: null, multiplierEmbedded: false, pythId: null, twapPool: null, alwaysOpen: false }];
    const file = join(dir, "deployment.json");
    writeFileSync(file, JSON.stringify(deployment));
    const ks = join(dir, "hedger.json"), pw = join(dir, "hedger.password");
    const password = randomBytes(16).toString("hex");
    writeFileSync(ks, encrypt(generatePrivateKey(), password));
    writeFileSync(pw, `${password}\n`);
    chmodSync(ks, 0o440);
    chmodSync(pw, 0o440);
    // another role's keystore in the same environment: distinct from the hedger's, and stripped after the check
    const cks = join(dir, "crank.json");
    writeFileSync(cks, encrypt(generatePrivateKey(), password));
    chmodSync(cks, 0o440);
    // the indexed book agrees with the chain at the head block
    await db.sql`INSERT INTO governor_ledger (ts, underlying, delta, gamma, hedge_delta, equity, exit_reserve, block)
      VALUES (now(), 'TSLA', ${(200_000n * 1_000_000n).toString()}, ${(50_000n * 1_000_000n).toString()}, 0, ${(10_000_000n * 1_000_000n).toString()}, 0, ${HEAD - 1})`;

    const node = fakeNode();
    const rpc = `http://127.0.0.1:${node.server.port}`;
    const url = new URL(testDatabaseUrl()!);
    url.pathname = `/${db.name}`;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      NODE_ENV: "production", NETWORK: "fork", CHAIN_ID: "31337", DATABASE_URL: url.toString(), DEPLOYMENT_FILE: file,
      RPC_URL_OVERRIDE: rpc, PUBLIC_RPC_URL: rpc, RPC_ROUTE_LOGS: "public", RPC_ROUTE_STATE: "public", RPC_ROUTE_TX: "public",
      HEDGER_DRY_RUN: "1", HEDGER_VENUES: "mock", HEDGER_ENABLED_JOBS: "cycle,post,reconcile", HEDGER_CYCLE_SECONDS: "3600",
      HEDGER_KEYSTORE: ks, HEDGER_KEYSTORE_PASSWORD_FILE: pw, CRANK_KEYSTORE: cks, CRANK_KEYSTORE_PASSWORD_FILE: pw, LOG_LEVEL: "silent",
    };
    const child = Bun.spawn(["bun", "run", "src/bin/hedger.ts"], { cwd: APP, env, stdout: "pipe", stderr: "pipe" });
    let row: { meta: Record<string, unknown>; last_error: string | null } | undefined;
    for (let i = 0; i < 150 && !row; i++) {
      await Bun.sleep(100);
      row = (await db.sql<{ meta: Record<string, unknown>; last_error: string | null }[]>`SELECT meta, last_error FROM service_status WHERE job = 'hedger' AND meta ? 'cycleAt'`)[0];
      if (child.exitCode !== null) break;
    }
    const stderr = child.exitCode !== null ? await new Response(child.stderr).text() : "";
    child.kill("SIGTERM");
    const code = await child.exited;
    node.server.stop(true);
    const failure = (await db.sql`SELECT last_error FROM service_status WHERE job = 'hedger'`)[0]?.last_error ?? null;
    expect({ stderr, failure }).toEqual({ stderr: "", failure: null });
    expect(row?.last_error ?? null).toBeNull();
    expect(row?.meta.venueHealthy).toBe(true);
    expect(row?.meta.unhedged).toEqual({});
    expect(row?.meta.dryRun).toBe(true);
    expect(code).toBe(0);
    // it read the deployment's Governor, checked the role, and recorded the dry-run hedge
    expect(node.calls).toContain("exposure");
    expect(node.calls).toContain("hasRole");
    const cycles = await db.sql`SELECT underlying, action, reason, delta_usd::text AS delta FROM hedge_cycles`;
    expect(cycles.map((c) => [c.underlying, c.action, c.reason, c.delta])).toEqual([["TSLA", "would_trade", "dry_run", (200_000n * 1_000_000n).toString()]]);
    const hedges = await db.sql`SELECT dry, usd::text AS usd FROM hedges`;
    expect(hedges.map((h) => [h.dry, h.usd])).toEqual([[true, (200_000n * 1_000_000n).toString()]]);
  }, 120_000); // boots a real Postgres and the binary; 30 s timed out twice when the machine load was 14 to 23
});

// Fork stack rules (todo 22 R1 to R8). Offline by default: stub RPC servers on loopback, a temp FORK_DIR, random keys.
// With FORK_LIVE=1 (and PORT_OFFSET of a running stack) the live checks also run against the real fork stack.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const HERE = import.meta.dir;
const REAL_FORK_DIR = process.env.FORK_DIR ?? join(process.env.HOME ?? "", ".overdrive", "fork");
const LIVE = process.env.FORK_LIVE === "1";
const tmp = mkdtempSync(join(tmpdir(), "od-fork-test-"));
process.env.FORK_DIR = LIVE ? REAL_FORK_DIR : tmp;
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A temp anvil-accounts file with random keys (never anvil's real dev keys in a test file).
if (!LIVE) {
  const keys = Array.from({ length: 20 }, () => generatePrivateKey());
  writeFileSync(join(tmp, "anvil-accounts.json"), JSON.stringify({ available_accounts: keys.map((k) => privateKeyToAccount(k).address), private_keys: keys }));
}

const lib = await import("./lib");
const cache = await import("./rpc-cache");
const setup = await import("./setup");
const warm = await import("./warm");
const warp = await import("./warp");
const src = (f: string) => readFileSync(join(HERE, f), "utf8");
const baseConfig = JSON.parse(readFileSync(join(lib.ROOT, "contracts/script/config/fork.json"), "utf8"));

/** A loopback JSON-RPC stub: `answer(method, params)` returns a result, or a Response for raw HTTP errors. */
function stub(answer: (method: string, params: unknown[]) => unknown) {
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string; params: unknown[] };
      calls.push(body.method);
      const r = answer(body.method, body.params ?? []);
      if (r instanceof Response) return r;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: r });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

describe("fork stack", () => {
  test("refuses_wrong_chain_and_upstream_sends", async () => {
    // The cache never forwards a transaction, a signing call or an anvil/evm control method upstream.
    const up = stub(() => "0x1");
    const handle = cache.createHandler(up.url, new cache.RpcCache());
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sendRawTransactionSync", "eth_sign", "anvil_setBalance", "evm_increaseTime"]) {
      const r = (await handle({ jsonrpc: "2.0", id: 1, method, params: [] })) as { error?: { message: string } };
      expect(r.error?.message).toContain("never forwarded");
    }
    expect(up.calls).toEqual([]);
    // Only a local anvil on 31337 passes assertFork.
    const wrongChain = stub((m) => (m === "eth_chainId" ? "0x1237" : "anvil/v1.8.4"));
    await expect(lib.assertFork(wrongChain.url)).rejects.toThrow(/chain 4663/);
    const notAnvil = stub((m) => (m === "eth_chainId" ? "0x7a69" : "Geth/v1.14"));
    await expect(lib.assertFork(notAnvil.url)).rejects.toThrow(/not an anvil node/);
    const ok = stub((m) => (m === "eth_chainId" ? "0x7a69" : "anvil/v1.8.4"));
    await lib.assertFork(ok.url);
    expect(() => lib.forkClients("https://rpc.mainnet.chain.robinhood.com")).toThrow(/local node/);
    expect(lib.isLocalUrl("http://127.0.0.1:8545")).toBe(true);
    expect(lib.isLocalUrl("https://rpc.mainnet.chain.robinhood.com")).toBe(false);
    // up.sh: chain 31337, cancun, anvil forks the local cache (never the public URL), and checks chain id and client.
    const up_sh = src("up.sh");
    expect(up_sh).toContain("--chain-id 31337");
    expect(up_sh).toContain("--hardfork cancun");
    expect(up_sh).toMatch(/--fork-url "\$CACHE_URL"/);
    expect(up_sh).toContain('die "anvil is not chain 31337"');
    expect(up_sh).toContain("*anvil/*");
    expect(up_sh).toContain('ANVIL_URL must be local');
    for (const s of [up, wrongChain, notAnvil, ok]) s.stop();
  });

  test("warm_reads_listed_state_and_cache_serves_pinned_reads", async () => {
    const holder = lib.loadForkConfig().usdgHolder;
    const calls = warm.warmCalls(baseConfig, holder);
    const labels = calls.map((c) => c.label).join("\n");
    expect(labels).toContain("USDG totalSupply");
    expect(labels).toContain(`USDG balanceOf ${baseConfig.external.poolManager}`);
    expect(labels).toContain(`USDG balanceOf ${holder}`);
    for (const m of baseConfig.markets as { symbol: string; stockAsset: string; twapPool: string }[]) {
      expect(labels).toContain(`${m.symbol} feed latestRoundData`);
      if (!/^0x0+$/.test(m.stockAsset)) expect(labels).toContain(`${m.symbol} token uiMultiplier`);
      if (!/^0x0+$/.test(m.twapPool)) expect(labels).toContain(`${m.symbol} pool observe`);
    }
    const code = warm.warmCode(baseConfig, lib.loadForkConfig().warm.codeOnly).map((a) => a.toLowerCase());
    for (const k of ["usdg", "poolManager", "stateView", "v4Quoter", "pythCore"]) expect(code).toContain(baseConfig.external[k].toLowerCase());

    // Pinned reads: asked upstream once, then from memory, then from the disk file after a restart; 429 is retried.
    let n429 = 1;
    const up = stub((m) => {
      if (m === "eth_getStorageAt" && n429-- > 0) return new Response("slow down", { status: 429 });
      return m === "eth_blockNumber" ? "0x10" : "0x2a";
    });
    const file = join(tmp, "cache.jsonl");
    const handle = cache.createHandler(up.url, new cache.RpcCache(file));
    const pinned = { jsonrpc: "2.0", id: 7, method: "eth_getStorageAt", params: ["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "0x0", "0x6cd8f3b"] };
    expect(((await handle(pinned)) as { result: string }).result).toBe("0x2a");
    expect(((await handle(pinned)) as { result: string }).result).toBe("0x2a");
    expect(up.calls.filter((c) => c === "eth_getStorageAt").length).toBe(2); // one 429, one answer, no third
    const restarted = cache.createHandler(up.url, new cache.RpcCache(file));
    expect(((await restarted(pinned)) as { result: string }).result).toBe("0x2a");
    expect(up.calls.filter((c) => c === "eth_getStorageAt").length).toBe(2);
    // "latest" is never cached.
    expect(cache.cacheable({ method: "eth_getStorageAt", params: ["0x0", "0x0", "latest"] })).toBe(false);
    expect(cache.cacheable({ method: "eth_getStorageAt", params: ["0x0", "0x0", "0x10"] })).toBe(true);
    up.stop();
  });

  test("fund_does_not_touch_pool_manager_balance", async () => {
    const holder = lib.loadForkConfig().usdgHolder.toLowerCase();
    expect(holder).not.toBe(baseConfig.external.poolManager.toLowerCase());
    expect(holder).not.toMatch(/^0x0+$/);
    const f = src("fund.ts");
    expect(f).not.toMatch(/setStorageAt|anvil_setStorage|hardhat_setStorage/);
    expect(f).toContain("PoolManager is never a funding source");
    expect(f).toMatch(/pmAfter !== pmBefore/);
    if (LIVE) {
      const { fund } = await import("./fund");
      const target = privateKeyToAccount(generatePrivateKey()).address;
      const [r] = await fund([target], 10, 1); // throws if the PoolManager balance moved
      expect(r!.usdg).toBe(10_000_000n);
    }
  });

  test("dev_accounts_have_no_delegation_code", async () => {
    expect(src("up.sh")).toContain("setup.ts --clear-delegations");
    expect(src("setup.ts")).toContain('setCode({ address, bytecode: "0x" })');
    if (LIVE) {
      const { pub } = lib.forkClients();
      for (const a of lib.anvilAccounts().available_accounts) expect((await pub.getCode({ address: a })) ?? "0x").toBe("0x");
    }
  });

  test("relaxations_listed_and_applied_through_timelock", async () => {
    expect(setup.RELAXATIONS.map((r) => r.id)).toEqual(["R5.1", "R5.2", "R5.3", "R5.4"]);
    const cfg = {
      feed: "0x0000000000000000000000000000000000000001", stockToken: "0x0000000000000000000000000000000000000000", multiplierEmbedded: true,
      pythMultiplierEmbedded: false, alwaysOpen: true, pythId: `0x${"11".repeat(32)}`, twapPool: "0x0000000000000000000000000000000000000000",
      maxAgeOpen: 259200, maxAgeExtended: 0, maxAgeClosed: 432000, refMaxAge: 120, twapWindow: 1800, refBandBps: 200, continuityBps: 1500, enabled: true,
    } as const;
    const r = setup.relaxedMarket(cfg as never, { feedMaxAgeSec: 2592000, feedMaxAgeClosedSec: 1209600, refBandBps: 2000, refMaxAgeSec: 86400 });
    expect(r).toMatchObject({ maxAgeOpen: 2592000, maxAgeExtended: 0, maxAgeClosed: 1209600, refBandBps: 2000, refMaxAge: 86400, continuityBps: 1500, enabled: true });
    expect(setup.pythFromFeed(150_00000000n, 2n * 10n ** 18n)).toBe(75_00000000n);
    expect(setup.pythFromFeed(150_00000000n, undefined)).toBe(150_00000000n);
    expect(setup.marketId("ETH")).toBe(`0x455448${"0".repeat(58)}`);
    // The vol engine posts under the deployment's market ids (padded bytes32), not its keccak256(symbol) default: the minter
    // reads the padded id, so a keccak post never clears VOL_HARD_STALE.
    const rec = join(tmp, "vol-deployment.json");
    writeFileSync(rec, JSON.stringify({
      contracts: { ODVolOracle: "0xe7213b68dc25bf30bc7f1de9baead075c66979f9" },
      markets: [{ symbol: "NVDA", id: setup.marketId("NVDA") }, { symbol: "AMD" }],
      gears: [{ marketA: "NVDA", marketB: null }, { marketA: "NVDA", marketB: "AMD" }],
    }));
    const vol = setup.volEngineEnv(rec);
    expect(vol.VOL_ORACLE_ADDRESS).toBe("0xe7213b68DC25bf30bC7f1DE9BAead075c66979F9");
    const keys = vol.VOL_KEYS!.split(",");
    expect(keys[0]).toBe(`NVDA=${setup.marketId("NVDA")}`);
    expect(keys[1]).toBe(`AMD=${setup.marketId("AMD")}`);
    expect(keys[2]).toBe(`NVDA/AMD=${keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [setup.marketId("NVDA"), setup.marketId("AMD")]))}`);
    expect(setup.volEngineEnv(join(tmp, "missing.json"))).toEqual({});
    // Applied as the timelock (impersonated), never in the deploy script.
    const s = src("setup.ts");
    expect(s).toMatch(/asTimelock\(async \(wallet, timelock\)[\s\S]*functionName: "setMarket"/);
    for (const f of ["contracts/script/DeploySystem.s.sol", "app/scripts/deploy-fork.sh", "app/scripts/deploy/lib.sh"]) {
      expect(readFileSync(join(lib.ROOT, f), "utf8")).not.toMatch(/relax/i);
    }
    if (LIVE) {
      const applied = JSON.parse(readFileSync(join(lib.FORK_DIR, "relaxations.json"), "utf8"));
      expect(applied.by).toContain("timelock");
      expect(applied.applied.length).toBe(lib.loadDeployment().markets.length);
    }
  });

  test("up_fills_deployment_gears_and_never_runs_crank_once", () => {
    const u = src("up.sh");
    const list = u.indexOf("--relax --list-gears"), fill = u.indexOf("--fill-gears"), api = u.indexOf("if want api");
    expect(list).toBeGreaterThan(0);
    expect(fill).toBeGreaterThan(list); // after the gears are listed
    expect(api).toBeGreaterThan(fill); // before the API reads deployment.json
    const setup = src("setup.ts");
    expect(setup).not.toContain("crankPass"); // crank --once waits forever on the single-instance lock once the crank service runs
    expect(setup).not.toMatch(/runOnce\("crank"/);
    expect(setup).toContain("fillDeploymentGears");
  });

  test("bash32_lint_and_up_twice_is_idempotent", async () => {
    for (const f of ["env.sh", "up.sh", "down.sh", "reset.sh"]) {
      const text = src(f);
      const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      expect(code).not.toMatch(/\bmapfile\b|\breadarray\b|declare -A|local -n|\$\{[A-Za-z_]+\[-1\]\}|\[\[|\$\{[A-Za-z_]+,,|\$\{[A-Za-z_]+\^\^|&>>|\|&/);
      expect(code).not.toMatch(/=\(\s*\)/); // no arrays at all, so no empty-array expansion under set -u
      if (f !== "env.sh") expect(text.startsWith("#!/bin/bash")).toBe(true);
      const p = Bun.spawnSync(["/bin/bash", "-n", join(HERE, f)]);
      expect(p.exitCode).toBe(0);
    }
    const u = src("up.sh");
    expect(u).toContain('already running');
    expect(u).toMatch(/mkdir -p "\$FORK_DIR\/logs"/);
    const bare = u.split("\n").filter((l) => !/^\s*#/.test(l) && /(^|[;&|(]|then|do)\s*(anvil|cast|forge)\s/.test(l));
    expect(bare).toEqual([]); // tools by absolute path ($ANVIL, $CAST, $FORGE)
    expect(src("down.sh")).not.toMatch(/pkill|killall/);
    expect(src("env.sh")).toMatch(/kill "\$pid"/);
    if (LIVE) {
      const env = { ...process.env, UP_SERVICES: "indexer" };
      const run = () => Bun.spawnSync(["/bin/bash", join(HERE, "up.sh")], { env, stdout: "pipe", stderr: "pipe" });
      const a = run();
      const b = run();
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      const out = b.stdout.toString();
      for (const name of ["rpc-cache", "anvil", "indexer", "postgres"]) expect(out).toContain(`up: ${name} already running`);
      expect(out).toMatch(/stage deploy: skip/);
    }
  });

  test("each_service_started_via_its_bin_with_env_file", () => {
    if (!LIVE) writeFileSync(join(tmp, "deployment.json"), "{}");
    const env = setup.serviceEnv();
    for (const [svc, prefix] of [["crank", "CRANK"], ["hedger", "HEDGER"], ["liquidator", "LIQUIDATOR"]] as const) {
      expect(env[svc]![`${prefix}_KEYSTORE`]).toBe(join(lib.FORK_DIR, "keys", `${svc}.json`));
      expect(env[svc]![`${prefix}_KEYSTORE_PASSWORD_FILE`]).toBe(join(lib.FORK_DIR, "keys", "password"));
    }
    for (const vars of Object.values(env)) {
      for (const [k, v] of Object.entries(vars)) {
        expect(k).not.toMatch(/PRIVATE_KEY$/);
        expect(String(v)).not.toMatch(/^0x[0-9a-fA-F]{64}$/);
        if (/RPC_URL|_URL_OVERRIDE/.test(k) && v) expect(lib.isLocalUrl(String(v))).toBe(true);
      }
      if ("NETWORK" in vars) expect(vars.NETWORK).toBe("fork");
    }
    expect(env.hedger!.HEDGER_VENUES).toBe("mock");
    expect(Object.keys(env.mcp!).some((k) => k.startsWith("AGENT_KEY"))).toBe(false); // hosted MCP holds no key
    expect(env.indexer!.RPC_BACKUP_URL).toBe("");
    const u = src("up.sh");
    for (const svc of ["indexer", "api", "crank", "hedger", "liquidator", "mcp"]) expect(u).toContain(`src/bin/${svc}.ts`);
    expect(u).toMatch(/\. "\$FORK_DIR\/env\/\$name\.env"/);
    expect(u).toContain('tail -25 "$FORK_DIR/logs/$name.log"');
  });

  test("throwaway_keystores_round_trip", async () => {
    const { decryptKeystore } = await import("@/keys");
    const key = generatePrivateKey();
    const ks = lib.encryptKeystore(key, "pw-for-test");
    expect(decryptKeystore(ks, "pw-for-test")).toBe(key);
    expect(JSON.parse(ks).address).toBe(privateKeyToAccount(key).address.slice(2).toLowerCase());
    expect(() => decryptKeystore(ks, "wrong")).toThrow();
  });

  test("warp_then_crank_pass_and_gas_estimate_ahead", () => {
    const fri = Date.UTC(2026, 10, 13, 22, 0) / 1000; // Fri 2026-11-13 17:00 New York
    expect(warp.warpTarget(fri, "3600")).toBe(fri + 3600);
    expect(new Date(warp.warpTarget(fri, "to-next-open") * 1000).toISOString()).toBe("2026-11-16T14:30:00.000Z");
    expect(new Date(warp.warpTarget(fri, "to-next-close") * 1000).toISOString()).toBe("2026-11-16T21:00:00.000Z");
    expect(new Date(warp.warpTarget(fri, "to-weekend") * 1000).toISOString()).toBe("2026-11-14T17:00:00.000Z");
    expect(() => warp.warpTarget(fri, "soon")).toThrow(/usage/);
    const w = src("warp.ts");
    expect(w).toMatch(/increaseTime[\s\S]*mine[\s\S]*waitForCrankPass/);
    expect(w).toContain("refreshPyth");
    expect(typeof lib.estimateGasAhead).toBe("function");
    expect(src("lib.ts")).toMatch(/increaseTime\(\{ seconds: 1 \}\)[\s\S]*estimateGas[\s\S]*revert/);
    if (!LIVE) expect(setup.serviceEnv()["vol-engine"]!.VOL_CLOCK).toBe("chain");
  });
});

void mkdirSync;

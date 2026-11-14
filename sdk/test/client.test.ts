import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../scripts/generate-types";
import { DEPLOYMENTS } from "../src/deployments.generated";
import { Overdrive, OverdriveApiError, OverdriveIntentMismatch, OPERATION_KEYS, type OperationKey } from "../src";

interface Seen { method: string; url: string; headers: Record<string, string>; body: string | undefined }

function fake(answer: (seen: Seen, count: number) => Response | Promise<Response>, extra: Partial<ConstructorParameters<typeof Overdrive>[0]> = { checkIntents: false }) {
  const seen: Seen[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const record: Seen = { method: init?.method ?? "GET", url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? init.body : undefined };
    seen.push(record);
    return answer(record, seen.length);
  }) as typeof fetch;
  return { seen, client: new Overdrive({ baseUrl: "https://api.test/", fetch: fetcher, timeoutMs: 2_000, ...extra }) };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const ADDR = "0x00000000000000000000000000000000000a11ce";

/** One call per operation of the OpenAPI document. The test fails when a route has no client method. */
const CALLS: Record<OperationKey, { run: (c: Overdrive) => Promise<unknown>; method: string; url: RegExp }> = {
  "GET /health": { run: (c) => c.health(), method: "GET", url: /^\/health$/ },
  "GET /v1/status": { run: (c) => c.status(), method: "GET", url: /^\/v1\/status$/ },
  "GET /v1/config": { run: (c) => c.config(), method: "GET", url: /^\/v1\/config$/ },
  "GET /v1/gears": { run: (c) => c.gears(), method: "GET", url: /^\/v1\/gears$/ },
  "GET /v1/gears/{id}": { run: (c) => c.gear("TSLA-SPORT"), method: "GET", url: /^\/v1\/gears\/TSLA-SPORT$/ },
  "GET /v1/gears/{id}/history": { run: (c) => c.gearHistory("TSLA-SPORT", { range: "30d" }), method: "GET", url: /^\/v1\/gears\/TSLA-SPORT\/history\?range=30d$/ },
  "GET /v1/tolls": { run: (c) => c.tolls(), method: "GET", url: /^\/v1\/tolls$/ },
  "GET /v1/tolls/formula": { run: (c) => c.tollFormula(), method: "GET", url: /^\/v1\/tolls\/formula$/ },
  "GET /v1/quote": { run: (c) => c.quote({ gear: "TSLA-SPORT", side: "buy", usdg: "5000000", account: ADDR }), method: "GET", url: /^\/v1\/quote\?gear=TSLA-SPORT&side=buy&usdg=5000000&account=0x0+a11ce$/ },
  "POST /v1/intent/buy": { run: (c) => c.intent("buy", { gear: "TSLA-SPORT", account: ADDR, usdg: "5000000" } as never), method: "POST", url: /^\/v1\/intent\/buy$/ },
  "POST /v1/intent/sell": { run: (c) => c.intent("sell", { gear: "TSLA-SPORT", account: ADDR, tokens: "5" } as never), method: "POST", url: /^\/v1\/intent\/sell$/ },
  "POST /v1/intent/back/open": { run: (c) => c.intent("back/open", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/back\/open$/ },
  "POST /v1/intent/back/deposit": { run: (c) => c.intent("back/deposit", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/back\/deposit$/ },
  "POST /v1/intent/back/mint": { run: (c) => c.intent("back/mint", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/back\/mint$/ },
  "POST /v1/intent/back/repay": { run: (c) => c.intent("back/repay", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/back\/repay$/ },
  "POST /v1/intent/back/repay-usdg": { run: (c) => c.intent("back/repay-usdg", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/back\/repay-usdg$/ },
  "POST /v1/intent/back/withdraw": { run: (c) => c.intent("back/withdraw", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/back\/withdraw$/ },
  "POST /v1/intent/queue/cancel": { run: (c) => c.intent("queue/cancel", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/queue\/cancel$/ },
  "POST /v1/intent/queue/fill": { run: (c) => c.intent("queue/fill", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/queue\/fill$/ },
  "POST /v1/intent/agent/policy": { run: (c) => c.intent("agent/policy", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/agent\/policy$/ },
  "POST /v1/intent/agent/revoke": { run: (c) => c.intent("agent/revoke", { account: ADDR } as never), method: "POST", url: /^\/v1\/intent\/agent\/revoke$/ },
  "GET /v1/governor": { run: (c) => c.governor(), method: "GET", url: /^\/v1\/governor$/ },
  "GET /v1/governor/history": { run: (c) => c.governorHistory({ range: "1d" }), method: "GET", url: /^\/v1\/governor\/history\?range=1d$/ },
  "GET /v1/exit": { run: (c) => c.exit(), method: "GET", url: /^\/v1\/exit$/ },
  "GET /v1/backers/{address}": { run: (c) => c.backer(ADDR), method: "GET", url: new RegExp(`^/v1/backers/${ADDR}$`) },
  "GET /v1/vaults/{id}": { run: (c) => c.vault(7n), method: "GET", url: /^\/v1\/vaults\/7$/ },
  "GET /v1/account/{address}": { run: (c) => c.account(ADDR), method: "GET", url: new RegExp(`^/v1/account/${ADDR}$`) },
  "GET /v1/fees": { run: (c) => c.fees(), method: "GET", url: /^\/v1\/fees$/ },
  "GET /v1/risk": { run: (c) => c.risk(), method: "GET", url: /^\/v1\/risk$/ },
  "GET /v1/hedges": { run: (c) => c.hedges(), method: "GET", url: /^\/v1\/hedges$/ },
};

describe("SDK client", () => {
  test("every operation of the OpenAPI document has a client method that calls its path", async () => {
    const doc = JSON.parse(readFileSync(join(import.meta.dir, "..", "openapi.json"), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const fromDoc = Object.entries(doc.paths).flatMap(([p, item]) => Object.keys(item).filter((m) => ["get", "post"].includes(m)).map((m) => `${m.toUpperCase()} ${p}`)).sort();
    expect([...OPERATION_KEYS].map(String).sort()).toEqual(fromDoc);
    expect(Object.keys(CALLS).sort()).toEqual(fromDoc);
    for (const key of OPERATION_KEYS) {
      const call = CALLS[key];
      if (!call.method) continue;
      const { seen, client } = fake(() => json({}));
      await call.run(client);
      expect(seen.length).toBe(1);
      expect(seen[0]!.method).toBe(call.method);
      expect(new URL(seen[0]!.url).pathname + new URL(seen[0]!.url).search).toMatch(call.url);
      if (call.method === "POST") expect(seen[0]!.headers["content-type"]).toBe("application/json");
    }
    const doc2 = fake(() => json({}));
    await doc2.client.openapi(); // served outside the document itself
    expect(new URL(doc2.seen[0]!.url).pathname).toBe("/openapi.json");
  });

  test("retries_etag_timeout_and_typed_errors", async () => {
    // 429 honours Retry-After, at most 2 retries
    let n = 0;
    const slept: number[] = [];
    const real = globalThis.setTimeout;
    (globalThis as any).setTimeout = ((fn: () => void, ms?: number) => { slept.push(ms ?? 0); return real(fn, 0); }) as typeof setTimeout;
    try {
      const { client, seen } = fake(() => (++n < 3 ? json({ error: "RATE_LIMITED", message: "slow down" }, 429, { "retry-after": "1", "ratelimit-limit": "300", "ratelimit-remaining": "0", "ratelimit-reset": "1" }) : json({ ok: true })));
      expect(await client.health()).toEqual({ ok: true } as never);
      expect(seen.length).toBe(3);
      expect(slept.filter((ms) => ms === 1000).length).toBe(2);
      expect(client.rateLimit).toEqual({ limit: 300, remaining: 0, resetSeconds: 1 });
      // a third 429 is an error, typed
      n = -10;
      const failing = fake(() => json({ error: "RATE_LIMITED", message: "slow down" }, 429, { "retry-after": "2" }));
      const error = await failing.client.gears().catch((e) => e);
      expect(error).toBeInstanceOf(OverdriveApiError);
      expect(failing.seen.length).toBe(3);
      expect(error.status).toBe(429);
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.retryAfterSeconds).toBe(2);
      // a wait above the cap is not waited for
      const capped = fake(() => json({ error: "RATE_LIMITED", message: "x" }, 429, { "retry-after": "999" }), { checkIntents: false, maxRetryWaitSeconds: 5 });
      await capped.client.gears().catch(() => undefined);
      expect(capped.seen.length).toBe(1);
    } finally { (globalThis as any).setTimeout = real; }

    // ETag: the second read sends If-None-Match and a 304 answers from memory
    const etagged = fake((_s, count) => (count === 1 ? json({ gears: [1] }, 200, { etag: 'W/"abc"' }) : new Response(null, { status: 304 })));
    expect(await etagged.client.gears()).toEqual({ gears: [1] } as never);
    expect(await etagged.client.gears()).toEqual({ gears: [1] } as never);
    expect(etagged.seen[1]!.headers["if-none-match"]).toBe('W/"abc"');

    // timeout: a request that never answers is cut off and typed
    const hang = new Overdrive({ baseUrl: "https://api.test", timeoutMs: 30, fetch: ((_i: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as typeof fetch });
    const timeout = await hang.gears().catch((e) => e);
    expect(timeout).toBeInstanceOf(OverdriveApiError);
    expect(timeout.code).toBe("TIMEOUT");

    // typed error with reason; a stale answer is returned, never thrown
    const blocked = fake(() => json({ error: "CLOSED", message: "closed", reason: "CLOSED" }, 409));
    const e2 = await blocked.client.intent("buy", { gear: "X", account: ADDR, usdg: "1" } as never).catch((e) => e);
    expect(e2).toMatchObject({ status: 409, code: "CLOSED", reason: "CLOSED" });
    const stale = fake(() => json({ stale: true, gears: [] }));
    expect(((await stale.client.gears()) as { stale: boolean }).stale).toBe(true);
    expect(((await fake(() => new Response("<html>", { status: 502 })).client.gears().catch((x) => x)) as OverdriveApiError).code).toBe("UPSTREAM");
  });

  test("an intent aimed at a contract that is not Overdrive's is refused before signing", async () => {
    const contracts = { ODMinter: "0x00000000000000000000000000000000000000aa" };
    const good = { tx: { to: contracts.ODMinter, data: "0x", value: "0" }, approvals: [{ token: ADDR, spender: contracts.ODMinter, amount: "1" }] };
    const ok = fake(() => json(good), { expectedContracts: contracts });
    expect((await ok.client.intent("buy", { gear: "X", account: ADDR, usdg: "1" } as never)).tx.to).toBe(contracts.ODMinter);
    const evil = fake(() => json({ ...good, tx: { ...good.tx, to: "0x00000000000000000000000000000000000000bb" } }), { expectedContracts: contracts });
    await expect(evil.client.intent("buy", { gear: "X", account: ADDR, usdg: "1" } as never)).rejects.toBeInstanceOf(OverdriveIntentMismatch);
    const spender = fake(() => json({ ...good, approvals: [{ token: ADDR, spender: "0x00000000000000000000000000000000000000cc", amount: "1" }] }), { expectedContracts: contracts });
    await expect(spender.client.intent("buy", { gear: "X", account: ADDR, usdg: "1" } as never)).rejects.toMatchObject({ field: "approvals[0].spender" });
  });
});

describe("generated", () => {
  test("generated.ts is what the generator makes from openapi.json", () => {
    const doc = JSON.parse(readFileSync(join(import.meta.dir, "..", "openapi.json"), "utf8"));
    expect(readFileSync(join(import.meta.dir, "..", "src", "generated.ts"), "utf8")).toBe(generate(doc));
  });

  test("sdk_addresses_equal_deployment_file", () => {
    const dir = join(import.meta.dir, "..", "..", "app", "deployments");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "schema.json");
    expect(files.length).toBeGreaterThan(0);
    expect(DEPLOYMENTS.length).toBe(files.length);
    for (const f of files) {
      const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as { chainId: number; contracts: Record<string, string>; external: Record<string, string>; gears: Array<{ id: string; token: string }> };
      const sdk = DEPLOYMENTS.find((x) => x.chainId === d.chainId)!;
      expect(sdk).toBeTruthy();
      expect(sdk.contracts).toEqual(d.contracts);
      expect(sdk.external).toEqual(d.external);
      expect(sdk.gears.map((g) => [g.id, g.token])).toEqual(d.gears.map((g) => [g.id, g.token]));
    }
    // the file name and its chain id agree (a mainnet file must say 4663)
    const names: Record<string, number> = { "mainnet.json": 4663, "testnet.json": 46630, "anvil.json": 31337 };
    for (const f of files) if (names[f] !== undefined) expect(JSON.parse(readFileSync(join(dir, f), "utf8")).chainId).toBe(names[f]!);
  });
});

import { afterAll, expect, test } from "bun:test";
import { addr, harness, WAD } from "../test-support";
import { REAL_USER_DEFINITION } from "./stats";

const TOKEN = addr("ovrd-launchpad");
const balances = new Map<string, bigint>();
let reads = 0;
const chain = { tokenBalance: async (_t: string, a: string) => { reads++; if (a === addr("boom")) throw new Error("rpc"); return { balance: balances.get(a.toLowerCase()) ?? 0n, decimals: 18 }; } };
const live = await harness("holder-live", { config: { OVRD_TOKEN_ADDRESS: TOKEN }, chain });
const off = await harness("holder-off", { chain });
afterAll(async () => { await live?.close(); await off?.close(); });

test("no token address: tiers are not live and no RPC call is made", async () => {
  if (!off) return;
  const body = (await (await off.app.request(`/v1/holder/${addr("a")}`)).json()) as any;
  expect(body).toMatchObject({ status: "not_live", tier: null, perks: [], balance: null });
  expect(body.message).toBe("Unlocks for $OVRD holders (100,000+)");
  expect(body.note).toMatch(/no cash value/);
  expect(off.chain.calls.other + off.chain.calls.quote + off.chain.calls.minter).toBe(0);
});
test("live: tier and perks come from the balance; thresholds from config", async () => {
  if (!live) return;
  balances.set(addr("h").toLowerCase(), 100_000n * WAD);
  balances.set(addr("w").toLowerCase(), 1_000_000n * WAD);
  balances.set(addr("s").toLowerCase(), 99_999n * WAD);
  const get = async (a: string) => (await (await live.app.request(`/v1/holder/${a}`)).json()) as any;
  expect(await get(addr("s"))).toMatchObject({ status: "live", tier: "none", perks: [], missingForNext: { next: "holder", missingTokens: "1" } });
  expect(await get(addr("h"))).toMatchObject({ tier: "holder", perks: ["analytics", "alerts"] });
  expect(await get(addr("w"))).toMatchObject({ tier: "whale", missingForNext: null });
  expect((await get(addr("w"))).perks).toContain("agent_tools");
});
test("a failed balance read grants nothing (502)", async () => {
  if (!live) return;
  const r = await live.app.request(`/v1/holder/${addr("boom")}`);
  expect(r.status).toBe(502);
  expect(JSON.stringify(await r.json())).not.toMatch(/whale|holder/);
});
test("a bad address is a 400", async () => {
  if (!off) return;
  expect((await off.app.request("/v1/holder/0x12")).status).toBe(400);
});

test("real users: distinct wallets that bought, sold or backed; team, bot and Safe excluded", async () => {
  const team = addr("team"), bot = addr("bot"), safe = addr("safe");
  const h = await harness("users", { config: { USER_COUNT_EXCLUDE_TEAM: team, USER_COUNT_EXCLUDE_BOTS: bot.toUpperCase().replace("0X", "0x"), USER_COUNT_EXCLUDE_SAFES: safe } });
  if (!h) return;
  try {
    await h.seedIndexer();
    const gear = h.deployment.gears[0]!.id;
    let n = 0;
    const trade = (acct: string, side: string) => h.raw`INSERT INTO trades (tx_hash, log_index, block, ts, gear, account, side, tokens, usdg, via) VALUES (${"0x" + (++n).toString(16).padStart(64, "0")}, 0, ${n}, now(), ${gear}, ${acct.toLowerCase()}, ${side}, 1, 1, 'hook')`;
    const vault = (id: number, owner: string) => h.raw`INSERT INTO backer_vaults (id, owner, gear, collateral, debt_tokens, status) VALUES (${id}, ${owner.toLowerCase()}, ${gear}, 1, 1, 'open')`;
    await trade(addr("u1"), "buy"); await trade(addr("u1"), "sell"); await trade(addr("u2"), "buy"); // u1 twice = one wallet
    await vault(1, addr("u3")); await vault(2, addr("u2")); // u2 trades and backs = one wallet
    await trade(team, "buy"); await trade(bot, "buy"); await trade(safe, "sell"); await vault(3, safe); // excluded
    await trade("0x0000000000000000000000000000000000000000", "buy");
    await trade(h.deployment.admin.ownerSafe, "buy"); // the deployment's own Safe is excluded without config
    const body = (await (await h.app.request("/v1/stats/users")).json()) as any;
    expect(body).toMatchObject({ realUsers: 3, traders: 2, backers: 2, both: 1 });
    expect(body.definition).toBe(REAL_USER_DEFINITION);
    expect(body.definition).toMatch(/Token holders are not users/);
    expect(body.excludedAddresses).toBeGreaterThanOrEqual(3);
  } finally { await h.close(); }
});
test("real users: an empty chain counts zero", async () => {
  if (!off) return;
  await off.seedIndexer();
  const body = (await (await off.app.request("/v1/stats/users")).json()) as any;
  expect(body).toMatchObject({ realUsers: 0, traders: 0, backers: 0, firstActivityAt: null });
});

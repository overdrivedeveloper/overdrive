// R18 test for scripts/hedger/testnet-hl.ts: refuses mainnet, and runs every step against a fake Hyperliquid server.
import { describe, expect, test } from "bun:test";
import { generatePrivateKey } from "viem/accounts";
import { runTestnetHl } from "../../../scripts/hedger/testnet-hl";
import { venueCheck } from "../../../scripts/hedger/venue-check";
import type { FetchLike } from "./hyperliquid";

const ACCOUNT = `0x${"42".repeat(20)}`;

/** A fake testnet: xyz is dex 5, TSLA at index 1; orders fill at the limit; one account's position is tracked. */
function fakeServer() {
  let szi = 0;
  let oid = 100;
  const actions: string[] = [];
  const fn: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    const reply = (json: unknown) => ({ status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    if (path === "/info") {
      if (body.type === "perpDexs") return reply([null, { name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "xyz" }, { name: "bart" }]);
      if (body.type === "meta") return reply({ universe: body.dex === "xyz" ? [{ name: "xyz:NVDA", szDecimals: 3 }, { name: "xyz:TSLA", szDecimals: 3 }] : body.dex === "bart" ? [{ name: "bart:SPY", szDecimals: 2 }] : [] });
      if (body.type === "l2Book") return reply({ levels: [[{ px: "399", sz: "10", n: 1 }], [{ px: "401", sz: "10", n: 1 }]] });
      if (body.type === "clearinghouseState") return reply({ assetPositions: szi ? [{ position: { coin: "xyz:TSLA", szi: String(szi) } }] : [] });
      return reply({});
    }
    const action = body.action;
    actions.push(action.type);
    if (!body.signature?.r || body.vaultAddress !== null) return reply({ status: "err" });
    if (action.type === "cancel") return reply({ status: "ok", response: { data: { statuses: ["success"] } } });
    const o = action.orders[0];
    if (o.a !== 100_000 + 5 * 10_000 + 1) return reply({ status: "err", response: "wrong asset" });
    if (o.t.limit.tif === "Alo") return reply({ status: "ok", response: { data: { statuses: [{ resting: { oid: ++oid } }] } } });
    szi += (o.b ? 1 : -1) * Number(o.s);
    return reply({ status: "ok", response: { data: { statuses: [{ filled: { totalSz: o.s, avgPx: o.p, oid: ++oid } }] } } });
  };
  return { fn, actions, position: () => szi };
}

describe("testnet-hl script", () => {
  test("refuses_mainnet_and_runs_against_fake_server", async () => {
    const key = generatePrivateKey();
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    const server = fakeServer();
    const base = { HL_ACCOUNT_ADDRESS: ACCOUNT, HEDGER_PRIVATE_KEY: key };
    expect(await runTestnetHl({ ...base, HL_NETWORK: "mainnet" }, { fetch: server.fn, print })).toBe(2);
    expect(await runTestnetHl({ ...base }, { fetch: server.fn, print })).toBe(2);
    expect(await runTestnetHl({ ...base, HL_NETWORK: "testnet", HL_API_URL: "https://api.hyperliquid.xyz" }, { fetch: server.fn, print })).toBe(2);
    expect(await runTestnetHl({ HL_NETWORK: "testnet", HEDGER_PRIVATE_KEY: key }, { fetch: server.fn, print })).toBe(2);
    expect(lines.every((l) => l.startsWith("REFUSED"))).toBe(true);
    expect(server.actions).toEqual([]);

    lines.length = 0;
    const code = await runTestnetHl({ ...base, HL_NETWORK: "testnet", HL_API_URL: "http://127.0.0.1:1" }, { fetch: server.fn, print, sleep: async () => undefined });
    expect(lines.map((l) => l.slice(0, 7))).toEqual(["PASS  1", "PASS  2", "PASS  3", "PASS  4", "PASS  5", "PASS  6", "PASS  7", "PASS  8"]);
    expect(code).toBe(0);
    expect(server.actions).toEqual(["order", "cancel", "order", "order"]);
    expect(server.position()).toBe(0);

    // the read-only venue check resolves live and reports a missing route
    const out: string[] = [];
    expect(await venueCheck("testnet", ["TSLA", "SPY", "AMD"], { fetch: server.fn, print: (l) => out.push(l) })).toBe(1);
    expect(out[0]).toContain("asset=150001");
    expect(out[1]).toContain("bart:SPY");
    expect(out[2]).toStartWith("MISSING  AMD");
  });
});

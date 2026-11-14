// Shared fixtures for the MCP tests: a fake API (the shapes the real API serves), a deployment config and a router mock.
import { encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { IODMinterAbi } from "../abi";
import { MockRouter } from "../testing/mock-router";
import { createAgentRuntime, type AgentRuntime, type Executor, type Mode } from "./agent";
import { ToolError, type ApiClient } from "./api-client";
import { chainGearReader, chainPolicyReader } from "./agent";
import type { ToolContext } from "./tools";

export const NOW_MS = 1_800_000_000_000;
export const NOW_S = NOW_MS / 1000;
export const idOf = (s: string) => keccak256(toHex(s)) as Hex;
export const addr = (s: string) => getAddress(`0x${keccak256(toHex(s)).slice(26)}`) as Address;
export const OWNER = addr("owner");
export const ROUTER = addr("router");
export const MINTER = addr("minter");
export const REGISTRY = addr("registry");
export const USDG = addr("usdg");
export const MARKET_TSLA = idOf("market-TSLA");
export const MARKET_NVDA = idOf("market-NVDA");
export const SPORT = idOf("TSLA-SPORT");
export const RACE = idOf("TSLA-RACE");
export const ECO = idOf("TSLA-ECO");
export const NVDA_SPORT = idOf("NVDA-SPORT");

export const fakeConfig = () => ({
  chainId: 31337, network: "fork", commit: "t", startBlock: 1,
  external: { usdg: USDG, v4Quoter: addr("quoter") }, contracts: { ODAgentRouter: ROUTER, ODMinter: MINTER, ODGearRegistry: REGISTRY },
  markets: [{ id: MARKET_TSLA, symbol: "TSLA" }, { id: MARKET_NVDA, symbol: "NVDA" }],
  gears: [
    { id: SPORT, symbol: "TSLA-SPORT", token: addr("tok-sport"), marketA: "TSLA", marketB: null },
    { id: RACE, symbol: "TSLA-RACE", token: addr("tok-race"), marketA: "TSLA", marketB: null },
    { id: ECO, symbol: "TSLA-ECO", token: addr("tok-eco"), marketA: "TSLA", marketB: null },
    { id: NVDA_SPORT, symbol: "NVDA-SPORT", token: addr("tok-nvda"), marketA: "NVDA", marketB: null },
  ],
});

export interface FakeApiOptions { nowS?: () => number; quote?: Record<string, unknown>; routes?: Record<string, unknown>; calls?: string[]; tamper?: (kind: "buy" | "sell", data: Hex, body: Record<string, unknown>) => { to?: string; data?: Hex } }
/** The API's shapes. `quote` overrides fields of the quote; `routes` replaces whole GET answers by path. */
export function fakeApi(o: FakeApiOptions = {}): ApiClient {
  const calls = o.calls ?? [];
  const quote = (url: URL) => ({
    asOfBlock: "1", asOf: "2027-01-15T08:00:00.000Z", stale: false, gear: url.searchParams.get("gear"), side: url.searchParams.get("side"), buyable: true, reason: null, code: null, message: null,
    sellMode: "instant", amountIn: url.searchParams.get("usdg") ?? url.searchParams.get("tokens"), amountOut: url.searchParams.get("side") === "buy" ? "2000000000000000000" : "9000000", minOutSuggested: url.searchParams.get("side") === "buy" ? "1990000000000000000" : "8955000",
    tollPerDayBps: "12", breakevenDays: 4, spreadBps: 40, expiresAt: "2027-01-15T08:00:10.000Z", ...o.quote,
  });
  return {
    async get(path) {
      calls.push(`GET ${path}`);
      const url = new URL(path, "http://x");
      if (o.routes && path in o.routes) return o.routes[path];
      if (url.pathname === "/v1/config") return fakeConfig();
      if (url.pathname === "/v1/quote") return quote(url);
      if (url.pathname === "/v1/gears") return { stale: false, gears: [{ symbol: "TSLA-SPORT", underlying: "TSLA", power: "2", buyable: true }, { symbol: "TSLA-RACE", underlying: "TSLA", power: "3", buyable: true }, { symbol: "NVDA-SPORT", underlying: "NVDA", power: "2", buyable: true }] };
      if (url.pathname.startsWith("/v1/gears/")) return { stale: false, gear: { symbol: "TSLA-RACE", id: RACE, power: "3", price: (250n * 10n ** 18n).toString(), valuePerToken: (100n * 10n ** 18n).toString() } };
      if (url.pathname.startsWith("/v1/account/")) return { stale: false, balances: [] };
      if (url.pathname.startsWith("/v1/backers/")) return { stale: false, vaults: [] };
      if (url.pathname === "/v1/governor") return { live: true, equityWad: "1" };
      if (url.pathname === "/v1/exit") return { live: true, reserveUsdg: "1" };
      throw new ToolError("HTTP_404", "The API answered 404.");
    },
    async post(path, body) {
      calls.push(`POST ${path}`);
      const b = body as Record<string, unknown>;
      const kind = path.endsWith("/buy") ? "buy" : "sell";
      const gearId = String(b.gear).startsWith("0x") ? (b.gear as Hex) : SPORT;
      const amount = BigInt(String(kind === "buy" ? b.usdg : b.tokens));
      const deadline = BigInt((o.nowS?.() ?? NOW_S) + Number(b.deadlineSec ?? 300));
      let data = encodeFunctionData({ abi: IODMinterAbi, functionName: kind, args: [gearId, amount, BigInt(String(b.minOut)), b.recipient as Address, deadline] });
      let to = MINTER as string;
      const t = o.tamper?.(kind, data, b);
      if (t?.data) data = t.data;
      if (t?.to) to = t.to;
      return { kind, tx: { to, data, value: "0" }, approvals: [], expectedOut: "1", minOut: String(b.minOut), note: "Unsigned." };
    },
  };
}

export interface Rig { router: MockRouter; agent: AgentRuntime; sent: Hex[]; key: Hex; ctx: ToolContext; calls: string[] }
export interface RigOptions { mode?: Mode; policy?: Partial<{ budgetUsdg: bigint; maxPerTradeUsdg: bigint; expiresAt: number; canSell: boolean; canBack: boolean; markets: Hex[] }> | null; api?: FakeApiOptions; failSend?: boolean; clientSideChecks?: boolean; sendDelayMs?: number }

/** An agent, a router mock with gears and (unless policy is null) a policy, and a fake API, wired as buildMcp would. */
export function rig(o: RigOptions = {}): Rig {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const router = new MockRouter(() => NOW_S);
  router.addGear(SPORT, { marketA: MARKET_TSLA, kind: 1 });
  router.addGear(RACE, { marketA: MARKET_TSLA, kind: 2, collateralBps: 25_000, maintenanceBps: 20_000 });
  router.addGear(ECO, { marketA: MARKET_TSLA, kind: 3 });
  router.addGear(NVDA_SPORT, { marketA: MARKET_NVDA, kind: 1 });
  if (o.policy !== null) router.setPolicy(OWNER, account.address, { budgetUsdg: 1_000_000_000n, maxPerTradeUsdg: 500_000_000n, expiresAt: NOW_S + 3600, markets: [MARKET_TSLA], ...o.policy });
  const reader = router.reader();
  const sent: Hex[] = [];
  const executor: Executor = {
    async send({ data }) {
      if (o.sendDelayMs) await new Promise((r) => setTimeout(r, o.sendDelayMs));
      if (o.failSend) throw new ToolError("TX_FAILED", "The transaction could not be sent or was refused by the router.");
      router.execute(account.address, data); // a revert here is a policy refusal the client side missed
      sent.push(data);
      return { txHash: idOf(`tx-${sent.length}`) };
    },
  };
  const agent = createAgentRuntime({
    key, owner: OWNER, router: ROUTER, policy: chainPolicyReader(reader as never, ROUTER), gears: chainGearReader(reader as never, REGISTRY),
    executor: () => executor, now: () => NOW_MS, ...(o.clientSideChecks === undefined ? {} : { clientSideChecks: o.clientSideChecks }),
  });
  const calls = o.api?.calls ?? [];
  const ctx: ToolContext = { api: fakeApi({ ...o.api, calls }), agent, mode: o.mode ?? "send", defaultOwner: OWNER, router: ROUTER, pin: undefined, now: () => NOW_MS };
  return { router, agent, sent, key, ctx, calls };
}

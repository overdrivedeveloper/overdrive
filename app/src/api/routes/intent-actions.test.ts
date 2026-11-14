import { afterAll, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { IODAgentRouterAbi, IODBackerAbi, IODMinterAbi } from "../../abi";
import type { BackerVaultState, QueuedSellState } from "../chain-reads";
import { harness, idOf, WAD } from "../test-support";
import { healthBps } from "./backers";

const OWNER = "0x00000000000000000000000000000000000a11ce";
const OTHER = "0x00000000000000000000000000000000000b0b00";
const AGENT = "0x00000000000000000000000000000000000a6e47";
const ZERO = "0x0000000000000000000000000000000000000000";
const gearId = idOf("TSLA-SPORT");
// mutable fixtures the mock chain reads
const st = {
  vault: { owner: OWNER, gearId, collateralUsdg: 2_400_000_000n, debtTokens: 10n * WAD, batchId: 0n } as BackerVaultState,
  debtValueWad: 1000n * WAD, required: 20000n, mintPaused: false, operator: false, window: { readyAt: 0n, expiresAt: 0n },
  ticket: { gearId, owner: OWNER, recipient: OWNER, tokens: WAD, minUsdgOut: 1n } as QueuedSellState,
};
const h = await harness("intent_actions", { chain: {
  backerVault: async (id) => (id === 404n ? { ...st.vault, owner: ZERO } : st.vault),
  backerHealth: async () => ({ collateralUsdg: st.vault.collateralUsdg, debtValueWad: st.debtValueWad, ratioBps: healthBps(st.vault.collateralUsdg, st.debtValueWad), requiredBps: st.required, maintenanceBps: 15000n }),
  backerBatchWindow: async () => st.window, backerMintPaused: async () => st.mintPaused, backerIsOperator: async () => st.operator,
  queuedSell: async (t) => (t === 404n ? { ...st.ticket, owner: ZERO } : st.ticket),
} });
afterAll(async () => { await h?.close(); });

const post = async (path: string, body: unknown) => { const r = await h!.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
const fresh = () => h!.deps.cache.sweep(Number.MAX_SAFE_INTEGER);
const session = (n: number) => { h!.hook.gears.get(gearId.toLowerCase())!.session = n; fresh(); };
const decode = (abi: any, data: string) => decodeFunctionData({ abi, data: data as `0x${string}` });

test("intent_back_open: unsigned openVault with the USDG approval to the Backer; refuses under 50 USDG and ECO", async () => {
  if (!h) return;
  const ok = await post("/v1/intent/back/open", { gear: "TSLA-SPORT", account: OWNER, collateralUsdg: "100000000" });
  expect(ok.status).toBe(200);
  expect(ok.body.kind).toBe("back_open");
  expect(ok.body.chainId).toBe(31337);
  expect(ok.body.tx.value).toBe("0");
  expect(ok.body.tx.to.toLowerCase()).toBe(h.deployment.contracts.ODBacker!.toLowerCase());
  expect(decode(IODBackerAbi, ok.body.tx.data).functionName).toBe("openVault");
  expect(ok.body.approvals[0]).toEqual({ token: h.deployment.external.usdg, spender: h.deployment.contracts.ODBacker, amount: "100000000" });
  const gift = await post("/v1/intent/back/open", { gear: "TSLA-SPORT", account: OWNER, owner: OTHER, collateralUsdg: "100000000" });
  expect(decode(IODBackerAbi, gift.body.tx.data).functionName).toBe("openVaultFor");
  const small = await post("/v1/intent/back/open", { gear: "TSLA-SPORT", account: OWNER, collateralUsdg: "49999999" });
  expect(small.status).toBe(409);
  expect(small.body.error).toBe("BELOW_MIN");
  expect((await post("/v1/intent/back/open", { gear: "TSLA-ECO", account: OWNER, collateralUsdg: "100000000" })).status).toBe(400);
  expect((await post("/v1/intent/back/open", { gear: "NOPE", account: OWNER, collateralUsdg: "100000000" })).status).toBe(404);
});

test("intent_back_deposit: anyone may top up; unknown vault is 404; zero is 400", async () => {
  if (!h) return;
  const ok = await post("/v1/intent/back/deposit", { account: OTHER, vaultId: "7", usdg: "5000000" });
  expect(ok.status).toBe(200);
  expect(decode(IODBackerAbi, ok.body.tx.data).functionName).toBe("deposit");
  expect(ok.body.approvals[0].amount).toBe("5000000");
  st.vault.batchId = 9n; st.window = { readyAt: 1n, expiresAt: 9_999_999_999n }; // even inside a batch
  expect((await post("/v1/intent/back/deposit", { account: OTHER, vaultId: "7", usdg: "5000000" })).status).toBe(200);
  st.vault.batchId = 0n;
  expect((await post("/v1/intent/back/deposit", { account: OTHER, vaultId: "404", usdg: "5000000" })).status).toBe(404);
  expect((await post("/v1/intent/back/deposit", { account: OTHER, vaultId: "7", usdg: "0" })).status).toBe(400);
});

test("intent_back_mint: health-checked; refuses undercollateralized, paused, in a batch, and a reading that is not live", async () => {
  if (!h) return;
  const body = { account: OWNER, vaultId: "7", tokens: WAD.toString() };
  const ok = await post("/v1/intent/back/mint", body);
  expect(ok.status).toBe(200);
  expect(decode(IODBackerAbi, ok.body.tx.data).functionName).toBe("mint");
  expect(ok.body.approvals).toEqual([]);
  expect(BigInt(ok.body.preflight.ratioAfterBps)).toBeGreaterThanOrEqual(20000n);
  // too much debt for the collateral
  const big = await post("/v1/intent/back/mint", { ...body, tokens: (1000n * WAD).toString() });
  expect(big.status).toBe(409);
  expect(big.body.reason).toBe("UNDERCOLLATERALIZED");
  // someone else, not an operator
  expect((await post("/v1/intent/back/mint", { ...body, account: OTHER })).status).toBe(400);
  st.operator = true;
  const op = await post("/v1/intent/back/mint", { ...body, account: OTHER });
  expect(op.status).toBe(200);
  expect(decode(IODBackerAbi, op.body.tx.data).functionName).toBe("mintFor");
  st.operator = false;
  st.mintPaused = true;
  expect((await post("/v1/intent/back/mint", body)).body.reason).toBe("MINT_PAUSED");
  st.mintPaused = false;
  st.vault.batchId = 3n; st.window = { readyAt: 1n, expiresAt: 9_999_999_999n };
  const inBatch = await post("/v1/intent/back/mint", body);
  expect(inBatch.status).toBe(409);
  expect(inBatch.body.reason).toBe("IN_BATCH");
  st.window = { readyAt: 1n, expiresAt: 2n }; // expired batch no longer blocks
  expect((await post("/v1/intent/back/mint", body)).status).toBe(200);
  st.vault.batchId = 0n;
  session(2);
  const closed = await post("/v1/intent/back/mint", body);
  expect(closed.status).toBe(409);
  expect(closed.body.error).toBe("CLOSED");
  session(0);
});

test("intent_back_repay: clamps to the debt, needs no approval, refuses a vault with no debt", async () => {
  if (!h) return;
  const ok = await post("/v1/intent/back/repay", { account: OTHER, vaultId: "7", tokens: (50n * WAD).toString() });
  expect(ok.status).toBe(200);
  const call = decode(IODBackerAbi, ok.body.tx.data) as any;
  expect(call.functionName).toBe("repay");
  expect(call.args[1]).toBe(10n * WAD);
  expect(ok.body.approvals).toEqual([]);
  st.vault.debtTokens = 0n;
  const none = await post("/v1/intent/back/repay", { account: OWNER, vaultId: "7", tokens: "1" });
  expect(none.status).toBe(400);
  expect(none.body.reason).toBe("NO_DEBT");
  st.vault.debtTokens = 10n * WAD;
});

test("intent_back_repay_usdg: owner only, estimates the cost, refuses when the reading is not live", async () => {
  if (!h) return;
  const ok = await post("/v1/intent/back/repay-usdg", { account: OWNER, vaultId: "7", tokens: WAD.toString() });
  expect(ok.status).toBe(200);
  const call = decode(IODBackerAbi, ok.body.tx.data) as any;
  expect(call.functionName).toBe("repayWithUsdg");
  expect(call.args[2]).toBeGreaterThanOrEqual(BigInt(ok.body.preflight.estimatedCostUsdg));
  expect((await post("/v1/intent/back/repay-usdg", { account: OTHER, vaultId: "7", tokens: "1" })).status).toBe(400);
  expect((await post("/v1/intent/back/repay-usdg", { account: OWNER, vaultId: "7", tokens: WAD.toString(), maxCostUsdg: "1" })).status).toBe(400);
  session(2);
  const closed = await post("/v1/intent/back/repay-usdg", { account: OWNER, vaultId: "7", tokens: WAD.toString() });
  expect(closed.status).toBe(409);
  expect(closed.body.error).toBe("CLOSED");
  session(0);
});

test("intent_back_withdraw: owner only; the ratio after must stay at the required level; refused in a batch", async () => {
  if (!h) return;
  const ok = await post("/v1/intent/back/withdraw", { account: OWNER, vaultId: "7", usdg: "1000000" });
  expect(ok.status).toBe(200);
  expect((decode(IODBackerAbi, ok.body.tx.data) as any).args[2].toLowerCase()).toBe(OWNER);
  const low = await post("/v1/intent/back/withdraw", { account: OWNER, vaultId: "7", usdg: "1500000000" });
  expect(low.status).toBe(409);
  expect(low.body.reason).toBe("UNDERCOLLATERALIZED");
  expect((await post("/v1/intent/back/withdraw", { account: OTHER, vaultId: "7", usdg: "1" })).status).toBe(400);
  expect((await post("/v1/intent/back/withdraw", { account: OWNER, vaultId: "7", usdg: "9999999999999" })).status).toBe(400);
  st.vault.batchId = 3n; st.window = { readyAt: 1n, expiresAt: 9_999_999_999n };
  expect((await post("/v1/intent/back/withdraw", { account: OWNER, vaultId: "7", usdg: "1" })).body.reason).toBe("IN_BATCH");
  st.vault.batchId = 0n;
});

test("intent_queue_cancel: ticket owner only, unknown ticket is 404", async () => {
  if (!h) return;
  const ok = await post("/v1/intent/queue/cancel", { account: OWNER, ticket: "5" });
  expect(ok.status).toBe(200);
  expect(decode(IODMinterAbi, ok.body.tx.data).functionName).toBe("cancelQueued");
  expect(ok.body.tx.to.toLowerCase()).toBe(h.deployment.contracts.ODMinter!.toLowerCase());
  expect((await post("/v1/intent/queue/cancel", { account: OTHER, ticket: "5" })).status).toBe(400);
  expect((await post("/v1/intent/queue/cancel", { account: OWNER, ticket: "404" })).status).toBe(404);
});

test("intent_queue_fill: anyone may fill once a fresh sell pays the minimum; refuses when it cannot pay now", async () => {
  if (!h) return;
  const ok = await post("/v1/intent/queue/fill", { ticket: "5" });
  expect(ok.status).toBe(200);
  expect(decode(IODMinterAbi, ok.body.tx.data).functionName).toBe("fillQueued");
  st.ticket.minUsdgOut = 10n ** 18n; // above anything the sell pays
  const low = await post("/v1/intent/queue/fill", { ticket: "5" });
  expect(low.status).toBe(409);
  expect(low.body.reason).toBe("BELOW_TICKET_MIN");
  st.ticket.minUsdgOut = 1n;
  session(2); // closed market, no reference: the sell can only queue
  h.hook.gears.get(gearId.toLowerCase())!.refValueWad = 0n;
  fresh();
  const closed = await post("/v1/intent/queue/fill", { ticket: "5" });
  expect(closed.status).toBe(409);
  h.hook.gears.get(gearId.toLowerCase())!.refValueWad = 99n * WAD;
  session(0);
  expect((await post("/v1/intent/queue/fill", { ticket: "404" })).status).toBe(404);
});

test("intent_agent_policy: encodes setPolicy with the budget approval; refuses a bad policy and unknown market", async () => {
  if (!h) return;
  const exp = Math.floor(Date.now() / 1000) + 86_400;
  const body = { account: OWNER, agent: AGENT, budgetUsdg: "500000000", maxPerTradeUsdg: "100000000", expiresAt: exp, canSell: true, markets: ["TSLA", "NVDA", "tsla"] };
  const ok = await post("/v1/intent/agent/policy", body);
  expect(ok.status).toBe(200);
  const call = decode(IODAgentRouterAbi, ok.body.tx.data) as any;
  expect(call.functionName).toBe("setPolicy");
  expect(call.args[6].length).toBe(2); // duplicate dropped
  expect(call.args[4]).toBe(true);
  expect(call.args[5]).toBe(false);
  expect(ok.body.tx.to.toLowerCase()).toBe(h.deployment.contracts.ODAgentRouter!.toLowerCase());
  expect(ok.body.approvals[0]).toEqual({ token: h.deployment.external.usdg, spender: h.deployment.contracts.ODAgentRouter, amount: "500000000" });
  expect((await post("/v1/intent/agent/policy", { ...body, agent: OWNER })).status).toBe(400);
  expect((await post("/v1/intent/agent/policy", { ...body, maxPerTradeUsdg: "600000000" })).status).toBe(400);
  expect((await post("/v1/intent/agent/policy", { ...body, expiresAt: 1000 })).status).toBe(400);
  expect((await post("/v1/intent/agent/policy", { ...body, markets: ["NOPE"] })).status).toBe(404);
});

test("intent_agent_revoke: encodes revoke; refuses a malformed agent address", async () => {
  if (!h) return;
  const ok = await post("/v1/intent/agent/revoke", { account: OWNER, agent: AGENT });
  expect(ok.status).toBe(200);
  const call = decode(IODAgentRouterAbi, ok.body.tx.data) as any;
  expect(call.functionName).toBe("revoke");
  expect(call.args[0].toLowerCase()).toBe(AGENT);
  expect((await post("/v1/intent/agent/revoke", { account: OWNER, agent: "0x12" })).status).toBe(400);
});

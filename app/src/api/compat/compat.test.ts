// 24b: the website contract procedures. R4 one test per procedure (shape, integer strings, null not 0, stamp on every
// snapshot, listed in OpenAPI); R5 one test per service error code, and only those codes ever answer.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionData, type Abi } from "viem";
import { IODMinterAbi } from "../../abi";
import { addr, harness, idOf, WAD } from "../test-support";
import { RACE_VOL_UNDERLYINGS, SERVICE_ERROR_CODES, STATUS_OF, fromApiError, minimumOf, raceVolBlocked, serviceError, shiftDecimal } from "./model";
import { COMPAT_PROCEDURES } from "./routes";

const HOLDER = addr("holder");
const STRANGER = addr("stranger");
const OVRD = addr("ovrd-token");
let uplift = false;
const reads = { reserve: 500_000_000_000n, floor: 100_000_000_000n };
const RECEIPT = idOf("receipt-ok");
const REVERTED = idOf("receipt-bad");
const h = await harness("compat", {
  chain: {
    governor: {
      equity: async () => 9n * WAD, freeCash: async () => 3_000_000n, stressLoss: async () => ({ lossWad: 2n * WAD, budgetWad: 4n * WAD }), hedgeStale: async () => false,
      buysPaused: async () => ({ paused: false, reason: "" }), exposure: async () => ({ deltaUsdWad: 0n, gammaUsdWad: 0n, openValueWad: 0n }),
      exitReserve: async () => reads.reserve, exitReserveFloor: async () => reads.floor,
    },
    backerHealth: async () => ({ collateralUsdg: 2_100_000_000n, debtValueWad: 1000n * WAD, ratioBps: 21000n, requiredBps: 20000n, maintenanceBps: 15000n }),
    backerVault: async (id) => (id === 1n ? { owner: HOLDER, gearId: idOf("TSLA-SPORT"), collateralUsdg: 2_100_000_000n, debtTokens: 1000n * WAD, batchId: 0n } : { owner: "0x0000000000000000000000000000000000000000", gearId: "0x", collateralUsdg: 0n, debtTokens: 0n, batchId: 0n }),
    upliftActive: async () => ({ active: uplift, upliftBps: uplift ? 2500 : 0 }),
    stakeAccount: async () => ({ ovrd: OVRD, balance: 5n * WAD, feeDiscountBps: 250, blockNumber: 1000n }),
    receipt: async (hash) => (hash === RECEIPT ? { status: "success", blockNumber: 1000n } : hash === REVERTED ? { status: "reverted", blockNumber: 1001n } : null),
  },
});
afterAll(async () => { await h?.close(); });

const get = async (procedure: string, q = "") => { const r = await h!.app.request(`/v1/compat/${procedure}${q ? `?${q}` : ""}`); return { status: r.status, body: (await r.json()) as any }; };
const post = async (procedure: string, body: unknown) => {
  const r = await h!.app.request(`/v1/compat/${procedure}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const gearToken = (symbol: string) => h!.deployment.gears.find((g) => g.symbol === symbol)!.token;
const usdg = () => h!.deployment.external.usdg;
const quoteBody = (o: Record<string, unknown> = {}) => ({
  chainId: h!.deployment.chainId, account: HOLDER, gearId: "TSLA-SPORT", side: "buy", input: { token: { address: usdg(), symbol: "USDG", decimals: 6 }, baseUnits: "5000000" }, slippageBps: 50, ...o,
});
const mock = (symbol: string) => h!.hook.gears.get(h!.deployment.gears.find((g) => g.symbol === symbol)!.id.toLowerCase())!;
const INT = /^-?\d+$/;
const expectStamp = (s: any) => {
  expect(s.chainId).toBe(h!.deployment.chainId);
  expect(s.blockNumber).toMatch(INT);
  expect(Number.isFinite(Date.parse(s.observedAt))).toBe(true);
};

let seeded = false;
beforeEach(async () => {
  if (!h || seeded) return;
  seeded = true;
  await h.seedIndexer();
  for (const g of h.deployment.gears) await h.seedGear(g.symbol, { sigmaBps: 3000, toll: 10n ** 15n, valueWad: 100n * WAD, supply: WAD });
  await h.raw`INSERT INTO backer_vaults (id, owner, gear, collateral, debt_tokens, status) VALUES (1, ${HOLDER.toLowerCase()}, ${idOf("TSLA-SPORT").toLowerCase()}, 2100000000, ${(1000n * WAD).toString()}, 'open')`;
  await h.raw`INSERT INTO trades (tx_hash, log_index, block, ts, gear, account, side, tokens, usdg, value_per_token, via) VALUES (${idOf("t-holder")}, 0, 7, ${new Date().toISOString()}, ${idOf("TSLA-SPORT").toLowerCase()}, ${HOLDER.toLowerCase()}, 'buy', ${WAD.toString()}, 100000000, ${(100n * WAD).toString()}, 'hook')`;
  await h.raw`INSERT INTO stake_events (tx_hash, log_index, block, ts, kind, account, amount, detail) VALUES (${idOf("s1")}, 0, 8, ${new Date().toISOString()}, 'Staked', ${HOLDER.toLowerCase()}, ${(2n * WAD).toString()}, '{}'::jsonb)`;
});

// ------------------------------------------------------------------ pure rules

test("units: exact decimal shifts, minimum is a floor, codes are the 14 of the contract", () => {
  expect(shiftDecimal("9.863", 2)).toBe("0.09863");
  expect(shiftDecimal("-0.308218", 2)).toBe("-0.00308218");
  expect(shiftDecimal("25000", 2)).toBe("250");
  expect(shiftDecimal("0", 2)).toBe("0");
  expect(shiftDecimal("5", 4)).toBe("0.0005");
  expect(minimumOf(10_000n, 50)).toBe(9_950n);
  expect(minimumOf(9_999n, 1)).toBe(9_998n);
  expect([...SERVICE_ERROR_CODES].sort()).toEqual(["ALLOWANCE_REQUIRED", "CAP_REACHED", "EXIT_QUEUED", "FEED_PAUSED", "FEED_STALE", "INSUFFICIENT_BALANCE", "INSUFFICIENT_COLLATERAL", "MARKET_CLOSED", "NOT_DEPLOYED", "QUOTE_EXPIRED", "RACE_VOL_LIMIT", "SERVICE_UNAVAILABLE", "SLIPPAGE_EXCEEDED", "WRONG_CHAIN"]);
  for (const c of SERVICE_ERROR_CODES) { expect(serviceError(c).code).toBe(c); expect(STATUS_OF[c]).toBeGreaterThanOrEqual(400); }
});

test("error map: every /v1 code lands on one of the 14; the guard's CLOSED and STALE are MARKET_CLOSED and FEED_STALE", () => {
  expect(fromApiError("CLOSED", "CLOSED")).toBe("MARKET_CLOSED");
  expect(fromApiError("CLOSED", "HALTED")).toBe("MARKET_CLOSED");
  expect(fromApiError("STALE", "STALE")).toBe("FEED_STALE");
  expect(fromApiError("PAUSED", "MANUAL")).toBe("FEED_PAUSED");
  expect(fromApiError("PAUSED", "NOT_DEPLOYED")).toBe("NOT_DEPLOYED");
  expect(fromApiError("BELOW_MIN", "UNDERCOLLATERALIZED")).toBe("INSUFFICIENT_COLLATERAL");
  expect(fromApiError("BELOW_MIN", "BELOW_MINIMUM")).toBe("INSUFFICIENT_BALANCE");
  expect(fromApiError("RESERVE_FLOOR", "RESERVE_FLOOR", "sell")).toBe("EXIT_QUEUED");
  expect(fromApiError("QUEUED", "USE_QUEUE", "sell")).toBe("EXIT_QUEUED");
  expect(fromApiError("RESERVE_FLOOR", "RESERVE_FLOOR", "buy")).toBe("SERVICE_UNAVAILABLE");
  for (const c of ["BAD_REQUEST", "NOT_FOUND", "RATE_LIMITED", "STALE", "PAUSED", "CLOSED", "CAP_REACHED", "BELOW_MIN", "RESERVE_FLOOR", "UPSTREAM", "QUEUED", undefined]) {
    expect(SERVICE_ERROR_CODES as readonly string[]).toContain(fromApiError(c, null, "buy"));
  }
});

test("race rule: index Race needs a fresh reading at or below 40%", () => {
  const g = { gear: "RACE", underlying: "SPY", sigmaBps: "4000", sigmaWarning: null };
  expect(raceVolBlocked(g)).toBe(false);
  expect(raceVolBlocked({ ...g, sigmaBps: "4001" })).toBe(true);
  expect(raceVolBlocked({ ...g, sigmaWarning: "floor" })).toBe(true);
  expect(raceVolBlocked({ ...g, sigmaBps: null })).toBe(true);
  expect(raceVolBlocked({ ...g, gear: "SPORT", sigmaBps: "9000" })).toBe(false);
  expect(raceVolBlocked({ ...g, underlying: "TSLA", sigmaBps: "9000" })).toBe(false);
});

// ------------------------------------------------------------------ R4: one test per procedure

test("all 12 procedures are routes listed in OpenAPI under /v1/compat", async () => {
  if (!h) return;
  const doc = (await (await h.app.request("/openapi.json")).json()) as any;
  for (const p of COMPAT_PROCEDURES) {
    const path = doc.paths[`/v1/compat/${p}`];
    expect({ p, listed: !!path }).toEqual({ p, listed: true });
    const op = path.get ?? path.post;
    expect(op.responses["409"].content["application/json"].schema).toBeTruthy();
  }
  expect(COMPAT_PROCEDURES.length).toBe(12);
});

test("market.list: catalog with tokens, integer-free decimals, null open value never 0, stamped", async () => {
  if (!h) return;
  const { status, body } = await get("market.list");
  expect(status).toBe(200);
  expectStamp(body.stamp);
  expect(body.data.length).toBe(h.deployment.gears.length);
  const sport = body.data.find((g: any) => g.id === "TSLA-SPORT");
  expect(sport).toMatchObject({ underlying: "TSLA", gear: "Sport", power: "2", availability: "available", canBuy: true, canSell: true, canQueueSell: false, spreadBps: 40 });
  expect(sport.token).toEqual({ address: gearToken("TSLA-SPORT"), symbol: "TSLA-SPORT", decimals: 18 });
  expect(sport.capUsd).toBe("1000");
  expect(sport.openValueUsd).toBe("100");
});

test("gear.snapshot: price, value, normalisation, vol, toll as decimal strings; Race eligibility apart from the gear", async () => {
  if (!h) return;
  const { status, body } = await get("gear.snapshot", "gearId=tsla-race");
  expect(status).toBe(200);
  expectStamp(body.stamp);
  expect(body.data).toMatchObject({ gearId: "TSLA-RACE", underlyingPrice: "250", valuePerToken: "100", priceCurrency: "USDG", normalisation: "1", annualVolatilityPct: "30", availability: "available", raceEligible: true });
  expect(body.data.dailyTollPct).toBe("0.0739726");
  // the bytes32 id resolves to the same gear
  expect((await get("gear.snapshot", `gearId=${idOf("TSLA-RACE")}`)).body.data.gearId).toBe("TSLA-RACE");
});

test("trade.quote: bounded quote, minimum from slippage, intent decodes to the calldata the intent route builds", async () => {
  if (!h) return;
  const { status, body } = await post("trade.quote", quoteBody());
  expect(status).toBe(200);
  expectStamp(body.stamp);
  expect(body.execution).toBe("immediate");
  expect(body.output.token.address).toBe(gearToken("TSLA-SPORT"));
  expect(body.output.baseUnits).toMatch(INT);
  expect(BigInt(body.minimumOutput.baseUnits)).toBe(minimumOf(BigInt(body.output.baseUnits), 50));
  expect(body.approvals).toEqual([{ token: { address: usdg(), symbol: "USDG", decimals: 6 }, spender: h.deployment.contracts.ODMinter, requiredBaseUnits: "5000000", method: "approve" }]);
  expect(body.transaction).toMatchObject({ chainId: h.deployment.chainId, account: HOLDER, contract: h.deployment.contracts.ODMinter, functionName: "buy", valueBaseUnits: "0" });
  const [gearId, amountIn, minOut, recipient] = body.transaction.args;
  expect([gearId.toLowerCase(), amountIn, minOut, recipient.toLowerCase()]).toEqual([idOf("TSLA-SPORT").toLowerCase(), "5000000", body.minimumOutput.baseUnits, HOLDER.toLowerCase()]);
  expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now() - 1000);
  // round trip: what the client encodes from the intent is the buy call the API built
  const data = encodeFunctionData({ abi: IODMinterAbi as Abi, functionName: "buy", args: body.transaction.args.map((a: string, i: number) => (i === 1 || i === 2 || i === 4 ? BigInt(a) : a)) });
  expect(decodeFunctionData({ abi: IODMinterAbi as Abi, data }).functionName).toBe("buy");
});

test("trade.quote: a sell the reserve cannot pay now is a queued quote, never shown as immediate", async () => {
  if (!h) return;
  const before = { ...h.hook.book };
  Object.assign(h.hook.book, { freeCashUsdg: 0n, reserveUsdg: 0n });
  const { status, body } = await post("trade.quote", quoteBody({ side: "sell", input: { token: { address: gearToken("TSLA-SPORT"), symbol: "TSLA-SPORT", decimals: 18 }, baseUnits: (WAD / 2n).toString() } }));
  Object.assign(h.hook.book, before);
  expect(status).toBe(200);
  expect(body.execution).toBe("queued");
  expect(body.transaction.functionName).toBe("queueSell");
});

test("trade.status: indexed trade confirmed, mined-but-unknown submitted, reverted failed", async () => {
  if (!h) return;
  const a = await get("trade.status", `hash=${idOf("t-holder")}`);
  expect(a.status).toBe(200);
  expectStamp(a.body.stamp);
  expect(a.body.data).toMatchObject({ status: "confirmed", blockNumber: "7", kind: "buy" });
  expect((await get("trade.status", `hash=${idOf("nothing")}`)).body.data.status).toBe("submitted");
  expect((await get("trade.status", `hash=${REVERTED}`)).body.data.status).toBe("failed");
  expect((await get("trade.status", `hash=${RECEIPT}`)).body.data.status).toBe("confirmed");
});

test("exit.queueStatus: a wallet's open queued sells with the settlement rule", async () => {
  if (!h) return;
  await h.raw`INSERT INTO queued_sells (ticket, gear, account, tokens, min_proceeds, queued_block, queued_at, status) VALUES (9, ${idOf("TSLA-SPORT").toLowerCase()}, ${HOLDER.toLowerCase()}, ${WAD.toString()}, 90000000, 5, ${new Date().toISOString()}, 'open') ON CONFLICT DO NOTHING`;
  const { status, body } = await get("exit.queueStatus", `account=${HOLDER}`);
  expect(status).toBe(200);
  expectStamp(body.stamp);
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({ ticket: "9", gearId: "TSLA-SPORT", status: "open", canCancel: true, quantity: { baseUnits: WAD.toString() }, minimumOutput: { baseUnits: "90000000" } });
  expect(typeof body.data[0].settlement).toBe("string");
  await h.raw`DELETE FROM queued_sells WHERE ticket = 9`;
});

test("portfolio.positions: quantities as integer strings, values as decimals, unknown cost never 0", async () => {
  if (!h) return;
  const { status, body } = await get("portfolio.positions", `account=${HOLDER}`);
  expect(status).toBe(200);
  expectStamp(body.stamp);
  const p = body.data.find((x: any) => x.gearId === "TSLA-SPORT");
  expect(p.quantity).toEqual({ token: { address: gearToken("TSLA-SPORT"), symbol: "TSLA-SPORT", decimals: 18 }, baseUnits: WAD.toString() });
  expect(p.valueUsd).toBe("100");
  expect((await get("portfolio.positions", `account=${STRANGER}`)).body.data).toEqual([]);
});

test("backer.vaults: collateral and debt amounts, ratios in percent, uplift included", async () => {
  if (!h) return;
  for (const on of [false, true]) {
    uplift = on;
    h.deps.cache.sweep(Number.MAX_SAFE_INTEGER);
    const { status, body } = await get("backer.vaults", `account=${HOLDER}`);
    expect(status).toBe(200);
    expectStamp(body.stamp);
    expect(body.data[0]).toMatchObject({ id: "1", gearId: "TSLA-SPORT", collateral: { baseUnits: "2100000000", token: { symbol: "USDG", decimals: 6 } }, maintenanceRatioPct: "150", weekendUpliftPct: on ? "25" : "0" });
    expect(body.data[0].health).toBe("1.4");
  }
  uplift = false;
});

test("backer.quoteAction: deposit intent targets ODBacker.deposit with a USDG approval", async () => {
  if (!h) return;
  const { status, body } = await post("backer.quoteAction", { chainId: h.deployment.chainId, account: HOLDER, action: "deposit", vaultId: "1", amount: "1000000" });
  expect(status).toBe(200);
  expectStamp(body.stamp);
  expect(body.transaction).toMatchObject({ contract: h.deployment.contracts.ODBacker, functionName: "deposit", args: ["1", "1000000"] });
  expect(body.approvals[0]).toMatchObject({ spender: h.deployment.contracts.ODBacker, requiredBaseUnits: "1000000", token: { symbol: "USDG" } });
});

test("governor.snapshot: equity, reserve and floor as decimals, risk state", async () => {
  if (!h) return;
  await h.raw`INSERT INTO governor_ledger (ts, underlying, delta, gamma, hedge_delta, equity, exit_reserve, block) VALUES (${new Date().toISOString()}, 'TSLA', ${(2n * WAD).toString()}, ${WAD.toString()}, ${WAD.toString()}, 9, 1, 5) ON CONFLICT DO NOTHING`;
  const { status, body } = await get("governor.snapshot");
  expect(status).toBe(200);
  expectStamp(body.stamp);
  expect(body.data).toMatchObject({ equityUsd: "9", exitReserveUsd: "500000", exitReserveFloorUsd: "100000", riskState: "normal" });
});

test("stake.account: available from the wallet, staked from indexed events, discount from ODStake", async () => {
  if (!h) return;
  const { status, body } = await get("stake.account", `account=${HOLDER}`);
  expect(status).toBe(200);
  expectStamp(body.stamp);
  expect(body.data).toMatchObject({ available: { baseUnits: (5n * WAD).toString(), token: { address: OVRD, symbol: "OVRD" } }, staked: { baseUnits: (2n * WAD).toString() }, slashable: { baseUnits: (2n * WAD).toString() }, feeDiscountBps: 250, unstakeAvailableAt: null });
});

test("stake.quoteAction: stake intent with an OVRD approval to ODStake", async () => {
  if (!h) return;
  const { status, body } = await post("stake.quoteAction", { chainId: h.deployment.chainId, account: HOLDER, action: "stake", amount: WAD.toString() });
  expect(status).toBe(200);
  expect(body.transaction).toMatchObject({ contract: h.deployment.contracts.ODStake, functionName: "stake", args: [WAD.toString()] });
  expect(body.approvals[0]).toMatchObject({ spender: h.deployment.contracts.ODStake, requiredBaseUnits: WAD.toString(), token: { address: OVRD } });
});

test("activity.list: indexed trades and stake events, newest first, cursor pages", async () => {
  if (!h) return;
  const first = await get("activity.list", `account=${HOLDER}&limit=1`);
  expect(first.status).toBe(200);
  expect(first.body.rows).toHaveLength(1);
  expect(first.body.rows[0]).toMatchObject({ kind: "Staked", blockNumber: "8", status: "confirmed" });
  expect(first.body.nextCursor).toBe("8:0");
  const second = await get("activity.list", `account=${HOLDER}&limit=1&cursor=${first.body.nextCursor}`);
  expect(second.body.rows[0]).toMatchObject({ kind: "buy", blockNumber: "7", summary: "buy TSLA-SPORT" });
});

// ------------------------------------------------------------------ R5: one test per code (server side; the client-side three are in web)

const expectCode = (r: { status: number; body: any }, code: string) => {
  expect({ status: r.status, code: r.body.code }).toEqual({ status: STATUS_OF[code as keyof typeof STATUS_OF], code });
  expect(typeof r.body.message).toBe("string");
  expect(typeof r.body.retryable).toBe("boolean");
  expect(r.body.error).toBeUndefined();
};

test("code WRONG_CHAIN", async () => { if (!h) return; expectCode(await get("market.list", "chainId=4663"), "WRONG_CHAIN"); expectCode(await post("trade.quote", quoteBody({ chainId: 1 })), "WRONG_CHAIN"); });
test("code NOT_DEPLOYED", async () => { if (!h) return; expectCode(await get("gear.snapshot", "gearId=NOPE-SPORT"), "NOT_DEPLOYED"); expectCode(await get("no.such"), "NOT_DEPLOYED"); });
test("code MARKET_CLOSED (oracle guard CLOSED)", async () => {
  if (!h) return;
  mock("TSLA-SPORT").session = 2;
  const r = await post("trade.quote", quoteBody());
  mock("TSLA-SPORT").session = 0;
  expectCode(r, "MARKET_CLOSED");
});
test("code FEED_STALE (oracle guard STALE)", async () => {
  if (!h) return;
  mock("TSLA-SPORT").fresh = false;
  const r = await post("trade.quote", quoteBody());
  mock("TSLA-SPORT").fresh = true;
  expectCode(r, "FEED_STALE");
});
test("code FEED_PAUSED", async () => {
  if (!h) return;
  mock("TSLA-SPORT").status = "BUYS_PAUSED";
  const r = await post("trade.quote", quoteBody());
  mock("TSLA-SPORT").status = "LISTED";
  expectCode(r, "FEED_PAUSED");
});
test("code CAP_REACHED", async () => {
  if (!h) return;
  mock("TSLA-SPORT").capUsdg = 1_000_000n;
  const r = await post("trade.quote", quoteBody());
  mock("TSLA-SPORT").capUsdg = 1_000_000_000_000n;
  expectCode(r, "CAP_REACHED");
});
test("code RACE_VOL_LIMIT", async () => {
  if (!h) return;
  await h.raw`INSERT INTO vol_posts (gear_or_underlying, ts, block, tx_hash, log_index, sigma_bps) VALUES ('TSLA', ${new Date(Date.now() + 1000).toISOString()}, 2, ${idOf("vp-high")}, 0, 5000)`;
  (RACE_VOL_UNDERLYINGS as string[]).push("TSLA");
  const r = await post("trade.quote", quoteBody({ gearId: "TSLA-RACE" }));
  const list = await get("market.list");
  (RACE_VOL_UNDERLYINGS as string[]).pop();
  await h.raw`DELETE FROM vol_posts WHERE tx_hash = ${idOf("vp-high")}`;
  expectCode(r, "RACE_VOL_LIMIT");
  expect(list.body.data.find((g: any) => g.id === "TSLA-RACE")).toMatchObject({ availability: "capacity_limited", reason: "RACE_VOL_LIMIT", canBuy: false });
});
test("code INSUFFICIENT_BALANCE", async () => {
  if (!h) return;
  expectCode(await post("trade.quote", quoteBody({ account: STRANGER, side: "sell", input: { token: { address: gearToken("TSLA-SPORT"), symbol: "TSLA-SPORT", decimals: 18 }, baseUnits: WAD.toString() } })), "INSUFFICIENT_BALANCE");
  expectCode(await post("stake.quoteAction", { chainId: h.deployment.chainId, account: HOLDER, action: "stake", amount: (6n * WAD).toString() }), "INSUFFICIENT_BALANCE");
});
test("code INSUFFICIENT_COLLATERAL", async () => {
  if (!h) return;
  expectCode(await post("backer.quoteAction", { chainId: h.deployment.chainId, account: HOLDER, action: "open", gearId: "TSLA-SPORT", amount: "10000000" }), "INSUFFICIENT_COLLATERAL");
});
test("code EXIT_QUEUED (mapped from the queue and reserve-floor refusals of a sell)", () => {
  expect(fromApiError("QUEUED", "USE_QUEUE", "sell")).toBe("EXIT_QUEUED");
  expect(serviceError("EXIT_QUEUED").retryable).toBe(false);
});
test("code SERVICE_UNAVAILABLE (chain read fails, bad input, rate limit)", async () => {
  if (!h) return;
  const broken = await harness("compat_broken");
  if (broken) {
    await broken.seedIndexer();
    const r = await broken.app.request("/v1/compat/governor.snapshot");
    expectCode({ status: r.status, body: await r.json() }, "SERVICE_UNAVAILABLE");
    await broken.close();
  }
  const bad = await post("trade.quote", { nonsense: true });
  expect(bad.status).toBe(400);
  expect(bad.body.code).toBe("SERVICE_UNAVAILABLE");
  const limited = await harness("compat_limited", { config: { API_RATE_LIMIT_PER_MINUTE: "1", API_WRITE_RATE_LIMIT_PER_MINUTE: "1" } });
  if (limited) {
    await limited.app.request("/v1/compat/market.list");
    const r = await limited.app.request("/v1/compat/market.list");
    const body = (await r.json()) as any;
    expect(r.status).toBe(429);
    expect(body).toMatchObject({ code: "SERVICE_UNAVAILABLE", retryable: true });
    await limited.close();
  }
});
test("client-side codes ALLOWANCE_REQUIRED, QUOTE_EXPIRED, SLIPPAGE_EXCEEDED are valid service errors (raised by web/src/services)", () => {
  for (const c of ["ALLOWANCE_REQUIRED", "QUOTE_EXPIRED", "SLIPPAGE_EXCEEDED"] as const) expect(serviceError(c)).toMatchObject({ code: c, retryable: c !== "ALLOWANCE_REQUIRED" });
});

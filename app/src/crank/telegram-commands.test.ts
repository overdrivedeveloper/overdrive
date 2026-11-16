import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandOf, createBot, fmtUnits, loadBotSettings, NotConfigured, type BotSettings } from "./telegram-commands";

const servers: { stop(): void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(); });

const OPS = "-1001";
const API: Record<string, unknown> = {
  "/v1/status": { indexer: { lagBlocks: "2", snapshotStale: false, lastError: null }, services: [{ job: "toll", lastError: "boom secret" }], oracle: { ok: true, markets: [] }, pauses: [] },
  "/v1/gears": { gears: [{ symbol: "TSLA2X", buyable: true, tollPerDayBps: "12", holdersReceive: false, session: "OPEN", spreadBps: 8, reason: null }] },
  "/v1/governor": { live: true, equityWad: "5000000000000000000000", freeCashUsdg: "1234560000", exitReserve: { balanceUsdg: "900000000", floorUsdg: "500000000" }, stressLoss: { lossWad: "1000000000000000000", budgetWad: "2000000000000000000" }, buysPaused: false, buysPausedReason: null, hedgeStale: false, underlyings: [{ underlying: "TSLA", residual: "1500000000000000000", unhedgedSince: null, matchesChain: true }] },
  "/v1/exit": { reserveUsdg: "900000000", floorUsdg: "500000000", aboveFloor: true, queue: { depth: 3, oldestAgeSec: 600 } },
};

function setup(updates: unknown[][], over: Partial<BotSettings> = {}) {
  const sent: { chat_id: string; text: string }[] = [];
  const apiHits: string[] = [];
  let polls = 0;
  const tg = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    const body = await req.json() as any;
    if (url.pathname.endsWith("/getUpdates")) return Response.json({ ok: true, result: updates[polls++] ?? [], offsetSeen: body.offset });
    if (url.pathname.endsWith("/sendMessage")) { sent.push(body); return Response.json({ ok: true }); }
    return new Response("no", { status: 404 });
  } });
  const api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const p = new URL(req.url).pathname; apiHits.push(`${req.method} ${p}`);
    return p in API ? Response.json(API[p]) : new Response("no", { status: 404 });
  } });
  servers.push(tg, api);
  const settings: BotSettings = { token: "123:SECRETTOKEN", opsChatId: OPS, allowedUserIds: new Set(["7"]), apiUrl: `http://127.0.0.1:${api.port}`, telegramBase: `http://127.0.0.1:${tg.port}`, ratePerMinute: 3, ...over };
  return { bot: createBot(settings, { now: () => 1_000 }), sent, apiHits };
}
const msg = (id: number, text: string, chat = OPS, from = 7) => ({ update_id: id, message: { text, chat: { id: Number(chat) }, from: { id: from } } });

describe("telegram team commands", () => {
  test("answers each read-only command in plain English", async () => {
    const { bot, sent, apiHits } = setup([[msg(1, "/status"), msg(2, "/markets"), msg(3, "/governor@ovrd_bot")], [msg(4, "/hedge"), msg(5, "/queue"), msg(6, "/help")]], { ratePerMinute: 99 });
    await bot.pollOnce(); await bot.pollOnce();
    expect(sent).toHaveLength(6);
    expect(sent.every((s) => s.chat_id === OPS)).toBe(true);
    expect(sent[0]!.text).toContain("1 with an error (toll)");
    expect(sent[0]!.text).not.toContain("boom secret");
    expect(sent[1]!.text).toContain("TSLA2X: buyable, toll 12 bps a day");
    expect(sent[2]!.text).toContain("free cash: $1,234.56");
    expect(sent[3]!.text).toContain("TSLA: residual 1.50");
    expect(sent[4]!.text).toContain("3 waiting, oldest 10 min");
    expect(sent[5]!.text).toContain("/queue");
    expect(apiHits.every((h) => h.startsWith("GET /v1/"))).toBe(true);
  });
  test("ignores other chats, users not on the allowlist, and plain text", async () => {
    const { bot, sent, apiHits } = setup([[msg(1, "/status", "-999"), msg(2, "/status", OPS, 8), msg(3, "hello"), { update_id: 4 }]]);
    expect(await bot.pollOnce()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(apiHits).toHaveLength(0);
  });
  test("rate limits per user", async () => {
    const { bot, sent } = setup([[msg(1, "/help"), msg(2, "/help"), msg(3, "/help"), msg(4, "/help")]]);
    await bot.pollOnce();
    expect(sent).toHaveLength(4);
    expect(sent[3]!.text).toContain("Slow down");
  });
  test("unknown commands get help; unwritable commands do not exist; API failure gives a safe line", async () => {
    const { bot, sent } = setup([[msg(1, "/pause now"), msg(2, "/constructor"), msg(3, "/hedge")]], { ratePerMinute: 99 });
    delete API["/v1/governor"];
    try { await bot.pollOnce(); } finally { API["/v1/governor"] = { live: true, underlyings: [] }; }
    expect(sent[0]!.text).toContain("I do not know /pause");
    expect(sent[1]!.text).toContain("I do not know /constructor");
    expect(sent[2]!.text).toBe("I could not read the API just now. Try again in a minute.");
    expect(sent.map((s) => s.text).join()).not.toContain("SECRETTOKEN");
  });
  test("advances the offset so an update is never answered twice", async () => {
    const offsets: number[] = [];
    const tg = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { const b = await req.json() as any; if (req.url.endsWith("/getUpdates")) { offsets.push(b.offset); return Response.json({ result: offsets.length === 1 ? [msg(41, "/help")] : [] }); } return Response.json({ ok: true }); } });
    servers.push(tg);
    const bot = createBot({ token: "t", opsChatId: OPS, allowedUserIds: new Set(["7"]), apiUrl: "http://127.0.0.1:1", telegramBase: `http://127.0.0.1:${tg.port}`, ratePerMinute: 6 });
    await bot.pollOnce(); await bot.pollOnce();
    expect(offsets).toEqual([0, 42]);
  });
});

describe("settings and helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "tgbot-"));
  test("refuses to run without an ops chat (no community fallback) or without an allowlist", () => {
    const f = join(dir, "a.env"); writeFileSync(f, "TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_COMMUNITY_CHAT_ID=-5\n");
    expect(() => loadBotSettings(f, { TELEGRAM_ALLOWED_USER_IDS: "7" })).toThrow(NotConfigured);
    writeFileSync(f, "TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_OPS_CHAT_ID=-5\n");
    expect(() => loadBotSettings(f, {})).toThrow(NotConfigured);
    expect(loadBotSettings(f, { TELEGRAM_ALLOWED_USER_IDS: "7, 9,x" }).allowedUserIds).toEqual(new Set(["7", "9"]));
  });
  test("only a local API and Telegram or a local test server are accepted", () => {
    const env = { TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_OPS_CHAT_ID: "-5", TELEGRAM_ALLOWED_USER_IDS: "7" };
    expect(() => loadBotSettings("", { ...env, TELEGRAM_BOT_API_URL: "https://evil.example" })).toThrow();
    expect(() => loadBotSettings("", { ...env, TELEGRAM_API_BASE: "https://evil.example" })).toThrow();
    expect(loadBotSettings("", env).apiUrl).toBe("http://127.0.0.1:38101");
  });
  test("commandOf and fmtUnits", () => {
    expect(commandOf("/Status@bot extra")).toBe("status");
    expect(commandOf("status")).toBeNull();
    expect(fmtUnits("1234567890", 6, "$")).toBe("$1,234.56");
    expect(fmtUnits("-5", 6)).toBe("-0.00");
    expect(fmtUnits(null, 6)).toBe("unknown");
  });
});

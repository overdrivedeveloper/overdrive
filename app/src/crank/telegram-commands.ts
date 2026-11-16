// Read-only team bot commands for the team/ops Telegram chat. Long-polls getUpdates (no public webhook), answers only in
// TELEGRAM_OPS_CHAT_ID and only to TELEGRAM_ALLOWED_USER_IDS, reads the local API (never RPC, never a key), and never sends
// a transaction, changes config or posts anywhere else. Answers are plain English. The token is placed only in the request
// URL; no message text or token reaches a log.
import { readFileSync } from "node:fs";
import { readEnvValue } from "./telegram";

export interface BotSettings {
  token: string;
  opsChatId: string;
  allowedUserIds: ReadonlySet<string>;
  /** Base URL of the Overdrive API (read-only routes only). */
  apiUrl: string;
  /** Telegram API base: the real one or a local test server. */
  telegramBase: string;
  /** Commands per user per minute. */
  ratePerMinute: number;
}

const TELEGRAM_BASE = "https://api.telegram.org";

function telegramBaseOf(configured: string): string {
  const base = configured.replace(/\/$/, "");
  if (base !== TELEGRAM_BASE && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error("TELEGRAM_API_BASE must be https://api.telegram.org or a local test server");
  return base;
}

function localApiUrl(configured: string): string {
  const base = configured.replace(/\/$/, "");
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error("TELEGRAM_BOT_API_URL must be a local http URL (the API on this box)");
  return base;
}

/** Settings from an env file (may be "") or process env: TELEGRAM_BOT_TOKEN, TELEGRAM_OPS_CHAT_ID. No fallback to the community chat. */
export class NotConfigured extends Error {}

export function loadBotSettings(envFile: string, env: Record<string, string | undefined>): BotSettings {
  const file = envFile ? readFileSync(envFile, "utf8") : "";
  const token = readEnvValue(file, "TELEGRAM_BOT_TOKEN") || (env.TELEGRAM_BOT_TOKEN ?? "");
  const opsChatId = readEnvValue(file, "TELEGRAM_OPS_CHAT_ID") || (env.TELEGRAM_OPS_CHAT_ID ?? "");
  if (!token || !opsChatId) throw new NotConfigured("no TELEGRAM_BOT_TOKEN or TELEGRAM_OPS_CHAT_ID (the bot answers only in the ops chat)");
  const allowed = (env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  if (allowed.length === 0) throw new NotConfigured("TELEGRAM_ALLOWED_USER_IDS must list at least one numeric user id");
  const rate = Number(env.TELEGRAM_BOT_RATE_PER_MINUTE ?? "6");
  return {
    token, opsChatId, allowedUserIds: new Set(allowed),
    apiUrl: localApiUrl(env.TELEGRAM_BOT_API_URL ?? `http://127.0.0.1:${env.API_PORT ?? "38101"}`),
    telegramBase: telegramBaseOf(env.TELEGRAM_API_BASE ?? TELEGRAM_BASE),
    ratePerMinute: Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 6,
  };
}

/** Raw integer string with `decimals` to a readable number with thousands separators and two places. */
export function fmtUnits(raw: string | null | undefined, decimals: number, prefix = ""): string {
  if (raw === null || raw === undefined || !/^-?\d+$/.test(raw)) return "unknown";
  const neg = raw.startsWith("-");
  const digits = (neg ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = digits.slice(digits.length - decimals, digits.length - decimals + 2).padEnd(2, "0");
  return `${neg ? "-" : ""}${prefix}${whole}.${frac}`;
}
const usdg = (raw: unknown): string => fmtUnits(typeof raw === "string" ? raw : null, 6, "$");
const wad = (raw: unknown, prefix = ""): string => fmtUnits(typeof raw === "string" ? raw : null, 18, prefix);
const age = (sec: unknown): string => typeof sec !== "number" ? "unknown" : sec < 120 ? `${Math.round(sec)} s` : sec < 7200 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`;
const yesNo = (v: unknown): string => (v ? "yes" : "no");

type Json = Record<string, any>;
export type ApiGet = (path: string) => Promise<Json>;

export function createApiGet(settings: BotSettings, fetchImpl: typeof fetch = fetch): ApiGet {
  return async (path) => {
    const response = await fetchImpl(`${settings.apiUrl}${path}`, { method: "GET", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`API answered HTTP ${response.status}`);
    return (await response.json()) as Json;
  };
}

export const HELP_TEXT = [
  "Team commands (read only, nothing here can move funds or change settings):",
  "/status  is the system healthy: indexer, services, prices, pauses",
  "/markets  each gear: can it be bought, its daily toll, market session",
  "/governor  the Governor: equity, free cash, exit reserve, stress",
  "/hedge  hedge residual per underlying",
  "/queue  the exit queue: how many sells wait and for how long",
  "/help  this list",
].join("\n");

export const COMMANDS: Record<string, (get: ApiGet) => Promise<string>> = {
  async status(get) {
    const s = await get("/v1/status");
    const lines = ["System status"];
    const lag = s.indexer?.lagBlocks;
    lines.push(`Indexer: ${lag === null || lag === undefined ? "lag unknown" : `${lag} blocks behind`}${s.indexer?.snapshotStale ? ", data is stale" : ""}${s.indexer?.lastError ? ", last run had an error" : ""}`);
    const bad = (s.services ?? []).filter((x: Json) => x.lastError);
    lines.push(`Services: ${(s.services ?? []).length} reporting, ${bad.length} with an error${bad.length ? ` (${bad.map((x: Json) => x.job).join(", ")})` : ""}`);
    lines.push(s.oracle ? `Prices: ${s.oracle.ok ? "every market has a reference price" : `missing a reference for ${(s.oracle.markets ?? []).filter((m: Json) => !m.ok).map((m: Json) => m.symbol).join(", ")}`}` : "Prices: not checked yet");
    const pauses = s.pauses ?? [];
    lines.push(pauses.length ? `Pauses (${pauses.length}): ${pauses.map((p: Json) => `${p.scope}${p.ref ? ` ${p.ref}` : ""}`).join(", ")}. Only the timelock can unpause, after its delay.` : "Pauses: none");
    return lines.join("\n");
  },
  async markets(get) {
    const g = await get("/v1/gears");
    const rows = (g.gears ?? []) as Json[];
    if (!rows.length) return "No gears are listed.";
    return ["Gears"].concat(rows.map((x) => `${x.symbol}: ${x.buyable ? "buyable" : `buys off${x.reason ? ` (${x.reason})` : ""}`}, toll ${x.tollPerDayBps} bps a day${x.holdersReceive ? " (holders receive)" : ""}, session ${x.session}, spread ${x.spreadBps} bps`)).join("\n");
  },
  async governor(get) {
    const g = await get("/v1/governor");
    const lines = [`The Governor${g.live ? "" : " (snapshot is old, numbers are for reference only)"}`];
    lines.push(`Equity: ${wad(g.equityWad, "$")}, free cash: ${usdg(g.freeCashUsdg)}`);
    lines.push(`Exit reserve: ${usdg(g.exitReserve?.balanceUsdg)} (floor ${usdg(g.exitReserve?.floorUsdg)})`);
    lines.push(`Stress loss: ${wad(g.stressLoss?.lossWad, "$")} against a budget of ${wad(g.stressLoss?.budgetWad, "$")}`);
    lines.push(`Buys paused: ${yesNo(g.buysPaused)}${g.buysPausedReason ? ` (${g.buysPausedReason})` : ""}. Hedge data stale: ${yesNo(g.hedgeStale)}`);
    return lines.join("\n");
  },
  async hedge(get) {
    const g = await get("/v1/governor");
    const rows = (g.underlyings ?? []) as Json[];
    if (!rows.length) return "No underlyings are open.";
    return ["Hedge residual per underlying (what is not yet hedged)"].concat(rows.map((u) => `${u.underlying}: residual ${wad(u.residual)}${u.unhedgedSince ? `, unhedged since ${u.unhedgedSince}` : ""}${u.matchesChain === false ? ", ledger does not match the chain" : ""}`)).join("\n");
  },
  async queue(get) {
    const e = await get("/v1/exit");
    const q = e.queue ?? {};
    return [
      `Exit queue: ${q.depth ?? "unknown"} waiting${q.depth ? `, oldest ${age(q.oldestAgeSec)}` : ""}`,
      `Exit reserve: ${usdg(e.reserveUsdg)} (floor ${usdg(e.floorUsdg)}), above the floor: ${yesNo(e.aboveFloor)}`,
    ].join("\n");
  },
  async help() { return HELP_TEXT; },
};

/** Parses "/cmd@botname args" to the command word, or null for anything else. */
export function commandOf(text: string | undefined): string | null {
  const m = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/i.exec(text ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

interface Update { update_id: number; message?: { text?: string; chat?: { id?: number | string }; from?: { id?: number | string } } }

export interface Bot {
  /** One poll: fetch updates, answer, advance the offset. Returns how many replies were sent. */
  pollOnce(timeoutSeconds?: number): Promise<number>;
}

export function createBot(settings: BotSettings, opts: { fetchImpl?: typeof fetch; get?: ApiGet; now?: () => number } = {}): Bot {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const get = opts.get ?? createApiGet(settings, fetchImpl);
  const now = opts.now ?? Date.now;
  const recent = new Map<string, number[]>();
  let offset = 0;

  const call = async (method: string, body: unknown): Promise<any> => {
    try {
      const r = await fetchImpl(`${settings.telegramBase}/bot${settings.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`Telegram answered HTTP ${r.status}`);
      return await r.json();
    } catch (error) {
      throw new Error(`Telegram ${method} failed: ${error instanceof Error ? error.message.replaceAll(settings.token, "<token>") : "error"}`);
    }
  };

  const limited = (user: string): boolean => {
    const t = now();
    const hits = (recent.get(user) ?? []).filter((x) => t - x < 60_000);
    if (hits.length >= settings.ratePerMinute) { recent.set(user, hits); return true; }
    hits.push(t); recent.set(user, hits);
    return false;
  };

  const reply = async (text: string): Promise<void> => { await call("sendMessage", { chat_id: settings.opsChatId, text, disable_web_page_preview: true }); };

  return {
    async pollOnce(timeoutSeconds = 25) {
      const res = await call("getUpdates", { offset, timeout: timeoutSeconds, allowed_updates: ["message"] });
      let sent = 0;
      for (const u of ((res?.result ?? []) as Update[])) {
        offset = Math.max(offset, u.update_id + 1);
        const m = u.message;
        // Silent for any other chat or any user not on the allowlist: no reply, nothing about it is logged.
        if (!m || String(m.chat?.id) !== settings.opsChatId || !m.from?.id || !settings.allowedUserIds.has(String(m.from.id))) continue;
        const cmd = commandOf(m.text);
        if (!cmd) continue;
        if (limited(String(m.from.id))) { await reply("Slow down: too many commands this minute. Try again shortly."); sent++; continue; }
        const handler = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
        if (!handler) { await reply(`I do not know /${cmd}.\n${HELP_TEXT}`); sent++; continue; }
        let text: string;
        try { text = await handler(get); } catch { text = "I could not read the API just now. Try again in a minute."; }
        await reply(text); sent++;
      }
      return sent;
    },
  };
}

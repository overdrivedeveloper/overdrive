// Telegram alerts from a root env file (parsed, never sourced). The token is read here and placed only in the request URL;
// nothing from the file or the URL reaches a log. Free API, no key besides the bot token the owner creates.
import { readFileSync } from "node:fs";
import type { Alert, AlertSender } from "./alerts";

/** KEY=value lines of an env file. Returns "" for a missing key. */
export function readEnvValue(text: string, key: string): string {
  let value = "";
  for (const line of text.split("\n")) if (line.startsWith(`${key}=`)) value = line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "");
  return value;
}

const DEFAULT_API_BASE = "https://api.telegram.org";

function apiBase(configured: string): string {
  const base = configured.replace(/\/$/, "");
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base);
  if (base !== "https://api.telegram.org" && !local) throw new Error("TELEGRAM_API_BASE must be https://api.telegram.org or a local test server");
  return base;
}

/**
 * Posts `text` to the ops chat (TELEGRAM_OPS_CHAT_ID) only. Ops alerts never go to the community chat: with no ops
 * chat id the call refuses before any request, even when TELEGRAM_COMMUNITY_CHAT_ID is set. True when Telegram accepted it.
 */
export async function sendTelegram(envFile: string, text: string, fetchImpl: typeof fetch = fetch, apiBaseUrl: string = DEFAULT_API_BASE): Promise<boolean> {
  const file = readFileSync(envFile, "utf8");
  const token = readEnvValue(file, "TELEGRAM_BOT_TOKEN");
  const ops = readEnvValue(file, "TELEGRAM_OPS_CHAT_ID");
  if (!token) throw new Error(`no TELEGRAM_BOT_TOKEN in ${envFile}`);
  if (!ops) throw new Error(`no TELEGRAM_OPS_CHAT_ID in ${envFile}; ops alerts are never sent to the community chat`);
  const base = apiBase(apiBaseUrl);
  try {
    const response = await fetchImpl(`${base}/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: ops, text, disable_web_page_preview: true }),
    });
    if (!response.ok) throw new Error(`Telegram answered HTTP ${response.status}`);
    return true;
  } catch (error) {
    throw new Error(`Telegram send failed: ${error instanceof Error ? error.message.replaceAll(token, "<token>") : "error"}`);
  }
}

export const formatAlert = (alert: Alert): string => `${alert.level === "critical" ? "CRITICAL" : "Warning"}: ${alert.text}`;

/** The sender that `setAlertSender` installs when TELEGRAM_ENV_FILE is set. */
export function createTelegramSender(envFile: string, apiBaseUrl: string = DEFAULT_API_BASE, fetchImpl: typeof fetch = fetch): AlertSender {
  return async (alert) => { await sendTelegram(envFile, formatAlert(alert), fetchImpl, apiBaseUrl); };
}

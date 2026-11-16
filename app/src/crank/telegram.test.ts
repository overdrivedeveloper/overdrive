import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendTelegram } from "./telegram";

function envFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "od-telegram-"));
  const file = join(dir, "telegram.env");
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

function recorder() {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("sendTelegram routes ops alerts to the ops chat only", () => {
  test("only the community chat id set: refuses and sends nothing", async () => {
    const f = envFile("TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_COMMUNITY_CHAT_ID=-100777\n");
    const { calls, impl } = recorder();
    await expect(sendTelegram(f, "CRITICAL: test", impl)).rejects.toThrow(/TELEGRAM_OPS_CHAT_ID/);
    expect(calls.length).toBe(0);
  });

  test("both ids set: posts once, to the ops chat, never the community chat", async () => {
    const f = envFile("TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_OPS_CHAT_ID=-100111\nTELEGRAM_COMMUNITY_CHAT_ID=-100777\n");
    const { calls, impl } = recorder();
    expect(await sendTelegram(f, "Warning: test", impl)).toBe(true);
    expect(calls.length).toBe(1);
    const body = calls[0]?.body ?? "";
    expect(JSON.parse(body).chat_id).toBe("-100111");
    expect(body).not.toContain("-100777");
  });

  test("no bot token: refuses and sends nothing", async () => {
    const f = envFile("TELEGRAM_OPS_CHAT_ID=-100111\n");
    const { calls, impl } = recorder();
    await expect(sendTelegram(f, "x", impl)).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(calls.length).toBe(0);
  });
});

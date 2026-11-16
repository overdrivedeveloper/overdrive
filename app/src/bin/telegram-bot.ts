// Team Telegram bot entry point: long-polls getUpdates and answers read-only commands in the ops chat. It holds no chain key
// and no database access; it reads the local API only. Reads the root env file named by TELEGRAM_ENV_FILE.
import { createBot, loadBotSettings, NotConfigured } from "../crank/telegram-commands";
import { createLogger } from "../log";

const logger = createLogger("info", "telegram-bot");
let bot;
try { bot = createBot(loadBotSettings(process.env.TELEGRAM_ENV_FILE ?? "", process.env)); } catch (error) {
  // Not configured is a clean stop (exit 0, no restart loop); anything else is a real fault.
  if (error instanceof NotConfigured) { logger.warn(error.message); process.exit(0); }
  throw error;
}
logger.info("telegram bot started");
let stop = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stop = true; });
while (!stop) {
  try { await bot.pollOnce(); } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message.slice(0, 120) : "error" }, "poll failed");
    await new Promise((r) => setTimeout(r, 5000));
  }
}

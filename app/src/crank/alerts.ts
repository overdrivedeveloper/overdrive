// One alert path for every job. The Telegram sender (todo 14b) registers itself with setAlertSender(); until then an alert is
// logged and recorded in service_status.meta.alerts, which the status page reads. The same key is not repeated inside `quietMs`.
import type { CrankContext } from "./context";
import { saveJobMeta } from "./context";

export type AlertLevel = "warn" | "critical";
export interface Alert { key: string; level: AlertLevel; text: string; meta?: Record<string, unknown> }
export type AlertSender = (alert: Alert) => Promise<void>;

let sender: AlertSender | undefined;
const lastSent = new Map<string, number>();
export const setAlertSender = (next: AlertSender | undefined): void => { sender = next; };
export const resetAlertMemory = (): void => lastSent.clear();

/** Returns true when the alert was raised, false when the same key is still inside its quiet period. */
export async function raiseAlert(
  context: Pick<CrankContext, "logger" | "sql">, alert: Alert, options: { quietMs?: number; now?: number } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const quiet = options.quietMs ?? 3_600_000;
  const prior = lastSent.get(alert.key);
  if (prior !== undefined && now - prior < quiet) return false;
  lastSent.set(alert.key, now);
  const log = alert.level === "critical" ? context.logger.error.bind(context.logger) : context.logger.warn.bind(context.logger);
  log({ alert: alert.key, meta: alert.meta }, `ALERT ${alert.text}`);
  try { await saveJobMeta(context, "alerts", { [alert.key]: { at: new Date(now).toISOString(), level: alert.level, text: alert.text } }); } catch { /* the log line carries it */ }
  try { await sender?.(alert); } catch (error) { context.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Alert sender failed"); }
  return true;
}

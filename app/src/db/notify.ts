import type { Sql } from "postgres";

export const OD_EVENTS_CHANNEL = "od_events";

export type OdEventKind = "trade" | "oracle" | "snapshot" | "liquidation" | "config";

/** Payload of NOTIFY od_events: `{ kinds: [...] }`, bigints as strings. */
export type OverdriveEventSummary = { kinds?: readonly OdEventKind[] } & Record<string, unknown>;
export type OverdriveEventHandler = (event: OverdriveEventSummary) => void | Promise<void>;

export async function notifyOverdriveEvents(
  sql: Sql,
  event: OverdriveEventSummary,
): Promise<void> {
  const payload = JSON.stringify(event, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  await sql.notify(OD_EVENTS_CHANNEL, payload);
}

export async function listenOverdriveEvents(
  sql: Sql,
  handler: OverdriveEventHandler,
): Promise<() => Promise<void>> {
  const subscription = await sql.listen(OD_EVENTS_CHANNEL, (payload) => {
    let event: unknown;
    try {
      event = JSON.parse(payload) as unknown;
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    void Promise.resolve(handler(event as OverdriveEventSummary)).catch(() => undefined);
  });
  return async () => {
    await subscription.unlisten();
  };
}

// Pyth Hermes client: one GET for the latest signed price updates of a set of ids. Keyed (the key goes in a header, never in
// the URL or a log line). The response `binary.data` entries are hex without 0x; `parsed` carries each feed's publish time.
import type { Hex } from "viem";

export interface HermesUpdate {
  /** The signed update blobs to hand to Pyth.updatePriceFeeds, 0x-prefixed. */
  updateData: Hex[];
  /** Publish time (unix seconds) per price id, lowercase 0x-prefixed. Ids Hermes did not know are absent. */
  publishTimes: Map<string, number>;
}

export interface HermesOptions {
  baseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HermesError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "HermesError";
  }
}

const hex = (id: string): string => (id.startsWith("0x") ? id : `0x${id}`).toLowerCase();

/** "Authorization" takes a Bearer token (Pyth Terminal keys); any other header carries the raw key. */
export function authHeaderValue(header: string, key: string): string {
  return header.toLowerCase() === "authorization" && !/^bearer\s/i.test(key) ? `Bearer ${key}` : key;
}

export async function fetchLatestUpdates(ids: readonly string[], options: HermesOptions): Promise<HermesUpdate> {
  const query = [...ids.map((id) => `ids[]=${hex(id)}`), "encoding=hex", "parsed=true", "ignore_invalid_price_ids=true"].join("&");
  const url = `${options.baseUrl.replace(/\/+$/, "")}/v2/updates/price/latest?${query}`;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "overdrive-crank" };
  if (options.apiKey) headers[options.apiKeyHeader] = authHeaderValue(options.apiKeyHeader, options.apiKey);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 8000) });
  } catch (error) {
    throw new HermesError(`Hermes request failed: ${error instanceof Error ? error.name : "error"}`);
  }
  if (!response.ok) throw new HermesError(`Hermes answered ${response.status}`, response.status);
  const body = (await response.json().catch(() => undefined)) as { binary?: { data?: unknown }; parsed?: unknown } | undefined;
  const data = body?.binary?.data;
  if (!Array.isArray(data) || !data.every((d) => typeof d === "string" && /^(0x)?[0-9a-fA-F]+$/.test(d))) throw new HermesError("Hermes answer has no update data");
  const publishTimes = new Map<string, number>();
  if (Array.isArray(body?.parsed)) {
    for (const row of body.parsed as { id?: unknown; price?: { publish_time?: unknown } }[]) {
      const time = Number(row?.price?.publish_time);
      if (typeof row?.id === "string" && Number.isFinite(time)) publishTimes.set(hex(row.id), time);
    }
  }
  return { updateData: data.map((d) => hex(d as string) as Hex), publishTimes };
}

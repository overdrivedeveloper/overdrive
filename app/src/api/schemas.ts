import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ERROR_CODES } from "./quote/model";
import type { Freshness } from "../db/queries/status";

export { z };
export const Amount = z.string().regex(/^-?\d+$/).openapi({ description: "Integer in raw units (see `decimals`)." });
export const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const Iso = z.string().openapi({ description: "ISO 8601 time." });

export const Decimals = z.object({ usdg: z.literal(6), token: z.literal(18), value: z.literal(18) }).openapi({ description: "Decimals of raw amounts: USDG 6, gear tokens 18, WAD values 18." });
export const MetaFields = { asOfBlock: z.string(), asOf: Iso, stale: z.boolean(), decimals: Decimals };
export const ErrorBody = z.object({ error: z.enum(ERROR_CODES), message: z.string(), reason: z.string().optional() }).openapi("Error");

export function metaOf(f: Pick<Freshness, "asOfBlock" | "asOf" | "stale">, overrides: { asOfBlock?: string; asOf?: string; stale?: boolean } = {}) {
  return { asOfBlock: overrides.asOfBlock ?? f.asOfBlock, asOf: overrides.asOf ?? f.asOf, stale: overrides.stale ?? f.stale, decimals: { usdg: 6 as const, token: 18 as const, value: 18 as const } };
}

export const RANGES = { "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 } as const;
export const RangeQuery = z.object({ range: z.enum(["1d", "7d", "30d", "90d"]).default("7d").openapi({ description: "Window ending now." }) });

export const bad = (context: Context, message: string) => context.json({ error: "BAD_REQUEST" as const, message }, 400);
export const notFound = (context: Context, message: string) => context.json({ error: "NOT_FOUND" as const, message }, 404);

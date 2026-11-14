import type { Logger } from "pino";
import type { Sql } from "postgres";
import type { RuntimeConfig } from "../config";
import type { Deployment } from "../lib/deployments";
import type { TtlCache } from "./cache";
import type { ApiChain } from "./chain-reads";

export interface ApiDependencies {
  readonly sql: Sql;
  readonly config: RuntimeConfig;
  readonly deployment: Deployment;
  readonly logger: Logger;
  readonly cache: TtlCache;
  /** Every chain read the API makes. List and history routes never touch it (no-rpc rule); quote, governor, exit and backer routes do. */
  readonly chain: ApiChain;
  /** Wall clock; tests pin it. */
  readonly now?: () => Date;
}

export type DbRow = Record<string, unknown>;

export function asRows<T extends DbRow>(value: unknown): T[] {
  return value as T[];
}
export function textValue(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}
export function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
export function dateValue(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
export function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}
export const nowOf = (deps: Pick<ApiDependencies, "now">): Date => (deps.now ? deps.now() : new Date());

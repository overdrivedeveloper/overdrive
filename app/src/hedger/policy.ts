// Policy helpers that are not band maths: idempotent client ids (R10) and the halt after a refusal.
import { keccak256, stringToHex } from "viem";
import { revertNameOf } from "../chain/revert";

/**
 * R10: client_id = hash(underlying, cycle bucket, target position, venue, leg). The same intent in the same bucket always
 * maps to the same id, so a retry or a restart asks the venue about that id instead of sending a second order.
 */
export function hedgeClientId(underlying: string, bucket: number, targetUsd: bigint, venue: string, leg: number): string {
  return keccak256(stringToHex(`od-hedge|${underlying}|${bucket}|${targetUsd.toString()}|${venue}|${leg}`)).slice(0, 34);
}

/** The cycle bucket a timestamp falls in. */
export const cycleBucket = (nowMs: number, cycleSeconds: number): number => Math.floor(nowMs / (cycleSeconds * 1000));

/** Venue or contract refusals that halt for an hour instead of retrying every cycle. */
export const REFUSALS = ["HedgerFrozen", "HedgeBounds", "HedgeJump", "StressBudget", "AccessControlUnauthorizedAccount"] as const;
export const HALT_MS = 3_600_000;

export function refusalOf(error: unknown): string | null {
  const named = revertNameOf(error);
  if (named && (REFUSALS as readonly string[]).includes(named)) return named;
  const message = error instanceof Error ? error.message : String(error);
  return REFUSALS.find((name) => new RegExp(`\\b${name}\\b`).test(message)) ?? null;
}

export const isTimeout = (error: unknown): boolean => /time(d)? ?out|ETIMEDOUT|aborted/i.test(error instanceof Error ? error.message : String(error));

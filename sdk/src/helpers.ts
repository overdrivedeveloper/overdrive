import { OverdriveIntentMismatch } from "./errors.js";
import { deploymentFor, type DeploymentAddresses } from "./deployments.generated.js";
import type { QuoteResponse } from "./client.js";

/** Decimals the API reports: USDG 6, gear tokens and WAD values 18. */
export const USDG_DECIMALS = 6;
export const TOKEN_DECIMALS = 18;

/** "25.5" at 6 decimals -> 25500000n. Throws on a malformed or over-precise amount; never rounds. */
export function parseUnits(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) throw new TypeError(`Not a plain decimal amount: ${value}`);
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new RangeError(`${value} has more than ${decimals} decimal places`);
  return BigInt(match[1]! + fraction.padEnd(decimals, "0"));
}

/** 25500000n at 6 decimals -> "25.5". Exact, no floating point. */
export function formatUnits(value: bigint | string, decimals: number): string {
  const raw = BigInt(value);
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** The smallest output you accept: `amount` less `slippageBps` (integer 0 to 10000), rounded down. */
export function minOutFor(amount: bigint | string, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new RangeError("slippageBps must be an integer from 0 to 10000");
  return (BigInt(amount) * BigInt(10_000 - slippageBps)) / 10_000n;
}

export type QuoteSummary =
  | { readonly buyable: true; readonly side: "buy" | "sell"; readonly amountIn: bigint; readonly amountOut: bigint; readonly minOutSuggested: bigint | null; readonly tollPerDayBps: bigint | null; readonly breakevenDays: number | null; readonly expiresAt: string; readonly stale: boolean }
  | { readonly buyable: false; readonly reason: string; readonly code: string | null; readonly sellMode: QuoteResponse["sellMode"]; readonly stale: boolean };

/** Reduce a quote to BigInt amounts, or to the reason it cannot run now. A quote that is not buyable never carries amounts here. */
export function summarizeQuote(q: QuoteResponse): QuoteSummary {
  if (!q.buyable || q.amountIn === null || q.amountOut === null) {
    return { buyable: false, reason: q.reason ?? q.message ?? "not executable now", code: q.code, sellMode: q.sellMode, stale: q.stale };
  }
  return {
    buyable: true, side: q.side, amountIn: BigInt(q.amountIn), amountOut: BigInt(q.amountOut),
    minOutSuggested: q.minOutSuggested === null ? null : BigInt(q.minOutSuggested),
    tollPerDayBps: q.tollPerDayBps === null ? null : BigInt(q.tollPerDayBps),
    breakevenDays: q.breakevenDays, expiresAt: q.expiresAt, stale: q.stale,
  };
}

/** True when the quote's expiry has passed at `now` (default the current time). Sign nothing from an expired quote. */
export function quoteExpired(q: Pick<QuoteResponse, "expiresAt">, now: Date = new Date()): boolean {
  return Date.parse(q.expiresAt) <= now.getTime();
}

const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const lower = (v: string) => v.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

/** Addresses an intent may call: the deployment's own contracts. Empty entries and the zero address never count. */
export function allowedTargets(d: DeploymentAddresses): Set<string> {
  return new Set(Object.values(d.contracts).filter((a) => isAddress(a) && lower(a) !== ZERO).map(lower));
}

/** Addresses an approval may name as spender: the deployment's contracts plus Permit2. */
export function allowedSpenders(d: DeploymentAddresses): Set<string> {
  const set = allowedTargets(d);
  const permit2 = d.external.permit2;
  if (isAddress(permit2)) set.add(lower(permit2));
  return set;
}

/** Tokens an approval may cover: USDG and the deployment's gear tokens. */
export function allowedApprovalTokens(d: DeploymentAddresses): Set<string> {
  const set = new Set<string>();
  const usdg = d.external.usdg;
  if (isAddress(usdg)) set.add(lower(usdg));
  for (const g of d.gears) if (isAddress(g.token)) set.add(lower(g.token));
  return set;
}

export interface IntentLike { readonly tx?: { readonly to?: string; readonly value?: string }; readonly approvals?: ReadonlyArray<{ readonly token?: string; readonly spender?: string }> }

/**
 * Offline check of an intent against the committed deployment file for `chainId`. Throws `OverdriveIntentMismatch`
 * (nothing was signed) when the target, any spender or any approved token is not in that file, when the file has no
 * contract addresses yet, or when the transaction carries value. Fails closed: an unknown chain is a mismatch too.
 */
export function verifyIntent(intent: IntentLike, chain: number | DeploymentAddresses): void {
  const d = typeof chain === "number" ? deploymentFor(chain) : chain;
  const chainId = typeof chain === "number" ? chain : chain.chainId;
  if (!d) throw new OverdriveIntentMismatch(`No committed deployment for chain ${chainId}. Do not sign.`, "chainId", String(chainId));
  const targets = allowedTargets(d);
  if (targets.size === 0) throw new OverdriveIntentMismatch(`The committed deployment for chain ${chainId} has no contract addresses yet. Do not sign.`, "deployment", String(chainId));
  const bad = (field: string, address: unknown) => { throw new OverdriveIntentMismatch(`Intent ${field} ${String(address)} is not in the committed deployment for chain ${chainId}. Do not sign it.`, field, String(address)); };
  if (!isAddress(intent.tx?.to) || !targets.has(lower(intent.tx!.to!))) bad("tx.to", intent.tx?.to);
  if (intent.tx?.value !== undefined && intent.tx.value !== "0") bad("tx.value", intent.tx.value);
  const spenders = allowedSpenders(d);
  const tokens = allowedApprovalTokens(d);
  for (const [i, a] of (intent.approvals ?? []).entries()) {
    if (!isAddress(a.spender) || !spenders.has(lower(a.spender))) bad(`approvals[${i}].spender`, a.spender);
    if (!isAddress(a.token) || !tokens.has(lower(a.token))) bad(`approvals[${i}].token`, a.token);
  }
}

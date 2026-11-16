// Holder tiers and perks (todo 37). Pure: no I/O. Off-chain only: perks never touch toll maths or any contract. The fee discount
// is the one ODStake already pays on chain; this file does not duplicate it. Words: "hold X $OVRD to unlock"; utility only.
export type Tier = "none" | "holder" | "whale";
export const PERKS = ["analytics", "alerts", "agent_tools", "early_access"] as const;
export type Perk = (typeof PERKS)[number];
/** Perks per tier. Core (trading, deposits, exit, safety pages, public pages) is never gated and is not listed here. */
export const TIER_PERKS: Readonly<Record<Tier, readonly Perk[]>> = Object.freeze({
  none: [],
  holder: ["analytics", "alerts"],
  whale: ["analytics", "alerts", "agent_tools", "early_access"],
});
export interface TierThresholds { holderMin: bigint; whaleMin: bigint } // whole tokens

export function thresholdsOf(config: { HOLDER_TIER_HOLDER_MIN: number; HOLDER_TIER_WHALE_MIN: number }): TierThresholds {
  const t = { holderMin: BigInt(config.HOLDER_TIER_HOLDER_MIN), whaleMin: BigInt(config.HOLDER_TIER_WHALE_MIN) };
  if (t.whaleMin < t.holderMin) throw new Error("HOLDER_TIER_WHALE_MIN must not be below HOLDER_TIER_HOLDER_MIN");
  return t;
}

/** Tier from a raw balance and the token's decimals; the boundary is inclusive (exactly 100,000 is a Holder). */
export function tierOf(balanceRaw: bigint, decimals: number, t: TierThresholds): Tier {
  const unit = 10n ** BigInt(decimals);
  if (balanceRaw >= t.whaleMin * unit) return "whale";
  if (balanceRaw >= t.holderMin * unit) return "holder";
  return "none";
}
export const hasPerk = (tier: Tier, perk: Perk): boolean => TIER_PERKS[tier].includes(perk);

/** Whole tokens still missing for the next tier (rounded up); null at the top tier. */
export function missingForNext(balanceRaw: bigint, decimals: number, t: TierThresholds): { next: Exclude<Tier, "none">; missingTokens: string } | null {
  const unit = 10n ** BigInt(decimals);
  const tier = tierOf(balanceRaw, decimals, t);
  if (tier === "whale") return null;
  const next = tier === "none" ? "holder" : "whale";
  const need = (next === "holder" ? t.holderMin : t.whaleMin) * unit - balanceRaw;
  return { next, missingTokens: ((need + unit - 1n) / unit).toString() };
}

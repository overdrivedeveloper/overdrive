// Hedger types. Units: chain values are WAD (1e18) USD; venue notionals and every hedger amount are raw USDG (6 dp),
// converted once through lib/fixed.ts. Signs: a positive delta means holders are net long the underlying, so the Governor
// must hold that much long on venues.
import type { Hex } from "viem";

export type { Hex };

/** The Governor's exposure for one market as read on chain (`IODGovernor.exposure`) or rebuilt from the indexed ledger. */
export interface Exposure {
  market: Hex;
  symbol: string;
  deltaUsdWad: bigint;
  gammaUsdWad: bigint;
  openValueWad: bigint;
  equityWad: bigint;
  asOfBlock: bigint;
  source: "chain" | "indexed";
}

/** filledUsd is signed like the request (positive = bought). avgPx is WAD USD per unit. */
export interface VenueFill { ref: string; filledUsd: bigint; avgPx: bigint; feesUsd: bigint }

export type VenueName = "arcus" | "hyperliquid" | "mock";

export interface IHedgeVenue {
  readonly name: VenueName;
  /** The venue lists a market for this underlying and that market is open right now (24/7 vs session). */
  canTrade(underlying: string): boolean;
  /** Signed notional at mark, raw USDG. */
  netPositionUsd(underlying: string): Promise<bigint>;
  marginEquityUsd(): Promise<bigint>;
  /** px is WAD USD; ageMs is how old the venue's own mark is. */
  markPrice(underlying: string): Promise<{ px: bigint; ageMs: number }>;
  /** Visible depth on that side in raw USDG (a floor: a 20-level book). The service never takes more than its book share. */
  maxTradeUsd(underlying: string, side: "buy" | "sell"): Promise<bigint>;
  trade(underlying: string, deltaUsd: bigint, opts: { maxSlippageBps: number; clientId: string }): Promise<VenueFill>;
  /** R10: whether an order with this client id already filled (asked before any retry). null = never seen. */
  fillByClientId(underlying: string, clientId: string): Promise<VenueFill | null>;
  healthy(): Promise<{ ok: boolean; reason?: string }>;
  /** false when the venue's equity is already on chain (Arcus). */
  readonly postsEquity: boolean;
  /** true when the hedger may top up margin on this venue from its own wallet (same chain). Hyperliquid: false. */
  readonly fundable: boolean;
  readonly basis: (underlying: string) => { proxy: boolean; note?: string };
}

/** One gear's holder book in human units (pure netting maths). value = Governor-backed value in USD. */
export interface GearBook {
  gear: string;
  power: number;
  marketA: string;
  marketB: string | null;
  valueUsd: number;
}

export interface UnderlyingExposure {
  underlying: string;
  deltaUsd: number;
  gammaUsd: number;
  /** Pair cross terms (-p^2 V) touching this underlying, by the other leg. Reported, never netted across names. */
  cross: Record<string, number>;
  byGear: Record<string, { delta: number; gamma: number }>;
}

export interface HedgerSettings {
  dryRun: boolean;
  bandBps: number;
  hardBandBps: number;
  intervalSeconds: number;
  cooldownSeconds: number;
  /** raw USDG */
  minTradeUsd: bigint;
  maxSlippageBps: number;
  maxBookShareBps: number;
  cycleSeconds: number;
  equityIntervalSeconds: number;
  gammaBudgetBps: number;
  maxInputAgeSeconds: number;
  /** raw USDG cap on margin kept on one venue */
  maxVenueMarginUsd: bigint;
  /** margin a position needs, bps of its notional (2000 = 5x) */
  initialMarginBps: number;
  /** cap on the hedged share of an index-proxy position, bps of equity */
  proxyMaxBps: number;
  venueMarkMaxAgeMs: number;
  /** R3 tolerance: the larger of this share of equity and the floor below */
  disagreeBps: number;
  disagreeFloorUsd: bigint;
}

export type SignalKind = "gamma_over_budget" | "unhedged" | "venue_down" | "proxy_basis" | "disagree_with_chain" | "stale_inputs" | "hedge_post_missed";

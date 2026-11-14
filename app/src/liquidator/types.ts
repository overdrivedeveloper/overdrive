// Shared shapes of the liquidator (todo 17). Ids follow the todo 13 conventions: gear and market ids are bytes32 hex, vault and
// batch ids are uint256 (bigint here, decimal strings in the database). USDG amounts are raw 6 dp, values WAD.
import type { Address, Hex } from "viem";

export interface VaultView { vaultId: bigint; gearId: Hex; owner: Address; collateralUsdg: bigint; debtTokens: bigint; batchId: bigint }
export interface HealthView { collateralUsdg: bigint; debtValueWad: bigint; ratioBps: bigint; requiredBps: bigint; maintenanceBps: bigint }

/** An indexed backer_vaults row: a hint only, never a reason to send (R3). */
export interface Candidate { vaultId: bigint; gearId: Hex; owner: string; collateralUsdg: bigint; debtTokens: bigint; healthHint: bigint | null; indexAgeS: number | null; marketA?: Hex; marketB?: Hex }

/** The oracle guard's PriceReading, as read on chain. */
export interface PriceReading { p: bigint; refP: bigint; session: number; fresh: boolean; buysPaused: boolean; reason: Hex; updatedAt: bigint }

export type Verdict =
  | "liquidatable"
  | "recovered"
  | "in_batch"
  | "no_debt"
  | "gear_mismatch"
  | "read_failed"
  | "malformed"
  | "stale"
  | "halted"
  | "split_pending"
  | "continuity"
  | "no_reference"
  | "ref_band"
  | "uplift_unreadable"
  | "uneconomic"
  | "dropped_by_chain";

/** One candidate after the chain re-read. Only `liquidatable` may enter a batch. */
export interface Verified {
  vaultId: bigint;
  gearId: Hex;
  verdict: Verdict;
  reason?: string;
  vault?: VaultView;
  health?: HealthView;
  markets?: Hex[];
  closedMarket?: boolean;
}

export interface BatchPlan { gearId: Hex; vaultIds: bigint[]; expectedBonusUsdg: bigint; gasEstimate: bigint }

/** A batch sealed on chain and not yet liquidated or voided (rebuilt from events on start, R7). */
export interface OpenBatch {
  batchId: bigint;
  gearId: Hex;
  vaultIds: bigint[];
  sealedAt: bigint;
  sealedBlock: bigint;
  readyAt?: bigint;
  runId?: bigint;
  mine: boolean;
}

export interface LiquidatedEvent { batchId: bigint; vaultId: bigint; debtTokens: bigint; collateralSeized: bigint; bonusUsdg: bigint; badDebtUsdg: bigint }

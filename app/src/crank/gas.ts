/** Accrual batch sizing from measured gas. IODMinter.accrueMany costs roughly a fixed amount plus a per-gear amount; the
 * tuner learns the per-gear amount from real receipts (gas used divided by gears accrued) and picks the largest batch
 * that stays under a gas target well inside the block gas limit. */

/** Transaction base cost plus the single risk recheck at the end of accrueMany, measured as a rounded allowance. */
export const FIXED_GAS = 60_000;
/** Weight of the newest observation in the running per-gear figure. */
const ALPHA = 0.3;
/** Headroom on top of the measured per-gear cost: gears differ, so a batch of the dearest ones must still fit. */
const MARGIN = 1.3;
/** A batch may grow by at most this factor per run, so one lucky cheap sample cannot jump it to the cap. */
const MAX_GROWTH = 2;
/** The target never exceeds this share of the chain's block gas limit. */
export const BLOCK_SHARE = 0.4;
/** a refusal never drives the tuned batch below this (the per-run halving retries still split a batch
 * that really does not fit), and no per-gear figure, measured or penalised, may imply fewer gears than this. */
export const BATCH_FLOOR = 10;
/** Penalties apply only to batches at least this big: a refusal of a tiny batch says nothing about per-gear gas. */
export const PENALTY_MIN_COUNT = 4;

export interface GasTunerOptions {
  /** Batch used until the first measurement exists. */
  initialBatch: number;
  minBatch?: number;
  maxBatch: number;
  /** Gas the crank aims to use per accrual transaction. */
  gasTarget: number;
}

export interface GasTunerSnapshot {
  /** Running per-gear gas (string so JSON in service_status keeps it exact). */
  perGearGas: string | null;
  samples: number;
  lastBatch: number;
  highestPerGearGas: string | null;
}

export interface BatchChoice {
  batch: number;
  /** Where the number came from: "seed" (nothing measured yet), "measured", or "capped" (block limit or growth cap won). */
  basis: "seed" | "measured" | "capped";
  perGearGas: number | null;
  targetGas: number;
}

export function createGasTuner(options: GasTunerOptions) {
  const minBatch = options.minBatch ?? 1;
  let perGear: number | null = null;
  let highest: number | null = null;
  let samples = 0;
  let lastBatch = Math.min(options.maxBatch, Math.max(minBatch, options.initialBatch));
  const floor = Math.min(options.maxBatch, Math.max(minBatch, BATCH_FLOOR));
  /** Highest per-gear figure allowed: the target must still hold BATCH_FLOOR gears with the margin. */
  const capPer = Math.max(1, (options.gasTarget - FIXED_GAS) / (BATCH_FLOOR * MARGIN));
  /** Penalty from refused batches: in memory only (never persisted), halves with every successful transaction. */
  let penaltyPer: number | null = null;
  /** The batch to persist: the one before any penalty, so a restart never inherits one. */
  let savedBatch: number | null = null;

  return {
    /** Record one successful transaction: `count` gears accrued for `gasUsed` gas. */
    observe(count: number, gasUsed: bigint | number): void {
      const gas = Number(gasUsed);
      if (!(count > 0) || !Number.isFinite(gas) || gas <= FIXED_GAS) return;
      const cost = (gas - FIXED_GAS) / count;
      perGear = perGear === null ? cost : perGear * (1 - ALPHA) + cost * ALPHA;
      highest = Math.min(capPer, highest === null ? cost : Math.max(highest * 0.98, cost));
      samples += 1;
      if (penaltyPer !== null) {
        penaltyPer /= 2;
        if (penaltyPer <= (perGear ?? 0)) { penaltyPer = null; savedBatch = null; }
      }
    },
    /** A batch was refused for gas reasons (does not fit the block, out of gas): forget the optimism. */
    penalize(count: number): void {
      // L1: only real batches, at most halving, never below BATCH_FLOOR, never persisted.
      if (!(count >= PENALTY_MIN_COUNT)) return;
      const implied = Math.min(capPer, (options.gasTarget - FIXED_GAS) / (count - 1) * 1.05);
      penaltyPer = Math.max(penaltyPer ?? 0, implied);
      if (savedBatch === null) savedBatch = lastBatch;
      lastBatch = Math.max(floor, Math.ceil(lastBatch / 2), Math.min(lastBatch, count - 1));
    },
    choose(blockGasLimit?: bigint | number): BatchChoice {
      const blockCap = blockGasLimit === undefined ? Infinity : Number(blockGasLimit) * BLOCK_SHARE;
      const targetGas = Math.max(FIXED_GAS * 2, Math.min(options.gasTarget, blockCap));
      if (perGear === null && penaltyPer !== null) {
        const fit = Math.floor((targetGas - FIXED_GAS) / (penaltyPer * MARGIN));
        const batch = Math.max(minBatch, Math.min(options.maxBatch, lastBatch, Math.max(fit, floor)));
        lastBatch = batch;
        return { batch, basis: "capped", perGearGas: null, targetGas };
      }
      if (perGear === null) {
        // Nothing measured: stay at the seed, but never above what the target can hold at a pessimistic guess.
        return { batch: lastBatch, basis: "seed", perGearGas: null, targetGas };
      }
      const costPer = Math.max(perGear, (highest ?? perGear) * 0.9, penaltyPer ?? 0) * MARGIN;
      const fit = Math.floor((targetGas - FIXED_GAS) / costPer);
      const grown = Math.floor(lastBatch * MAX_GROWTH);
      const batch = Math.max(minBatch, Math.min(options.maxBatch, Math.max(fit, floor), Math.max(grown, floor)));
      lastBatch = batch;
      return {
        batch,
        basis: batch === fit ? "measured" : "capped",
        perGearGas: Math.round(perGear),
        targetGas: Math.round(targetGas),
      };
    },
    snapshot(): GasTunerSnapshot {
      return {
        perGearGas: perGear === null ? null : String(Math.round(perGear)),
        samples,
        lastBatch: savedBatch ?? lastBatch,
        highestPerGearGas: highest === null ? null : String(Math.round(highest)),
      };
    },
    restore(snapshot: Partial<GasTunerSnapshot> | undefined): void {
      if (!snapshot) return;
      const per = Number(snapshot.perGearGas);
      if (Number.isFinite(per) && per > 0) perGear = per;
      const high = Number(snapshot.highestPerGearGas);
      if (Number.isFinite(high) && high > 0) highest = Math.min(capPer, high);
      if (Number.isInteger(snapshot.samples) && snapshot.samples! > 0) samples = snapshot.samples!;
      if (Number.isInteger(snapshot.lastBatch) && snapshot.lastBatch! >= minBatch) lastBatch = Math.min(options.maxBatch, snapshot.lastBatch!);
    },
  };
}

export type GasTuner = ReturnType<typeof createGasTuner>;

// ------------------------------------------------------------------------------------------------ gas limit policy (R4)
/** The estimate is taken against the latest block, but the transaction runs in a later block with a later timestamp. After a
 * time jump (a weekend, a stalled crank, a fork warp) `accrue` does more work than in the estimated block, so the limit is
 * the larger of estimate x multiplier and estimate + headroom, capped (unused gas is refunded), and never under estimate x 1.2. */
export interface GasLimitPolicy { multiplierBps: number; headroom: bigint; cap: bigint }
export const DEFAULT_GAS_LIMIT_POLICY: GasLimitPolicy = { multiplierBps: 15_000, headroom: 500_000n, cap: 32_000_000n };

export function crankGasLimit(estimate: bigint, policy: GasLimitPolicy = DEFAULT_GAS_LIMIT_POLICY): bigint {
  const floor = (estimate * 120n + 99n) / 100n;
  const scaled = (estimate * BigInt(policy.multiplierBps) + 9_999n) / 10_000n;
  const padded = estimate + policy.headroom;
  let limit = scaled > padded ? scaled : padded;
  if (limit > policy.cap) limit = policy.cap;
  return limit > floor ? limit : floor;
}

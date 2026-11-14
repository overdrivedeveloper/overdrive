// R5 to R7: the toll job. IODMinter.accrueMany for every gear with supply whose last accrual is older than
// CRANK_TOLL_MAX_AGE_SECONDS, plus every session-bound gear within 30 s either side of a session open or close.
import { encodeFunctionData, type Hex } from "viem";
import { IODMinterAbi } from "../../abi";
import { revertNameOf } from "../../chain/revert";
import { safeErrorSummary } from "../../log";
import { readJobMeta, saveJobMeta, type CrankContext } from "../context";
import { createGasTuner, type BatchChoice, type GasTuner } from "../gas";
import { contractAddress, createGearReader, isSessionGear, type ChainGear } from "../gears";
import { computeSessions } from "../sessions";
import { HELD_QUEUE } from "../tx";

/** A gear seen with no supply is trusted to be empty for this long while its last accrual is unchanged. */
export const EMPTY_RECHECK_MS = 30 * 60_000;
/** Seconds either side of a session open or close that force an accrual of every session-bound gear. */
export const BOUNDARY_WINDOW_SECONDS = 30n;
/** At a boundary a gear is accrued if anything at all (this much) has elapsed since its last accrual. */
const BOUNDARY_MIN_ELAPSED_SECONDS = 1n;
/** Hard ceiling of gears per accrueMany transaction (about half a block). */
export const TOLL_BATCH_MAX = 45;
const batchSize = (configured: number): number => Math.max(1, Math.min(TOLL_BATCH_MAX, Math.floor(configured) || TOLL_BATCH_MAX));

/** Remembers which aged gears were found empty, keyed by the `lastAccrual` they had: every mint goes through the minter's
 * accrual, which moves `lastAccrual`, so an empty gear whose `lastAccrual` has not moved has not been bought. */
export function createEmptyGearMemory(now: () => number = Date.now) {
  const seen = new Map<Hex, { lastAccrual: bigint; at: number }>();
  return {
    isKnownEmpty(gear: Pick<ChainGear, "id" | "lastAccrual">): boolean {
      const entry = seen.get(gear.id);
      return entry !== undefined && entry.lastAccrual === gear.lastAccrual && now() - entry.at < EMPTY_RECHECK_MS;
    },
    markEmpty(gear: Pick<ChainGear, "id" | "lastAccrual">): void { seen.set(gear.id, { lastAccrual: gear.lastAccrual, at: now() }); },
    forget(id: Hex): void { seen.delete(id); },
    size: () => seen.size,
  };
}
export type EmptyGearMemory = ReturnType<typeof createEmptyGearMemory>;

/** Splits `ids` into IODMinter.accrueMany transactions sized by the tuner (never over 45). A transaction that fails (one gear
 * that reverts, or a batch that does not fit the gas limit) is halved and retried, so one bad gear cannot stop the others,
 * and nothing is dropped: a single gear that still fails is returned in `failed` with the decoded revert name. */
export async function accrueInBatches(
  context: Pick<CrankContext, "tx" | "deployment" | "logger"> & Partial<Pick<CrankContext, "clients">>,
  ids: readonly Hex[], size: number, tuner?: GasTuner,
) {
  const minter = contractAddress(context, "ODMinter");
  const accrued: Hex[] = [];
  const failed: { id: Hex; error: string; revert?: string | undefined }[] = [];
  const batches: number[] = [];
  let transactions = 0;
  let simulated = false;
  let gasUsed = 0n;
  let choice: BatchChoice | undefined;
  let blockGasLimit: bigint | undefined;
  size = batchSize(size);
  if (tuner && context.clients) {
    try { blockGasLimit = (await context.clients.stateClient.getBlock({ blockTag: "latest" })).gasLimit; } catch { /* the gas target alone bounds the batch */ }
  }
  const retry: Hex[][] = [];
  let cursor = 0;
  const next = (): Hex[] | undefined => {
    const halved = retry.shift();
    if (halved) return halved;
    if (cursor >= ids.length) return undefined;
    let take = size;
    if (tuner) { choice = tuner.choose(blockGasLimit); take = batchSize(Math.min(choice.batch, TOLL_BATCH_MAX)); }
    const batch = ids.slice(cursor, cursor + take) as Hex[];
    cursor += batch.length;
    return batch;
  };
  for (let batch = next(); batch; batch = next()) {
    try {
      const result = await context.tx.submit({
        label: "toll", to: minter, estimateAheadSeconds: 1,
        data: encodeFunctionData({ abi: IODMinterAbi, functionName: "accrueMany", args: [batch] }),
      });
      transactions++;
      batches.push(batch.length);
      simulated ||= result.simulated;
      if (result.gasUsed !== undefined) { gasUsed += result.gasUsed; tuner?.observe(batch.length, result.gasUsed); }
      accrued.push(...batch);
    } catch (error) {
      const summary = safeErrorSummary(error);
      // A held nonce or a missing signer is not the batch's fault: splitting would only repeat the failure.
      if (HELD_QUEUE.test(summary.message)) throw error;
      // A low balance answers "insufficient funds" for EVERY batch size; that says nothing about per-gear gas.
      const starved = /insufficient funds|exceeds allowance|allowance \(/i.test(summary.message);
      if (!starved && /out of gas|exceeds (the )?(block )?gas limit|gas required exceeds|intrinsic gas|gas limit/i.test(summary.message)) tuner?.penalize(batch.length);
      if (batch.length === 1) {
        failed.push({ id: batch[0]!, error: summary.message, revert: revertNameOf(error) });
        context.logger.warn({ id: batch[0], err: summary }, "Toll accrual of one gear failed; the others continue");
        continue;
      }
      const half = Math.ceil(batch.length / 2);
      retry.unshift(batch.slice(0, half), batch.slice(half));
    }
  }
  return { accrued, failed, transactions, simulated, batches, gasUsed, ...(choice ? { choice } : {}) };
}

/** True when `nowSeconds` is within BOUNDARY_WINDOW_SECONDS either side of any session open or close. */
export function nearBoundary(nowMs: number, window = BOUNDARY_WINDOW_SECONDS): boolean {
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  const sessions = computeSessions(new Date(nowMs - 120_000), "us_equity", 3);
  return sessions.some((s) => [s.open, s.close].some((edge) => edge >= nowSeconds - window && edge <= nowSeconds + window));
}

export function createTollJob(ctx: CrankContext) {
  const reader = createGearReader(ctx);
  let clockMs = 0;
  const empty = createEmptyGearMemory(() => clockMs);
  const tuner = createGasTuner({ initialBatch: batchSize(ctx.config.CRANK_TOLL_BATCH), maxBatch: batchSize(ctx.config.CRANK_TOLL_BATCH_MAX), gasTarget: ctx.config.CRANK_TOLL_GAS_TARGET, minBatch: 1 });
  let restored = false;
  async function restoreTuner(): Promise<void> {
    if (restored) return;
    restored = true;
    try { const meta = await readJobMeta(ctx, "toll"); if (meta.gas && typeof meta.gas === "object") tuner.restore(meta.gas as never); } catch { /* a fresh tuner starts from the configured batch */ }
  }
  return async (force = false): Promise<{ accrued: number; skipped: Record<string, number>; batches: number; [extra: string]: unknown }> => {
    const nowMs = ctx.now(await ctx.metadata()).getTime();
    clockMs = nowMs;
    const nowSeconds = BigInt(Math.floor(nowMs / 1000));
    const maxAge = BigInt(ctx.config.CRANK_TOLL_MAX_AGE_SECONDS);
    const boundary = force || nearBoundary(nowMs);
    const skipped: Record<string, number> = {};
    const skip = (reason: string, n = 1) => { skipped[reason] = (skipped[reason] ?? 0) + n; };

    const dueOf = (gear: Omit<ChainGear, "supply">): "stale" | "boundary" | undefined => {
      const age = nowSeconds - gear.lastAccrual;
      if (age > maxAge) return "stale";
      if (boundary && isSessionGear(ctx.deployment, gear) && age >= BOUNDARY_MIN_ELAPSED_SECONDS) return "boundary";
      return undefined;
    };
    // Supply is read only for gears that are due and not remembered as empty.
    const gears = await reader.readAll({ supplyFor: (gear) => gear.status !== 4 && dueOf(gear) !== undefined && !empty.isKnownEmpty(gear) });
    const ids: Hex[] = [];
    let boundaryForced = 0;
    for (const gear of gears) {
      if (gear.status === 4) { skip("settled"); continue; }
      const reason = dueOf(gear);
      if (!reason) { skip("not_due"); continue; }
      if (empty.isKnownEmpty(gear)) { skip("zero_supply"); continue; }
      if (gear.supply === 0n) { empty.markEmpty(gear); skip("zero_supply"); continue; }
      if (reason === "boundary") boundaryForced++;
      ids.push(gear.id);
    }
    const base = { gears: gears.length, due: ids.length, boundaryForced, forced: force, boundary };
    if (!ids.length) return { ...base, accrued: 0, skipped, batches: 0, idle: true };

    await restoreTuner();
    const result = await accrueInBatches(ctx, ids, ctx.config.CRANK_TOLL_BATCH, tuner);
    for (const bad of result.failed) skip(`revert:${bad.revert ?? "unknown"}`);
    const gas = { ...tuner.snapshot(), lastBatches: result.batches, lastGasUsed: result.gasUsed.toString(), basis: result.choice?.basis ?? null };
    if (result.transactions) { try { await saveJobMeta(ctx, "toll", { gas }); } catch { /* the run result carries it too */ } }
    return {
      ...base, accrued: result.accrued.length, skipped, batches: result.transactions, failed: result.failed.map((f) => ({ id: f.id, revert: f.revert ?? null, error: f.error.slice(0, 200) })),
      dryRun: result.simulated, gas, lastAccruedAt: new Date(Number(nowSeconds) * 1000).toISOString(),
    };
  };
}


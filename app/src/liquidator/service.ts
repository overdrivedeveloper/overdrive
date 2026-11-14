// One liquidation pass: watch events -> execute open batches -> scan -> verify on chain -> economics -> seal -> record (R3 to R13).
// Both chain calls are permissionless; the service holds a gas-only key and cannot pause anything or touch a holder.
import { getAddress, type Address, type Hex } from "viem";
import type { Logger } from "pino";
import type { Sql } from "postgres";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";
import { RevertError, revertNameOf, decodeRevert } from "../chain/revert";
import { raiseAlert } from "../crank/alerts";
import { readIndexerMetadata } from "../crank/context";
import type { TxQueue, TxResult } from "../crank/tx";
import { closeRun, insertAttempts, insertRun, type AttemptRow } from "../db/queries/liquidations";
import { safeErrorSummary } from "../log";
import { usdgDecimal } from "../lib/fixed";
import { IODOracleGuardAbi } from "../abi";
import { assertLiquidatorCall, buildPlans, encodeExecute, encodeSeal, liquidatorAddresses, verifyOnChain, type LiquidatorAddresses } from "./batch";
import { decideEconomics, expectedBonusUsdg, gasCostUsdg } from "./economics";
import { scanWithReport } from "./scan";
import type { LiquidatorSettings } from "./settings";
import { decodeLiquidationLogs, syncOpenBatches, type Closure, LiquidatorState } from "./state";
import { reasonText } from "./policy";
import type { OpenBatch, Verified } from "./types";

export const LIQUIDATOR_STATUS_JOB = "liquidator";

export interface PassDeps {
  sql: Sql;
  clients: ServiceClients;
  deployment: Deployment;
  settings: LiquidatorSettings;
  tx: TxQueue;
  logger: Logger;
  state: LiquidatorState;
  /** The liquidator account (for gas estimates); undefined in a read-only dry run. */
  account?: Address;
  /** Waits inside a pass (tests warp the chain here). Default: a real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PassResult {
  dryRun: boolean;
  scanned: number;
  verdicts: Record<string, number>;
  liquidatable: number;
  uneconomic: string[];
  sealed?: string;
  simulatedSeal?: boolean;
  executed: string[];
  executedByOther: string[];
  voided: string[];
  openBatches: number;
  bonusUsdg: string;
  badDebtUsdg: string;
  indexAgeS: number | null;
  retryAfterMs?: number;
  skipped?: string;
}

interface Ctx extends PassDeps { addresses: LiquidatorAddresses; insurance?: Address; result: PassResult; chainNow: bigint }

const alertCtx = (d: PassDeps) => ({ logger: d.logger, sql: d.sql });

/** Sends one call after decoding it (R5): the target must be IODBacker and the function sealBatch or executeBatch. */
async function guardedSubmit(c: Ctx, data: Hex, label: string): Promise<TxResult> {
  assertLiquidatorCall(c.addresses.backer, data, c.addresses.backer);
  return c.tx.submit({ to: c.addresses.backer, data, label: `liquidator:${label}` });
}

async function chainNowOf(clients: ServiceClients): Promise<bigint> {
  return BigInt((await clients.stateClient.getBlock()).timestamp);
}

// -------------------------------------------------------------------------------------------------------- closures
async function recordClosure(c: Ctx, batch: Pick<OpenBatch, "batchId" | "gearId" | "vaultIds">, closure: Closure, byOther: boolean): Promise<void> {
  if (closure.kind === "voided") {
    await closeRun(c.sql, batch.batchId, batch.gearId, batch.vaultIds, { phase: "voided", error: `voided: ${reasonText(closure.reason as Hex) || closure.reason || "unknown"}`, ...(closure.txHash ? { executeTx: closure.txHash } : {}) });
    c.result.voided.push(batch.batchId.toString());
    return;
  }
  const bonus = closure.events.reduce((s, e) => s + e.bonusUsdg, 0n);
  const bad = closure.events.reduce((s, e) => s + e.badDebtUsdg, 0n);
  await closeRun(c.sql, batch.batchId, batch.gearId, batch.vaultIds, {
    phase: byOther ? "executed_by_other" : "executed", bonusUsdg: bonus, badDebtUsdg: bad,
    coveredUsdg: closure.coveredUsdg ?? null, ...(closure.txHash ? { executeTx: closure.txHash } : {}),
  });
  (byOther ? c.result.executedByOther : c.result.executed).push(batch.batchId.toString());
  if (!byOther) { c.state.lastBonusUsdg = bonus; c.result.bonusUsdg = (BigInt(c.result.bonusUsdg) + bonus).toString(); }
  c.result.badDebtUsdg = (BigInt(c.result.badDebtUsdg) + bad).toString();
  // R11: bad debt is only what the Liquidated events say; the insurance draw is only what Covered says.
  if (bad > 0n && (bad >= c.settings.badDebtAlertUsdg || closure.coveredUsdg === undefined || closure.coveredUsdg < bad)) {
    await raiseAlert(alertCtx(c), {
      key: `liquidator:bad-debt:${batch.batchId}`, level: bad >= c.settings.badDebtAlertUsdg ? "critical" : "warn",
      text: `Batch ${batch.batchId} left ${usdgDecimal(bad)} USDG bad debt; insurance covered ${closure.coveredUsdg === undefined ? "nothing confirmed on chain" : usdgDecimal(closure.coveredUsdg)}`,
      meta: { batchId: batch.batchId.toString(), badDebtUsdg: bad.toString(), coveredUsdg: closure.coveredUsdg?.toString() ?? null },
    });
  }
}

// --------------------------------------------------------------------------------------------------------- execute
/** Executes one open batch: waits for readiness inside the pass when it is close, else asks the scheduler to come back at readyAt. */
async function executeOne(c: Ctx, batch: OpenBatch): Promise<void> {
  const sleep = c.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: TxResult;
    try {
      res = await guardedSubmit(c, encodeExecute(batch.batchId), `execute:${batch.batchId}`);
    } catch (error) {
      const name = revertNameOf(error);
      if (name === "BatchNotReady") {
        const decoded = error instanceof RevertError ? error.args : decodeRevert(error)?.args ?? [];
        const readyAt = BigInt((decoded[0] as bigint | number | undefined) ?? c.chainNow + 1n);
        batch.readyAt = readyAt;
        const wait = readyAt > c.chainNow ? readyAt - c.chainNow : 1n;
        if (wait <= BigInt(c.settings.passSeconds) && attempt < 2) {
          await sleep(Number(wait) * 1000 + 250);
          c.chainNow = await chainNowOf(c.clients);
          continue;
        }
        const ms = Number(wait) * 1000;
        c.result.retryAfterMs = c.result.retryAfterMs === undefined ? ms : Math.min(c.result.retryAfterMs, ms);
        return;
      }
      if (name === "BatchExpired") {
        // R6: recorded with the reason; the vaults go back through the full chain verification, never a blind re-seal.
        c.state.open.delete(batch.batchId);
        await closeRun(c.sql, batch.batchId, batch.gearId, batch.vaultIds, { phase: "voided", error: "expired before execution" });
        c.result.voided.push(batch.batchId.toString());
        return;
      }
      // Anyone may execute: if the batch closed meanwhile, that is another liquidator's success, not an error (R7).
      const closures = await syncNow(c);
      if (!c.state.open.has(batch.batchId)) {
        const mine = closures.find((x) => x.batchId === batch.batchId);
        if (mine) await recordClosure(c, batch, mine, true);
        return;
      }
      c.logger.warn({ batchId: batch.batchId.toString(), err: safeErrorSummary(error) }, "executeBatch failed; will retry next pass");
      return;
    }
    if (res.simulated) {
      if (!c.state.simulated.has(batch.batchId)) {
        c.state.simulated.add(batch.batchId);
        await insertRun(c.sql, { batchId: batch.batchId, gear: batch.gearId, vaultIds: batch.vaultIds, phase: "simulated", error: "dry run: executeBatch simulated" });
      }
      return;
    }
    const d = decodeLiquidationLogs(res.receipt?.logs ?? [], c.addresses.backer, c.insurance);
    c.state.open.delete(batch.batchId);
    const voided = d.voided.find((v) => v.batchId === batch.batchId);
    const closure: Closure = voided
      ? { batchId: batch.batchId, kind: "voided", reason: voided.reason, events: [], ...(res.hash ? { txHash: res.hash } : {}) }
      : {
        batchId: batch.batchId, kind: "liquidated", events: d.liquidated.filter((l) => l.batchId === batch.batchId), ...(res.hash ? { txHash: res.hash } : {}),
        ...(d.covered.length ? { coveredUsdg: d.covered.reduce((s, x) => s + x.sent, 0n) } : {}),
      };
    await recordClosure(c, batch, closure, false);
    return;
  }
}

async function syncNow(c: Ctx): Promise<Closure[]> {
  const head = await c.clients.stateClient.getBlockNumber();
  return syncOpenBatches(c.clients, { backer: c.addresses.backer, ...(c.insurance ? { insurance: c.insurance } : {}) }, c.state,
    { startBlock: BigInt(c.deployment.startBlock), head, chunk: c.settings.logChunkBlocks });
}

// ------------------------------------------------------------------------------------------------------------ seal
async function ethPriceWad(c: Ctx): Promise<bigint | undefined> {
  const eth = c.deployment.markets.find((m) => m.symbol === "ETH");
  if (!eth) return undefined;
  try {
    const r = (await c.clients.stateClient.readContract({ address: c.addresses.oracleGuard, abi: IODOracleGuardAbi, functionName: "read", args: [eth.id] } as never)) as { p: bigint; fresh: boolean };
    return r.fresh && BigInt(r.p) > 0n ? BigInt(r.p) : undefined;
  } catch { return undefined; }
}

async function sealBest(c: Ctx, verified: Verified[], attempts: AttemptRow[]): Promise<void> {
  const block = await c.clients.stateClient.getBlock();
  const gasBudget = BigInt((block as { gasLimit?: bigint }).gasLimit ?? 30_000_000n) / 2n;
  const plans = buildPlans(verified, { maxVaults: c.settings.maxVaultsPerBatch, gasBudget });
  if (!plans.length) return;
  const byId = new Map(verified.map((v) => [v.vaultId, v]));
  const [gasPrice, ethPrice] = await Promise.all([c.clients.txClient.getGasPrice(), ethPriceWad(c)]);
  if (ethPrice === undefined) { c.result.skipped = "gas_unpriced: no fresh ETH price to cost gas"; return; }
  const nowS = Number(c.chainNow);
  for (const plan of plans) { // R10: at most one batch is sealed per pass; later plans only run if earlier ones were uneconomic
    let ids = [...plan.vaultIds];
    let sealGas: bigint | undefined;
    for (let tries = 0; tries < 4 && ids.length; tries++) {
      try {
        sealGas = await c.clients.txClient.estimateGas({ account: c.account, to: c.addresses.backer, data: encodeSeal(plan.gearId, ids) } as never);
        break;
      } catch (error) {
        const name = revertNameOf(error);
        const args = error instanceof RevertError ? error.args : decodeRevert(error)?.args ?? [];
        const bad = args[0] as bigint | undefined;
        if ((name === "Healthy" || name === "InBatch") && bad !== undefined && ids.includes(BigInt(bad))) {
          ids = ids.filter((x) => x !== BigInt(bad));
          attempts.push({ vaultId: BigInt(bad), gear: plan.gearId, verdict: "dropped_by_chain", reason: name });
          continue;
        }
        c.logger.warn({ gear: plan.gearId, err: safeErrorSummary(error) }, "sealBatch estimate failed");
        sealGas = undefined;
        break;
      }
    }
    if (sealGas === undefined || !ids.length) continue;
    // Execute gas is not known before the seal; it is taken equal to the seal estimate (both scale with the vault count).
    const gasEstimate = sealGas * 2n;
    const econ = decideEconomics({
      vaults: ids.map((id) => ({ vaultId: id, bonusUsdg: expectedBonusUsdg(byId.get(id)!.health!) })),
      gasEstimate, gasCostUsdg: gasCostUsdg(gasEstimate, BigInt(gasPrice), ethPrice), minBonusUsdg: c.settings.minBonusUsdg, gasMultipleBps: c.settings.gasMultipleBps,
    });
    for (const id of econ.uneconomic) {
      const v = byId.get(id)!;
      attempts.push({ vaultId: id, gear: plan.gearId, verdict: "uneconomic", ratioBps: v.health!.ratioBps, requiredBps: v.health!.maintenanceBps, reason: econ.reason ?? "bonus below its share of gas" });
      c.result.uneconomic.push(id.toString());
      const first = c.state.firstUneconomic.get(id) ?? nowS;
      c.state.firstUneconomic.set(id, first);
      const deep = v.health!.collateralUsdg * 10n ** 12n < v.health!.debtValueWad; // collateral below debt: a real shortfall
      if (deep && nowS - first >= c.settings.deepWaitAlertSeconds) {
        await raiseAlert(alertCtx(c), { key: `liquidator:deep-wait:${id}`, level: "critical", text: `Vault ${id} is under water and has waited ${nowS - first} s for gas to fall`, meta: { vaultId: id.toString() } });
      }
    }
    if (!econ.ok) continue;
    for (const id of econ.send) c.state.firstUneconomic.delete(id);
    const data = encodeSeal(plan.gearId, econ.send);
    let res: TxResult;
    try {
      res = await guardedSubmit(c, data, `seal:${plan.gearId.slice(0, 10)}`);
    } catch (error) {
      const name = revertNameOf(error);
      c.logger.warn({ gear: plan.gearId, err: safeErrorSummary(error) }, "sealBatch failed");
      await insertRun(c.sql, { gear: plan.gearId, vaultIds: econ.send, phase: "abandoned", error: name ? `reverted ${name}` : safeErrorSummary(error).message });
      return;
    }
    if (res.simulated) {
      await insertRun(c.sql, { gear: plan.gearId, vaultIds: econ.send, phase: "simulated", error: "dry run: sealBatch simulated" });
      c.result.simulatedSeal = true;
      return;
    }
    const d = decodeLiquidationLogs(res.receipt?.logs ?? [], c.addresses.backer);
    const sealed = d.sealed[0];
    if (!sealed) {
      await insertRun(c.sql, { gear: plan.gearId, vaultIds: econ.send, phase: "abandoned", sealTx: res.hash ?? null, error: "no BatchSealed event in the receipt" });
      return;
    }
    const runId = await insertRun(c.sql, { batchId: sealed.batchId, gear: sealed.gearId, vaultIds: sealed.vaultIds, phase: "sealed", sealTx: res.hash ?? null });
    const open: OpenBatch = { batchId: sealed.batchId, gearId: sealed.gearId, vaultIds: sealed.vaultIds, sealedAt: sealed.sealedAt, sealedBlock: sealed.block, runId, mine: true };
    c.state.open.set(sealed.batchId, open);
    c.result.sealed = sealed.batchId.toString();
    if (c.settings.jobs.has("execute")) await executeOne(c, open);
    return;
  }
}

// ------------------------------------------------------------------------------------------------------------ pass
export async function runLiquidationPass(deps: PassDeps): Promise<PassResult> {
  const addresses = liquidatorAddresses(deps.deployment.contracts);
  const insuranceRaw = deps.deployment.contracts.ODInsurance;
  const result: PassResult = {
    dryRun: deps.settings.dryRun, scanned: 0, verdicts: {}, liquidatable: 0, uneconomic: [], executed: [], executedByOther: [], voided: [],
    openBatches: 0, bonusUsdg: "0", badDebtUsdg: "0", indexAgeS: null,
  };
  const c: Ctx = { ...deps, addresses, ...(insuranceRaw ? { insurance: getAddress(insuranceRaw) } : {}), result, chainNow: await chainNowOf(deps.clients) };
  const jobs = deps.settings.jobs;

  // 1. Events (R7): the first pass rebuilds open batches from BatchSealed with no close after it; later passes follow new logs.
  const rebuilding = deps.state.lastLogBlock === undefined;
  if (rebuilding || jobs.has("watch") || jobs.has("execute")) {
    const closures = await syncNow(c);
    for (const closure of closures) {
      const known = await deps.sql<{ id: string }[]>`select id::text from liquidation_runs where batch_id = ${closure.batchId.toString()} limit 1`;
      if (rebuilding && !known.length) continue; // history before this process: not ours to record
      const b = closure.batch!;
      await recordClosure(c, { batchId: b.batchId, gearId: b.gearId, vaultIds: b.vaultIds }, closure, true);
    }
  }

  // 2. Execute every open batch still inside its window (ours or anyone's: executing is permissionless and pays the bonus).
  if (jobs.has("execute")) for (const batch of [...deps.state.open.values()]) await executeOne(c, batch);

  // 3. Scan and verify (R3, R4, R9).
  const attempts: AttemptRow[] = [];
  let verified: Verified[] = [];
  if (jobs.has("scan")) {
    const meta = await readIndexerMetadata(deps.sql).catch(() => ({} as Awaited<ReturnType<typeof readIndexerMetadata>>));
    const lastOk = Date.parse(meta.indexerLastOk ?? "");
    const indexAgeS = Number.isFinite(lastOk) ? Math.max(0, Math.round(Date.now() / 1000 - lastOk / 1000)) : null;
    result.indexAgeS = indexAgeS;
    deps.state.lastScanAgeS = indexAgeS;
    if (indexAgeS === null || indexAgeS > deps.settings.maxIndexAgeS) {
      deps.logger.warn({ indexAgeS }, "Indexed vault rows are older than LIQUIDATOR_MAX_INDEX_AGE_SECONDS; they stay a hint and the chain decides");
    }
    const scan = await scanWithReport(deps.sql, { limit: deps.settings.scanLimit, maxIndexAgeS: deps.settings.maxIndexAgeS, indexAgeS });
    deps.state.lastScanAt = new Date();
    for (const m of scan.malformed) if (/^\d{1,78}$/.test(m.id)) attempts.push({ vaultId: BigInt(m.id), gear: null, verdict: "malformed", reason: m.reason });
    // Vaults already in an open batch are not re-sealed (R7) and need no re-read.
    const inOpen = new Set([...deps.state.open.values()].flatMap((b) => b.vaultIds));
    const candidates = scan.candidates.filter((x) => {
      if (!inOpen.has(x.vaultId)) return true;
      attempts.push({ vaultId: x.vaultId, gear: x.gearId, verdict: "in_batch", reason: "open batch known from events" });
      return false;
    });
    result.scanned = scan.candidates.length;
    try {
      verified = await verifyOnChain(deps.clients, candidates, addresses);
    } catch (error) {
      deps.logger.warn({ err: safeErrorSummary(error) }, "Verification multicall failed; nothing is sealed this pass");
      for (const x of candidates) attempts.push({ vaultId: x.vaultId, gear: x.gearId, verdict: "read_failed", reason: safeErrorSummary(error).message });
    }
    for (const v of verified) {
      attempts.push({ vaultId: v.vaultId, gear: v.gearId, verdict: v.verdict, ratioBps: v.health?.ratioBps ?? null, requiredBps: v.health?.maintenanceBps ?? null, reason: v.reason ?? null });
    }
    result.liquidatable = verified.filter((v) => v.verdict === "liquidatable").length;
  }

  // 4. Seal one batch (R10: one open batch of ours per pass).
  const ownOpen = [...deps.state.open.values()].some((b) => b.mine);
  if (jobs.has("seal") && !ownOpen && result.liquidatable > 0) await sealBest(c, verified, attempts);

  for (const a of attempts) result.verdicts[a.verdict] = (result.verdicts[a.verdict] ?? 0) + 1;
  await insertAttempts(deps.sql, attempts);
  result.openBatches = deps.state.open.size;
  await writeHeartbeat(deps, result);
  return result;
}

/** R13: heartbeat row `service_status.job = 'liquidator'` with scan age, open batches and the last bonus. */
export async function writeHeartbeat(deps: Pick<PassDeps, "sql" | "state" | "settings">, result: PassResult): Promise<void> {
  const meta = JSON.stringify({
    scanAgeS: deps.state.lastScanAgeS, lastScanAt: deps.state.lastScanAt?.toISOString() ?? null, openBatches: deps.state.open.size,
    lastBonusUsdg: deps.state.lastBonusUsdg.toString(), dryRun: deps.settings.dryRun, liquidatable: result.liquidatable, uneconomic: result.uneconomic.length,
  });
  await deps.sql`insert into service_status (job, last_run, last_ok, meta) values (${LIQUIDATOR_STATUS_JOB}, now(), now(), ${meta}::jsonb)
    on conflict (job) do update set last_run = now(), last_ok = now(), last_error = null, meta = service_status.meta || excluded.meta`;
}

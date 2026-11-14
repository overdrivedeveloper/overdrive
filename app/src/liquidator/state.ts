// In-memory state of one liquidator process, rebuilt from CHAIN EVENTS on start (R7): every BatchSealed with no Liquidated or
// BatchVoided after it is an open batch, whoever sealed it. The service's own table is a log, never the source of open batches.
import { parseEventLogs, type Address, type Hex, type Log } from "viem";
import { IODBackerAbi, IODInsuranceAbi } from "../abi";
import type { ServiceClients } from "../chain/clients";
import type { LiquidatedEvent, OpenBatch } from "./types";

export class LiquidatorState {
  open = new Map<bigint, OpenBatch>();
  /** Last block whose logs were read; undefined until the first rebuild. */
  lastLogBlock: bigint | undefined;
  /** When each uneconomic vault was first seen waiting (unix seconds), for the deep-shortfall alert. */
  firstUneconomic = new Map<bigint, number>();
  /** Batches whose execute was already simulated in dry run (recorded once). */
  simulated = new Set<bigint>();
  lastBonusUsdg = 0n;
  /** ODBacker's liquidation constants, read once from the chain (SEAL_DELAY, BATCH_TTL, BONUS_BPS, MIN_REWARD_USDG, MAX_BATCH). */
  terms: import("./batch").BackerTerms | undefined;
  lastScanAt: Date | undefined;
  lastScanAgeS: number | null = null;
}

export interface Closure { batchId: bigint; kind: "liquidated" | "voided"; reason?: string; events: LiquidatedEvent[]; txHash?: Hex; coveredUsdg?: bigint; batch?: OpenBatch }

type AnyLog = Log & { args?: Record<string, unknown>; eventName?: string };

/** Decoded backer events (BatchSealed, Liquidated, BatchVoided) and insurance Covered events from raw logs. */
export function decodeLiquidationLogs(logs: readonly unknown[], backer: Address, insurance?: Address) {
  const raw = logs as Log[];
  const backerLogs = parseEventLogs({ abi: IODBackerAbi, logs: raw.filter((l) => l.address?.toLowerCase() === backer.toLowerCase()), strict: true }) as unknown as AnyLog[];
  const insuranceLogs = insurance
    ? (parseEventLogs({ abi: IODInsuranceAbi, eventName: "Covered", logs: raw.filter((l) => l.address?.toLowerCase() === insurance.toLowerCase()) }) as unknown as AnyLog[])
    : [];
  const sealed = backerLogs.filter((l) => l.eventName === "BatchSealed").map((l) => ({
    batchId: l.args!.batchId as bigint, gearId: l.args!.gearId as Hex, sealedAt: BigInt(l.args!.sealedAt as bigint), vaultIds: [...(l.args!.vaultIds as bigint[])],
    block: l.blockNumber ?? 0n, txHash: l.transactionHash ?? undefined,
  }));
  const liquidated: (LiquidatedEvent & { txHash?: Hex | null })[] = backerLogs.filter((l) => l.eventName === "Liquidated").map((l) => ({
    batchId: l.args!.batchId as bigint, vaultId: l.args!.vaultId as bigint, debtTokens: l.args!.debtTokens as bigint,
    collateralSeized: l.args!.collateralSeized as bigint, bonusUsdg: l.args!.bonusUsdg as bigint, badDebtUsdg: l.args!.badDebtUsdg as bigint, txHash: l.transactionHash,
  }));
  const voided = backerLogs.filter((l) => l.eventName === "BatchVoided").map((l) => ({ batchId: l.args!.batchId as bigint, reason: l.args!.reason as Hex, txHash: l.transactionHash }));
  const covered = insuranceLogs
    .filter((l) => (l.args!.to as string).toLowerCase() === backer.toLowerCase())
    .map((l) => ({ requested: l.args!.requested as bigint, sent: l.args!.sent as bigint, txHash: l.transactionHash }));
  return { sealed, liquidated, voided, covered };
}

/** Reads logs from the last seen block to `head` in chunks, adds new open batches and returns the batches closed in that range.
 * A batch both sealed and closed inside the range never opens. */
export async function syncOpenBatches(
  clients: Pick<ServiceClients, "logsClient">,
  addresses: { backer: Address; insurance?: Address },
  state: LiquidatorState,
  range: { startBlock: bigint; head: bigint; chunk: number },
): Promise<Closure[]> {
  const from = state.lastLogBlock === undefined ? range.startBlock : state.lastLogBlock + 1n;
  const closures: Closure[] = [];
  if (from > range.head) return closures;
  const watch = addresses.insurance ? [addresses.backer, addresses.insurance] : [addresses.backer];
  for (let start = from; start <= range.head; start += BigInt(range.chunk)) {
    const end = start + BigInt(range.chunk) - 1n < range.head ? start + BigInt(range.chunk) - 1n : range.head;
    const logs = await clients.logsClient.getLogs({ address: watch, fromBlock: start, toBlock: end } as never);
    const d = decodeLiquidationLogs(logs as unknown[], addresses.backer, addresses.insurance);
    // Events come in block order; apply seals first within the chunk, then closures (a close always follows its seal).
    for (const s of d.sealed) {
      if (!state.open.has(s.batchId)) state.open.set(s.batchId, { batchId: s.batchId, gearId: s.gearId, vaultIds: s.vaultIds, sealedAt: s.sealedAt, sealedBlock: s.block, mine: false });
    }
    const touched = new Map<bigint, Closure>();
    for (const l of d.liquidated) {
      const c = touched.get(l.batchId) ?? { batchId: l.batchId, kind: "liquidated" as const, events: [], ...(l.txHash ? { txHash: l.txHash } : {}) };
      c.events.push(l);
      touched.set(l.batchId, c);
    }
    for (const v of d.voided) touched.set(v.batchId, { batchId: v.batchId, kind: "voided", reason: v.reason, events: [], ...(v.txHash ? { txHash: v.txHash } : {}) });
    for (const c of touched.values()) {
      const cov = d.covered.filter((x) => x.txHash && x.txHash === c.txHash);
      if (cov.length) c.coveredUsdg = cov.reduce((s, x) => s + x.sent, 0n);
      // Only batches still open are news; a close of a batch this process already closed itself is ignored.
      const open = state.open.get(c.batchId);
      if (open) { state.open.delete(c.batchId); closures.push({ ...c, batch: open }); }
    }
    state.lastLogBlock = end;
  }
  return closures;
}

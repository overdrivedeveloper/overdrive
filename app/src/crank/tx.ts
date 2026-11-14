import { keccak256, toHex, type Address, type Hex, type TransactionReceipt } from "viem";
import type { Logger } from "pino";
import type { ServiceClients } from "../chain/clients";
import { robinhoodChain } from "../chain/chain";
import { safeErrorSummary } from "../log";
import { withDecodedRevert } from "../chain/revert";
import { crankGasLimit, type GasLimitPolicy } from "./gas";

export { crankGasLimit, DEFAULT_GAS_LIMIT_POLICY, type GasLimitPolicy } from "./gas";

export interface CrankTransaction {
  to: Address;
  data: Hex;
  label: string;
  value?: bigint;
  /** Time-based accrual: estimate one second ahead of the latest block (the estimate block and the execution block differ after a warp). */
  estimateAheadSeconds?: number;
  /** "protocol" (default) jobs go ahead of "user" jobs (queued sells) waiting for the one nonce, so user-triggered work never starves the toll (R9). */
  priority?: "protocol" | "user";
}

export interface TxResult {
  simulated: boolean;
  hash?: Hex;
  receipt?: TransactionReceipt;
  /** Gas the transaction used (from the receipt), or the node's estimate for a dry run. Lets jobs size their batches. */
  gasUsed?: bigint;
}
/** Back-compat alias used by the interface in the todo. */
export type TransactionResult = TxResult;

/** The crank's queue-level errors that mean "the nonce is held": splitting a batch would only repeat them. */
export const HELD_QUEUE = /nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i;

/** The nonce is held this long before the heartbeat file stops updating (R3). */
export const HELD_NONCE_STUCK_MS = 10 * 60_000;

export interface TransactionQueueOptions {
  dryRun: boolean;
  gasLimit?: GasLimitPolicy;
  logger: Logger;
  onHash?: (transaction: CrankTransaction, hash: Hex) => Promise<void>;
  receiptTimeoutMs?: number;
}

/** Snapshot of the queue's nonce state, surfaced in the crank heartbeat. */
export interface TxQueueStatus {
  heldNonce: number | null;
  heldSince: string | null;
  heldHashes: number;
}

export type BroadcastOutcome = "accepted" | "rejected" | "unknown";

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>;
    for (const key of ["shortMessage", "details", "message"]) {
      if (typeof record[key] === "string") parts.push(record[key] as string);
    }
    current = record.cause;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join(" ").toLowerCase();
}

/** Classify a failed eth_sendRawTransaction. "rejected" means the node refused
 * the transaction outright, so it is in no mempool and does not occupy its
 * nonce. "accepted" covers duplicate-submission errors (the transaction is
 * pending). Anything else (timeouts, lost responses) is "unknown" and treated
 * as possibly broadcast.
 */
export function classifyBroadcastError(error: unknown): BroadcastOutcome {
  const text = errorText(error);
  if (/already known|known transaction|already imported|already in (the )?(mem)?pool/.test(text)) return "accepted";
  // Another transaction already occupies this nonce in the mempool.
  if (/replacement transaction underpriced|replacement fee too low/.test(text)) return "unknown";
  if (/nonce too low|nonce too high|insufficient funds|base fee|fee cap less than|max fee per gas less than|fee too low|underpriced|intrinsic gas|gas too low|exceeds block gas limit|invalid sender|invalid signature|invalid chain id|type not supported|oversized data/.test(text)) {
    return "rejected";
  }
  return "unknown";
}

/** One signer, one in-flight nonce. Signing locally makes a hash available even
 * when the RPC accepts a broadcast but loses its response. A possibly-broadcast
 * transaction holds its nonce until a receipt is found, the chain shows the
 * nonce consumed, or the chain shows nothing of ours in flight (latest ==
 * pending). Broadcasts the node definitively rejected release the nonce at once.
 */
export function createTxQueue(clients: ServiceClients, options: TransactionQueueOptions) {
  const wallet = clients.walletClient;
  const account = wallet?.account;
  // One transaction at a time (one nonce). Waiting submissions are served protocol-first, FIFO inside a priority.
  const waiting: { priority: number; go: () => void }[] = [];
  let busy = false;
  let idleWaiters: (() => void)[] = [];
  const acquire = (priority: number): Promise<void> => {
    if (!busy) { busy = true; return Promise.resolve(); }
    return new Promise<void>((go) => { waiting.push({ priority, go }); });
  };
  const release = (): void => {
    if (!waiting.length) { busy = false; for (const wake of idleWaiters.splice(0)) wake(); return; }
    let best = 0;
    for (let i = 1; i < waiting.length; i++) if (waiting[i]!.priority < waiting[best]!.priority) best = i;
    waiting.splice(best, 1)[0]!.go();
  };
  let nextNonce: number | undefined;
  let unresolved: { nonce: number; hashes: Hex[]; since: number } | undefined;
  const timeout = options.receiptTimeoutMs ?? 60_000;

  async function receipt(hashes: Hex[]): Promise<TransactionReceipt | undefined> {
    for (const hash of hashes) {
      try { return await clients.txClient.getTransactionReceipt({ hash }); }
      catch { /* Not found or temporarily unavailable: retry within the bounded wait. */ }
    }
    return undefined;
  }

  async function wait(hashes: Hex[]): Promise<TransactionReceipt | undefined> {
    const end = Date.now() + timeout;
    let delay = 500;
    while (true) {
      const found = await receipt(hashes);
      if (found) return found;
      if (Date.now() >= end) return undefined;
      await Bun.sleep(Math.min(delay, Math.max(1, end - Date.now())));
      delay = Math.min(delay * 2, 4000);
    }
  }

  /** A fresh legacy gas price for every attempt: eth_gasPrice, floored at twice
   * the latest base fee so a base-fee rise between blocks does not get the
   * transaction rejected. The RPC pool never caches fee reads on the tx route.
   */
  async function gasPrice(): Promise<bigint> {
    const [quoted, baseFee] = await Promise.all([
      clients.txClient.getGasPrice(),
      clients.txClient.getBlock({ blockTag: "latest" })
        .then((block) => block.baseFeePerGas ?? 0n)
        .catch(() => 0n),
    ]);
    const floor = baseFee * 2n;
    return quoted > floor ? quoted : floor;
  }

  async function chainNonces(address: Address): Promise<{ latest: number; pending: number }> {
    const [latest, pending] = await Promise.all([
      clients.txClient.getTransactionCount({ address, blockTag: "latest" }),
      clients.txClient.getTransactionCount({ address, blockTag: "pending" }),
    ]);
    return { latest, pending };
  }

  /** Resolve a held nonce, or throw while it is still legitimately in flight. */
  async function reconcile(address: Address): Promise<void> {
    if (!unresolved) return;
    const held = unresolved;
    const found = await receipt(held.hashes);
    if (found) {
      nextNonce = held.nonce + 1;
      unresolved = undefined;
      return;
    }
    const { latest, pending } = await chainNonces(address);
    if (latest > held.nonce) {
      // The nonce was consumed on chain by a hash we cannot see. Re-read the
      // next nonce from the chain before signing anything else.
      options.logger.warn({ nonce: held.nonce, latest, pending }, "Crank held nonce was consumed on chain; releasing it");
      nextNonce = undefined;
      unresolved = undefined;
      return;
    }
    if (latest === pending) {
      // Nothing from this signer is in flight: the broadcasts were dropped.
      options.logger.warn({ nonce: held.nonce, latest }, "Crank held nonce is not pending on chain; releasing it");
      nextNonce = latest;
      unresolved = undefined;
      return;
    }
    throw new Error(`Crank nonce ${held.nonce} is unresolved; later transactions are held`);
  }

  /** estimateGas is the simulation: do not precede it with a redundant eth_call. A time-based accrual is estimated one
   * second ahead of the latest block through the block-override parameter of eth_estimateGas; a node that does not
   * accept the parameter falls back to the plain estimate (the gas limit policy then carries the margin). */
  async function estimateFor(transaction: CrankTransaction, from: Address): Promise<bigint> {
    const call = { account: from, to: transaction.to, data: transaction.data, value: transaction.value ?? 0n };
    if (transaction.estimateAheadSeconds) {
      try {
        const latest = await clients.txClient.getBlock({ blockTag: "latest" });
        const ahead = latest.timestamp + BigInt(transaction.estimateAheadSeconds);
        const result = await clients.txClient.request({
          method: "eth_estimateGas",
          params: [{ from, to: transaction.to, data: transaction.data, value: toHex(transaction.value ?? 0n) }, "latest", {}, { time: toHex(ahead) }],
        } as never) as Hex;
        return BigInt(result);
      } catch (error) {
        if (/revert|execution/i.test(errorText(error))) throw error;
        options.logger.warn({ label: transaction.label }, "Node did not accept a block override; estimating at the latest block");
      }
    }
    return clients.txClient.estimateGas(call);
  }

  async function run(transaction: CrankTransaction): Promise<TransactionResult> {
    if (!wallet || !account || account.type !== "local") throw new Error("Crank local signer is not configured");
    await reconcile(account.address);

    // estimateGas is the simulation: do not precede it with a redundant eth_call.
    // R14/R19: a revert is reported with the contract error's name (decoded from the node's revert data).
    const estimate = await estimateFor(transaction, account.address)
      .catch((error: unknown) => { throw withDecodedRevert(error); });
    if (options.dryRun) {
      options.logger.info({ label: transaction.label, gas: estimate.toString() }, "Crank dry-run simulated");
      return { simulated: true, gasUsed: estimate };
    }

    if (nextNonce === undefined) {
      const { latest, pending } = await chainNonces(account.address);
      if (latest !== pending) throw new Error("Crank has an existing pending transaction; waiting before taking a new nonce");
      nextNonce = latest;
    }
    const nonce = nextNonce;
    const hashes: Hex[] = [];
    let previous = 0n;
    let maybeBroadcast = false;
    let lastRejection = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await gasPrice();
      // One replacement, same nonce and payload, at least 20% above the previous attempt.
      const bumped = attempt === 0 ? 0n : (previous * 120n + 99n) / 100n + 1n;
      const price = fresh > bumped ? fresh : bumped;
      previous = price;
      const serializedTransaction = await account.signTransaction({
        chainId: clients.chainId ?? robinhoodChain.id, type: "legacy", nonce,
        to: transaction.to, data: transaction.data, value: transaction.value ?? 0n,
        gas: crankGasLimit(estimate, options.gasLimit), gasPrice: price,
      });
      const hash = keccak256(serializedTransaction);
      let outcome: BroadcastOutcome = "accepted";
      try { await clients.txClient.sendRawTransaction({ serializedTransaction }); }
      catch (error) {
        outcome = classifyBroadcastError(error);
        const err = safeErrorSummary(error);
        if (outcome === "rejected") {
          lastRejection = err.message;
          options.logger.warn({ label: transaction.label, hash, nonce, gasPrice: price.toString(), err },
            "Crank broadcast was rejected by the node");
        } else {
          options.logger.warn({ label: transaction.label, hash, err },
            "Crank broadcast response failed; checking the locally known transaction hash");
        }
      }
      // A rejected broadcast is in no mempool: nothing to persist or wait for.
      if (outcome === "rejected") continue;
      maybeBroadcast = true;
      hashes.push(hash);
      unresolved ??= { nonce, hashes, since: Date.now() };
      options.logger.info({ label: transaction.label, hash, nonce, replacement: attempt === 1 }, "Crank transaction submitted");
      try { await options.onHash?.(transaction, hash); }
      catch (error) { options.logger.warn({ err: safeErrorSummary(error) }, "Could not persist crank transaction hash"); }

      const found = await wait(hashes);
      if (found) {
        nextNonce = nonce + 1;
        unresolved = undefined;
        if (found.status !== "success") throw new Error(`Crank transaction reverted: ${found.transactionHash}`);
        return { simulated: false, hash: found.transactionHash, receipt: found, gasUsed: found.gasUsed };
      }
    }
    if (!maybeBroadcast) {
      // Every attempt was refused outright, so nothing occupies the nonce.
      // Re-read it from the chain on the next job (this also covers "nonce too low").
      nextNonce = undefined;
      throw new Error(`Crank transaction rejected by the node; nonce ${nonce} released: ${lastRejection}`);
    }
    throw new Error(`Crank transaction receipt timed out; nonce ${nonce} remains held`);
  }

  return {
    async submit(transaction: CrankTransaction): Promise<TxResult> {
      await acquire(transaction.priority === "user" ? 1 : 0);
      try { return await run(transaction); } finally { release(); }
    },
    status(): TxQueueStatus {
      return {
        heldNonce: unresolved?.nonce ?? null,
        heldSince: unresolved ? new Date(unresolved.since).toISOString() : null,
        heldHashes: unresolved?.hashes.length ?? 0,
      };
    },
    async drain(): Promise<void> { if (busy || waiting.length) await new Promise<void>((wake) => { idleWaiters.push(wake); }); },
    /** Submissions waiting behind the one in flight. */
    pending: (): number => waiting.length,
  };
}

export interface TxQueue {
  submit(t: CrankTransaction): Promise<TxResult>;
  status(): TxQueueStatus;
  drain(): Promise<void>;
}

/** A view of the queue whose submissions are marked `user` (the queued-sells job): they wait behind any protocol transaction. */
export function withPriority(tx: TxQueue, priority: "protocol" | "user"): TxQueue {
  return { ...tx, submit: (t) => tx.submit({ priority, ...t }), status: () => tx.status(), drain: () => tx.drain() };
}

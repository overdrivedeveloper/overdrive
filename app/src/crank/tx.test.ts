import { describe, expect, test } from "bun:test";
import { keccak256, parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import pino from "pino";
import type { ServiceClients } from "../chain/clients";
import { createHeartbeatJob } from "./jobs/heartbeat";
import { HELD_NONCE_STUCK_MS, classifyBroadcastError, createTxQueue, withPriority, type CrankTransaction } from "./tx";

const logger = pino({ level: "silent" });
const account = privateKeyToAccount(generatePrivateKey());
const TO = "0x00000000000000000000000000000000000000e1" as const;
const call = (label = "toll", extra: Partial<CrankTransaction> = {}): CrankTransaction => ({ to: TO, data: "0x1234", label, ...extra });

interface FakeNode {
  sent: Hex[]; estimates: { block: unknown }[]; receipts: Map<string, object>; latest: number; pending: number; rejectSends: boolean; failSendResponse: boolean; autoMine: boolean;
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>; estimate: bigint; seen: string[];
}
function fakeClients(node: Partial<FakeNode> = {}): { clients: ServiceClients; node: FakeNode } {
  const state: FakeNode = { sent: [], estimates: [], receipts: new Map(), latest: 0, pending: 0, rejectSends: false, failSendResponse: false, autoMine: false, estimate: 100_000n, seen: [], request: async () => "0x0", ...node };
  const tx = {
    estimateGas: async () => { state.estimates.push({ block: "latest" }); return state.estimate; },
    request: async (args: { method: string; params: unknown[] }) => { state.seen.push(JSON.stringify(args.params.slice(1))); return state.request(args).then((r) => (r === "0x0" ? `0x${state.estimate.toString(16)}` : r)); },
    getBlock: async () => ({ timestamp: 1_800_000_000n, baseFeePerGas: 10n }),
    getGasPrice: async () => 100n,
    getTransactionCount: async ({ blockTag }: { blockTag: string }) => (blockTag === "latest" ? state.latest : state.pending),
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      if (state.rejectSends) throw new Error("nonce too low");
      state.sent.push(serializedTransaction);
      if (state.autoMine) { const h = keccak256(serializedTransaction); state.receipts.set(h, { status: "success", transactionHash: h, gasUsed: 90_000n }); }
      state.pending = Math.max(state.pending, state.latest + 1);
      if (state.failSendResponse) throw new Error("socket hang up");
      return "0x";
    },
    getTransactionReceipt: async ({ hash }: { hash: string }) => { const r = state.receipts.get(hash); if (!r) throw new Error("not found"); return r; },
  };
  return { clients: { txClient: tx, stateClient: tx, logsClient: tx, walletClient: { account }, pool: {}, chainId: 31337 } as unknown as ServiceClients, node: state };
}

describe("tx queue", () => {
  test("held_nonce_blocks_and_never_rebroadcasts_new_nonce", async () => {
    const { clients, node } = fakeClients();
    const queue = createTxQueue(clients, { dryRun: false, logger, receiptTimeoutMs: 30 });
    await expect(queue.submit(call())).rejects.toThrow(/remains held/);
    expect(queue.status().heldNonce).toBe(0);
    const firstRound = node.sent.length;
    expect(firstRound).toBeGreaterThanOrEqual(1);
    // a second submission is refused while the nonce is unresolved, and nothing new is broadcast
    await expect(queue.submit(call("poke"))).rejects.toThrow(/unresolved/);
    expect(node.sent.length).toBe(firstRound);
    // every signed transaction used the same nonce (the replacement is the same payload at a higher price)
    for (const raw of node.sent) expect(parseTransaction(raw).nonce).toBe(0);
    // mined: the held nonce resolves and the next transaction takes nonce 1
    const hash = keccak256(node.sent[0]!);
    node.autoMine = true;
    node.receipts.set(hash, { status: "success", transactionHash: hash, gasUsed: 90_000n });
    node.latest = 1; node.pending = 1;
    const result = await queue.submit(call("poke"));
    expect(result.simulated).toBe(false);
    expect(parseTransaction(node.sent.at(-1)!).nonce).toBe(1);
    expect(queue.status().heldNonce).toBeNull();
  });

  test("estimate_one_second_ahead_for_accrual", async () => {
    const { clients, node } = fakeClients();
    const queue = createTxQueue(clients, { dryRun: true, logger });
    await queue.submit(call("toll", { estimateAheadSeconds: 1 }));
    // eth_estimateGas ran with a block override one second after the latest block
    expect(node.seen.some((p) => p.includes(`"time":"0x${(1_800_000_001n).toString(16)}"`))).toBe(true);
    expect(node.estimates.length).toBe(0);
    await queue.submit(call("poke"));
    expect(node.estimates.length).toBe(1);
  });

  test("dry_run_never_broadcasts", async () => {
    const { clients, node } = fakeClients();
    const queue = createTxQueue(clients, { dryRun: true, logger });
    const result = await queue.submit(call());
    expect(result).toEqual({ simulated: true, gasUsed: 100_000n });
    expect(node.sent.length).toBe(0);
  });

  test("heartbeat_stops_after_stuck_threshold", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "hb-")), "heartbeat");
    writeFileSync(file, "old");
    let held: { heldNonce: number | null; heldSince: string | null; heldHashes: number } = { heldNonce: 3, heldSince: new Date(1_000_000).toISOString(), heldHashes: 1 };
    const rows: unknown[] = [];
    const sql = (async (...args: unknown[]) => { rows.push(args); return []; }) as never;
    const ctx = { sql, logger, config: { CRANK_DRY_RUN: true }, clients: { walletClient: { account } }, tx: { status: () => held } } as never;
    let now = 1_000_000 + HELD_NONCE_STUCK_MS - 1000;
    const beat = createHeartbeatJob(ctx, { file, onLockLost: () => undefined, now: () => now });
    await beat();
    expect(readFileSync(file, "utf8")).toBe(new Date(now).toISOString());
    now = 1_000_000 + HELD_NONCE_STUCK_MS + 1000;
    const stale = readFileSync(file, "utf8");
    const meta = await beat();
    expect(readFileSync(file, "utf8")).toBe(stale);
    expect(meta.heartbeatFile).toBe(false);
    held = { heldNonce: null, heldSince: null, heldHashes: 0 };
    await beat();
    expect(readFileSync(file, "utf8")).toBe(new Date(now).toISOString());
  });

  test("protocol_transactions_go_ahead_of_user_transactions", async () => {
    const { clients } = fakeClients();
    const order: string[] = [];
    const queue = createTxQueue(clients, { dryRun: true, logger });
    const slow = clients.txClient as unknown as { estimateGas: () => Promise<bigint> };
    const original = slow.estimateGas;
    slow.estimateGas = async () => { await Bun.sleep(5); return original(); };
    const user = withPriority(queue, "user");
    const all = [
      ...Array.from({ length: 20 }, (_, i) => user.submit(call(`queued-sells:${i}`)).then(() => order.push(`u${i}`))),
      queue.submit(call("toll")).then(() => order.push("toll")),
    ];
    await Promise.all(all);
    // the toll waits for the transaction in flight only, not for the other 19
    expect(order.indexOf("toll")).toBeLessThanOrEqual(1);
  });

  test("classifies_broadcast_errors", () => {
    expect(classifyBroadcastError(new Error("nonce too low"))).toBe("rejected");
    expect(classifyBroadcastError(new Error("already known"))).toBe("accepted");
    expect(classifyBroadcastError(new Error("socket hang up"))).toBe("unknown");
  });
});

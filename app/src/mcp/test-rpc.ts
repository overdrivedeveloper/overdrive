// A minimal JSON-RPC node backed by the router mock, for tests that run the real MCP process: it answers the reads the
// server makes (policyOf, allowedMarkets, remainingBudget, the registry's gear), the calls viem makes before it signs,
// and runs a raw transaction through the router mock as its sender. Not a test file.
import { decodeFunctionData, encodeFunctionResult, parseTransaction, recoverTransactionAddress, type Address, type Hex } from "viem";
import { IODAgentRouterAbi, IODGearRegistryAbi } from "../abi";
import { ALLOWED_MARKETS_ABI } from "./agent";
import { MockRevert, type MockRouter } from "../testing/mock-router";

export interface FakeRpc { url: string; port: number; sent: Array<{ from: Address; data: Hex; ok: boolean; error?: string }>; stop(): void }

export function startFakeRpc(router: MockRouter, chainId: number): FakeRpc {
  const sent: FakeRpc["sent"] = [];
  const receipts = new Map<string, { status: "0x1" | "0x0"; from: Address; to: Address }>();
  const hex = (n: number | bigint) => `0x${n.toString(16)}`;
  const reader = router.reader();
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.json() as any;
      const handle = async (m: { id: number; method: string; params?: any[] }) => {
        const p = m.params ?? [];
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
        switch (m.method) {
          case "eth_chainId": return ok(hex(chainId));
          case "eth_blockNumber": return ok(hex(100));
          case "eth_getBlockByNumber": return ok({ number: hex(100), hash: `0x${"11".repeat(32)}`, timestamp: hex(router.now()), transactions: [], gasLimit: hex(30_000_000), gasUsed: "0x0", parentHash: `0x${"00".repeat(32)}`, nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, logsBloom: `0x${"00".repeat(256)}`, transactionsRoot: `0x${"00".repeat(32)}`, stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, miner: `0x${"00".repeat(20)}`, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", uncles: [] });
          case "eth_gasPrice": return ok(hex(1_000_000_000));
          case "eth_maxPriorityFeePerGas": return ok(hex(1_000_000));
          case "eth_getTransactionCount": return ok(hex(sent.length));
          case "eth_estimateGas": return ok(hex(300_000));
          case "eth_call": {
            const data = p[0].data as Hex;
            for (const abi of [IODAgentRouterAbi, ALLOWED_MARKETS_ABI, IODGearRegistryAbi] as const) {
              try {
                const { functionName, args } = decodeFunctionData({ abi, data }) as { functionName: string; args: readonly unknown[] };
                const result = await reader.readContract({ address: p[0].to, abi, functionName, args });
                return ok(encodeFunctionResult({ abi, functionName, result } as never));
              } catch { /* try the next ABI */ }
            }
            return { jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted" } };
          }
          case "eth_sendRawTransaction": {
            const raw = p[0] as Hex;
            const tx = parseTransaction(raw);
            const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
            const hash = `0x${(sent.length + 1).toString(16).padStart(64, "0")}`;
            let status: "0x1" | "0x0" = "0x1";
            try { router.execute(from, tx.data as Hex); sent.push({ from, data: tx.data as Hex, ok: true }); }
            catch (e) { status = "0x0"; sent.push({ from, data: tx.data as Hex, ok: false, error: e instanceof MockRevert ? e.errorName : "error" }); }
            receipts.set(hash, { status, from, to: tx.to as Address });
            return ok(hash);
          }
          case "eth_getTransactionReceipt": {
            const r = receipts.get(p[0]);
            return ok(r ? { transactionHash: p[0], transactionIndex: "0x0", blockHash: `0x${"11".repeat(32)}`, blockNumber: hex(100), from: r.from, to: r.to, cumulativeGasUsed: hex(100_000), gasUsed: hex(100_000), effectiveGasPrice: hex(1_000_000_000), contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: r.status, type: "0x0" } : null);
          }
          case "eth_getTransactionByHash": return ok(null);
          default: return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } };
        }
      };
      const out = Array.isArray(body) ? await Promise.all(body.map(handle)) : await handle(body);
      return Response.json(out);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: Number(server.port), sent, stop: () => { server.stop(true); } };
}

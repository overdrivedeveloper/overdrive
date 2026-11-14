import type { Address, Hex } from "viem";
import { IODGearRegistryAbi } from "../abi";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";
import type { BlockHeader, ChainSource, RpcLog } from "./types";
import { asBigInt, blockHex, parseChainTimestamp } from "./units";

function logFilter(addresses: readonly Address[], fromBlock: bigint, toBlock: bigint, topics?: readonly Hex[]): Record<string, unknown> {
  return {
    address: addresses.length > 0 ? [...addresses] : ["0x0000000000000000000000000000000000000000"],
    fromBlock: blockHex(fromBlock),
    toBlock: blockHex(toBlock),
    ...(topics ? { topics: [[...topics]] } : {}),
  };
}

function parseHeader(value: unknown): BlockHeader | undefined {
  const header = value as { number?: unknown; hash?: unknown; parentHash?: unknown; timestamp?: unknown } | null | undefined;
  if (!header || typeof header.hash !== "string" || typeof header.parentHash !== "string") return undefined;
  const timestamp = parseChainTimestamp(header.timestamp);
  if (!timestamp) return undefined;
  return { number: asBigInt(header.number), hash: header.hash.toLowerCase(), parentHash: header.parentHash.toLowerCase(), timestamp };
}

/** Reads through the rotating RPC pool. Header and log calls never come from the pool cache, so a reorg is always visible. */
export function createRpcChainSource(clients: ServiceClients, deployment?: Deployment): ChainSource {
  const { pool } = clients;
  const registry = deployment?.contracts.ODGearRegistry as Address | undefined;
  return {
    getHead: () => clients.logsClient.getBlockNumber(),
    async getLogs(range) {
      const [own, stock] = await pool.requestBatch("logs", [
        { method: "eth_getLogs", params: [logFilter(range.addresses, range.fromBlock, range.toBlock)] },
        { method: "eth_getLogs", params: [logFilter(range.stockAddresses, range.fromBlock, range.toBlock, range.stockTopics)] },
      ]);
      if (!Array.isArray(own) || !Array.isArray(stock)) throw new Error("RPC returned an invalid eth_getLogs response");
      return { logs: own as RpcLog[], stockLogs: stock as RpcLog[] };
    },
    async getHeaders(numbers) {
      const result = new Map<bigint, BlockHeader | undefined>();
      if (numbers.length === 0) return result;
      const unique = [...new Set(numbers)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const responses = await pool.requestBatch("logs", unique.map((number) => ({ method: "eth_getBlockByNumber", params: [blockHex(number), false] })));
      unique.forEach((number, index) => result.set(number, parseHeader(responses[index])));
      return result;
    },
    ...(registry ? {
      async readGearParams(gearId: Hex, block: bigint) {
        const call = (blockNumber?: bigint) => clients.stateClient.readContract({ address: registry, abi: IODGearRegistryAbi, functionName: "gear", args: [gearId], ...(blockNumber === undefined ? {} : { blockNumber }) });
        // a node without historical state rejects the block read: fall back to latest
        const config = await call(block).catch(() => call());
        return { capUsdWad: config.capUsdWad, spreadBps: Number(config.spreadBps) };
      },
    } : {}),
    async getTransactionInput(hash) {
      const [tx] = await pool.requestBatch("logs", [{ method: "eth_getTransactionByHash", params: [hash] }]);
      const input = (tx as { input?: unknown } | null | undefined)?.input;
      return typeof input === "string" && input.startsWith("0x") ? (input as Hex) : undefined;
    },
  };
}

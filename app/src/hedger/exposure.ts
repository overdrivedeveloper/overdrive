// R3: the hedge target is `IODGovernor.exposure(market)` read on chain at one block; the indexed governor_ledger row is
// the cross-check. This file holds the readers and the agreement rule; the service decides what to do with them.
import type { PublicClient } from "viem";
import type { Sql } from "postgres";
import { IODGovernorAbi } from "../abi";
import { fromBps, toBigInt, wadToUsdg } from "../lib/fixed";
import type { Exposure, Hex } from "./types";

export interface ChainHead { block: bigint; timestampMs: number }

export interface ChainExposureReader {
  head(): Promise<ChainHead>;
  /** Exposure and Governor equity for one market, both read at `block`. Throws when unreadable (the caller fails closed). */
  exposure(market: Hex, symbol: string, block: bigint): Promise<Exposure>;
}

export interface IndexedRow { block: bigint; ts: Date; deltaUsd: bigint; gammaUsd: bigint; equityUsd: bigint }
export interface IndexedReader { latest(symbol: string, atOrBefore: bigint): Promise<IndexedRow | null> }

export function createChainExposureReader(client: PublicClient, governor: `0x${string}`): ChainExposureReader {
  return {
    async head() {
      const block = await client.getBlock({ blockTag: "latest" });
      return { block: block.number, timestampMs: Number(block.timestamp) * 1000 };
    },
    async exposure(market, symbol, block) {
      const [exp, equity] = await Promise.all([
        client.readContract({ address: governor, abi: IODGovernorAbi, functionName: "exposure", args: [market], blockNumber: block }),
        client.readContract({ address: governor, abi: IODGovernorAbi, functionName: "equity", blockNumber: block }),
      ]);
      const [deltaUsdWad, gammaUsdWad, openValueWad] = exp as readonly [bigint, bigint, bigint];
      return { market, symbol, deltaUsdWad, gammaUsdWad, openValueWad, equityWad: equity as bigint, asOfBlock: block, source: "chain" };
    },
  };
}

/** governor_ledger rows are written by the indexer snapshot: underlying = symbol, delta/gamma/equity in raw USDG. */
export function createIndexedReader(sql: Sql): IndexedReader {
  return {
    async latest(symbol, atOrBefore) {
      const rows = await sql<{ block: string | null; ts: Date | string; delta: string; gamma: string; equity: string }[]>`
        SELECT block, ts, delta, gamma, equity FROM governor_ledger
        WHERE underlying = ${symbol} AND block IS NOT NULL AND block <= ${atOrBefore.toString()}
        ORDER BY block DESC, ts DESC LIMIT 1`;
      const r = rows[0];
      if (!r) return null;
      return { block: toBigInt(r.block), ts: new Date(r.ts), deltaUsd: toBigInt(r.delta), gammaUsd: toBigInt(r.gamma), equityUsd: toBigInt(r.equity) };
    },
  };
}

/** Chain delta and indexed delta agree within max(bps of equity, floor). Both sides raw USDG. */
export function agrees(chainDeltaUsd: bigint, indexedDeltaUsd: bigint, equityUsd: bigint, bps: number, floorUsd: bigint): boolean {
  const diff = chainDeltaUsd > indexedDeltaUsd ? chainDeltaUsd - indexedDeltaUsd : indexedDeltaUsd - chainDeltaUsd;
  const byEquity = fromBps(equityUsd > 0n ? equityUsd : 0n, bps);
  return diff <= (byEquity > floorUsd ? byEquity : floorUsd);
}

/** The service's view of one market's exposure, in raw USDG. */
export const exposureUsd = (e: Exposure) => ({ deltaUsd: wadToUsdg(e.deltaUsdWad), gammaUsd: wadToUsdg(e.gammaUsdWad), equityUsd: wadToUsdg(e.equityWad) });

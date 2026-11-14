// Every chain read the API makes, behind one interface so tests (and the mock hook) can stand in. Reads only: the API holds
// no key and sends nothing. The real implementation uses the "state" client of the rpc pool.
import { parseAbi, type PublicClient } from "viem";
import { IODBackerAbi, IODFeesAbi, IODGovernorAbi, IODMinterAbi } from "../abi";
import type { Deployment } from "../lib/deployments";
import type { BlockQuote, RawQuote, Side } from "./quote/model";

export interface QuoteInput { gear: string; side: Side; exactIn: bigint; account?: string | undefined }

/** V4Quoter through ODHook, eth_call at latest. */
export interface ChainQuoter { quote(i: QuoteInput): Promise<RawQuote & { blockNumber: bigint }> }

export interface GovernorReads {
  equity(): Promise<bigint>;
  freeCash(): Promise<bigint>;
  stressLoss(): Promise<{ lossWad: bigint; budgetWad: bigint }>;
  hedgeStale(): Promise<boolean>;
  buysPaused(): Promise<{ paused: boolean; reason: string }>;
  exposure(marketId: string): Promise<{ deltaUsdWad: bigint; gammaUsdWad: bigint; openValueWad: bigint }>;
  exitReserve(): Promise<bigint>;
  exitReserveFloor(): Promise<bigint>;
}

export interface BackerHealth { collateralUsdg: bigint; debtValueWad: bigint; ratioBps: bigint; requiredBps: bigint; maintenanceBps: bigint }

export interface ApiChain {
  blockNumber(): Promise<bigint>;
  readonly quoter: ChainQuoter;
  /** IODMinter.quote for the same trade. */
  minterQuote(i: QuoteInput): Promise<BlockQuote>;
  minterTollPerDay(gearId: string): Promise<bigint>;
  readonly governor: GovernorReads;
  backerHealth(vaultId: bigint): Promise<BackerHealth>;
  feeSplits(): Promise<{ protocolSpreadShareBps: number; tollFeeBps: number; distributable: bigint; nextDistributionAt: bigint }>;
  upliftActive(marketId: string): Promise<{ active: boolean; upliftBps: number }>;
}

/** Uniswap v4 pool parameters of a gear pool. PENDING todo 06a: confirm against ODHook.initializeGearPool when it is built. */
export const GEAR_POOL_FEE = 0x800000; // dynamic-fee flag: the hook sets the price, the pool fee is not the spread
export const GEAR_POOL_TICK_SPACING = 60;

const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/** The real chain adapter. Each method is one eth_call (the quote methods are one call each, so a quote costs two). */
export function createApiChain(client: PublicClient, deployment: Deployment, quoterAddress?: string): ApiChain {
  const minter = deployment.contracts.ODMinter as `0x${string}`;
  const governorAddr = deployment.contracts.ODGovernor as `0x${string}`;
  const backer = deployment.contracts.ODBacker as `0x${string}`;
  const v4 = (quoterAddress || deployment.external.v4Quoter) as `0x${string}`;
  const hook = deployment.contracts.ODHook as `0x${string}`;
  const usdg = deployment.external.usdg;
  const gearToken = (id: string) => deployment.gears.find((g) => g.id.toLowerCase() === id.toLowerCase())?.token;
  const gov = <T extends string>(functionName: T, args: readonly unknown[] = []) =>
    client.readContract({ address: governorAddr, abi: IODGovernorAbi, functionName: functionName as never, args: args as never }) as Promise<any>;
  const toRaw = (q: any): RawQuote => ({
    amountIn: q.amountIn, amountOut: q.amountOut, valuePerTokenWad: q.valuePerTokenWad, pricePerTokenWad: q.pricePerTokenWad,
    spreadBps: Number(q.spreadBps), protocolFeeUsdg: q.protocolFeeUsdg, tollPerDayWad: q.tollPerDayWad, session: Number(q.session), queued: q.queued,
  });
  async function minterQuote(i: QuoteInput): Promise<BlockQuote> {
    const blockNumber = await client.getBlockNumber();
    const q = await client.readContract({ address: minter, abi: IODMinterAbi, functionName: "quote", args: [i.gear as `0x${string}`, i.side === "buy", true, i.exactIn], blockNumber });
    return { ...toRaw(q), blockNumber };
  }
  const quoter: ChainQuoter = {
    async quote(i) {
      const token = gearToken(i.gear);
      if (!token) throw new Error("unknown gear");
      const blockNumber = await client.getBlockNumber();
      const [currency0, currency1] = BigInt(usdg) < BigInt(token) ? [usdg, token] : [token, usdg];
      const tokenIn = i.side === "buy" ? usdg : token;
      const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();
      const [amountOut] = (await client.readContract({
        address: v4, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", blockNumber,
        args: [{ poolKey: { currency0: currency0 as `0x${string}`, currency1: currency1 as `0x${string}`, fee: GEAR_POOL_FEE, tickSpacing: GEAR_POOL_TICK_SPACING, hooks: hook }, zeroForOne, exactAmount: i.exactIn, hookData: "0x" }],
      })) as unknown as readonly [bigint, bigint];
      // V4Quoter returns amounts only: the other fields are null and parity skips them.
      return { amountIn: i.exactIn, amountOut, valuePerTokenWad: null, pricePerTokenWad: null, spreadBps: null, protocolFeeUsdg: null, tollPerDayWad: null, session: null, queued: false, blockNumber };
    },
  };
  return {
    blockNumber: () => client.getBlockNumber(),
    quoter,
    minterQuote,
    minterTollPerDay: async (gearId) => (await client.readContract({ address: minter, abi: IODMinterAbi, functionName: "tollPerDay", args: [gearId as `0x${string}`] })),
    governor: {
      equity: async () => gov("equity"),
      freeCash: async () => gov("freeCash"),
      stressLoss: async () => { const [lossWad, budgetWad] = await gov("stressLoss"); return { lossWad, budgetWad }; },
      hedgeStale: async () => gov("hedgeStale"),
      buysPaused: async () => { const [paused, reason] = await gov("buysPaused"); return { paused, reason: String(reason) }; },
      exposure: async (market) => { const [deltaUsdWad, gammaUsdWad, openValueWad] = await gov("exposure", [market]); return { deltaUsdWad, gammaUsdWad, openValueWad }; },
      exitReserve: async () => gov("exitReserve"),
      exitReserveFloor: async () => gov("exitReserveFloor"),
    },
    backerHealth: async (vaultId) => {
      const [collateralUsdg, debtValueWad, ratioBps, requiredBps, maintenanceBps] = await client.readContract({ address: backer, abi: IODBackerAbi, functionName: "health", args: [vaultId] });
      return { collateralUsdg, debtValueWad, ratioBps, requiredBps, maintenanceBps };
    },
    feeSplits: async () => {
      const fees = deployment.contracts.ODFees as `0x${string}`;
      const read = (functionName: "protocolSpreadShareBps" | "tollFeeBps" | "distributable" | "nextDistributionAt") => client.readContract({ address: fees, abi: IODFeesAbi, functionName });
      const [a, b, c, d] = await Promise.all([read("protocolSpreadShareBps"), read("tollFeeBps"), read("distributable"), read("nextDistributionAt")]);
      return { protocolSpreadShareBps: Number(a), tollFeeBps: Number(b), distributable: c as bigint, nextDistributionAt: d as bigint };
    },
    upliftActive: async (market) => {
      const [active, upliftBps] = await client.readContract({ address: backer, abi: IODBackerAbi, functionName: "upliftActive", args: [market as `0x${string}`] });
      return { active, upliftBps: Number(upliftBps) };
    },
  };
}

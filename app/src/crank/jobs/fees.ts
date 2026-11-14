// R16: IODFees.distribute() is callable by anyone once per 7 days. Checks nextDistributionAt() and distributable() every hour
// and calls it when due and above FEES_MIN_USDG. Logs the Distributed split from the event and never assumes the percentages.
import { decodeEventLog, encodeFunctionData, type Log } from "viem";
import { IODFeesAbi } from "../../abi";
import { revertNameOf } from "../../chain/revert";
import { parseUsdg } from "../../lib/fixed";
import type { CrankContext } from "../context";
import { contractAddress } from "../gears";

export function createFeesJob(context: CrankContext) {
  const fees = contractAddress(context, "ODFees");
  return async (): Promise<Record<string, unknown>> => {
    const nowSeconds = BigInt(Math.floor(context.now(await context.metadata()).getTime() / 1000));
    const next = await context.clients.stateClient.readContract({ address: fees, abi: IODFeesAbi, functionName: "nextDistributionAt" });
    if (nowSeconds < next) return { idle: true, reason: "not_due", nextDistributionAt: Number(next) };
    const amount = await context.clients.stateClient.readContract({ address: fees, abi: IODFeesAbi, functionName: "distributable" });
    const minimum = parseUsdg(String(context.config.FEES_MIN_USDG));
    if (amount <= minimum) return { idle: true, reason: "below_min", distributable: amount.toString(), minimum: minimum.toString() };
    try {
      const result = await context.tx.submit({ label: "fees", to: fees, data: encodeFunctionData({ abi: IODFeesAbi, functionName: "distribute" }) });
      let split: Record<string, string> | undefined;
      for (const log of (result.receipt?.logs ?? []) as Log[]) {
        try {
          const event = decodeEventLog({ abi: IODFeesAbi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
          if (event.eventName === "Distributed") split = Object.fromEntries(Object.entries(event.args as unknown as Record<string, bigint>).map(([k, v]) => [k, v.toString()]));
        } catch { /* not a fees event */ }
      }
      if (split) context.logger.info({ split }, "Fees distributed");
      return { idle: false, distributable: amount.toString(), dryRun: result.simulated, ...(split ? { split } : {}) };
    } catch (error) {
      // Someone else distributed first, or the chain clock differs from ours: a skip, not an error.
      if (revertNameOf(error) === "TooEarly") return { idle: true, reason: "too_early" };
      throw error;
    }
  };
}

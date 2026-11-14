// R14: keeps IODOracleGuard fresh. `poke(market)` is permissionless and the only call that stores lastGood and the halt latch. The
// crank pokes every market on a cadence (5 min; 1 min while a Stock Token has a pending uiMultiplier change; at once after
// each session boundary) and alerts on the guard's reasons. It never applies a multiplier itself, so it cannot apply one twice.
import { encodeFunctionData, hexToString, parseAbi, type Address, type Hex } from "viem";
import { IODOracleGuardAbi } from "../../abi";
import { raiseAlert } from "../alerts";
import type { CrankContext } from "../context";
import { contractAddress } from "../gears";
import { HELD_QUEUE } from "../tx";

export const POKE_EVERY_MS = 5 * 60_000;
export const POKE_NEAR_SPLIT_EVERY_MS = 60_000;
export const ALERT_REASONS = ["SPLIT_PENDING", "CONTINUITY", "HALTED"] as const;
const stockAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)", "function newUIMultiplier() view returns (uint256)", "function effectiveAt() view returns (uint256)",
]);

const reasonName = (reason: Hex): string => (/^0x0*$/.test(reason) ? "" : hexToString(reason, { size: 32 }).replace(/\0+$/g, ""));

export interface PendingChange { symbol: string; token: Address; current: bigint; pending: bigint; effectiveAt: bigint }

/** Stock Tokens with a pending uiMultiplier change (a non-zero `newUIMultiplier` that differs from the live one). */
export async function pendingMultiplierChanges(context: CrankContext): Promise<PendingChange[]> {
  const stocks = context.deployment.markets.filter((m) => m.stockToken);
  if (!stocks.length) return [];
  const reads = await context.clients.stateClient.multicall({
    allowFailure: true,
    contracts: stocks.flatMap((m) => (["uiMultiplier", "newUIMultiplier", "effectiveAt"] as const).map((fn) => ({ address: m.stockToken as Address, abi: stockAbi, functionName: fn }))),
  });
  const out: PendingChange[] = [];
  stocks.forEach((m, i) => {
    const [ui, pending, at] = [reads[i * 3]!, reads[i * 3 + 1]!, reads[i * 3 + 2]!];
    if (ui.status !== "success" || pending.status !== "success") return;
    const next = pending.result as bigint;
    if (next !== 0n && next !== (ui.result as bigint)) out.push({ symbol: m.symbol, token: m.stockToken as Address, current: ui.result as bigint, pending: next, effectiveAt: at.status === "success" ? (at.result as bigint) : 0n });
  });
  return out;
}

export function createPokeJob(context: CrankContext) {
  const guard = contractAddress(context, "ODOracleGuard");
  const lastPoke = new Map<Hex, number>();
  return async (force = false): Promise<Record<string, unknown>> => {
    const nowMs = context.now(await context.metadata()).getTime();
    const pending = await pendingMultiplierChanges(context).catch(() => [] as PendingChange[]);
    const every = pending.length ? POKE_NEAR_SPLIT_EVERY_MS : POKE_EVERY_MS;
    const poked: string[] = [];
    const failed: string[] = [];
    const alerts: string[] = [];
    for (const market of context.deployment.markets) {
      const last = lastPoke.get(market.id);
      if (!force && last !== undefined && nowMs - last < every - 1000) continue;
      try {
        await context.tx.submit({ label: `poke:${market.symbol}`, to: guard, data: encodeFunctionData({ abi: IODOracleGuardAbi, functionName: "poke", args: [market.id] }) });
        lastPoke.set(market.id, nowMs);
        poked.push(market.symbol);
      } catch (error) {
        if (error instanceof Error && HELD_QUEUE.test(error.message)) throw error;
        failed.push(`${market.symbol}: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
        continue;
      }
      const reading = await context.clients.stateClient.readContract({ address: guard, abi: IODOracleGuardAbi, functionName: "read", args: [market.id] }).catch(() => undefined);
      const reason = reading ? reasonName(reading.reason) : "";
      if ((ALERT_REASONS as readonly string[]).includes(reason)) {
        alerts.push(`${reason}:${market.symbol}`);
        await raiseAlert(context, { key: `guard:${reason}:${market.symbol}`, level: reason === "HALTED" ? "critical" : "warn", text: `${market.symbol}: oracle guard reports ${reason}; buys are paused on chain until it clears` }, { quietMs: 30 * 60_000 });
      }
    }
    return { poked: poked.length, pokedMarkets: poked, failed, alerts, pendingMultiplierChanges: pending.map((p) => p.symbol), everyMs: every, forced: force };
  };
}

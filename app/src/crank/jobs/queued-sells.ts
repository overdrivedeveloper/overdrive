// R8 (KEEP-2/3): fills queued sells, bounded. `IODMinter.fillQueued(ticket)` is permissionless and reverts while the gear cannot
// pay (market halted or closed without a price, minimum not met), so each ticket is its own transaction and a failing one
// costs no gas (it fails at the gas estimate and is never broadcast). Open tickets come from the indexer's queued_sells table;
// the chain is the judge.
import { encodeFunctionData } from "viem";
import { IODMinterAbi, IODOracleGuardAbi } from "../../abi";
import { revertNameOf } from "../../chain/revert";
import { safeErrorSummary } from "../../log";
import type { CrankContext } from "../context";
import { chunkedMulticall, contractAddress } from "../gears";
import { HELD_QUEUE } from "../tx";

/** At most this many tickets per seller per gear are tried in a pass, and fewer once one of that seller's tickets on the gear has failed. */
export const PER_SELLER_PER_GEAR = 4;
export const FLAGGED_PER_SELLER_PER_GEAR = 2;
/** Dust tickets (worth under this many USDG, WAD) are filled at most this many per pass, and only with spare capacity. */
export const DUST_PER_PASS = 1;
export const DUST_VALUE_WAD = 10n ** 16n;
/** A failed ticket backs off RETRY_MS, doubling per further miss up to this cap. */
export const MAX_BACKOFF_MS = 6 * 3_600_000;
const SESSION_HALTED = 4;

interface OpenTicket { ticket: string; gear: string; account: string; tokens: string; queued_at: Date | string | null }

async function haltedGears(context: CrankContext): Promise<string[]> {
  const guard = contractAddress(context, "ODOracleGuard");
  const markets = context.deployment.markets;
  if (!markets.length) return [];
  const reads = await context.clients.stateClient.multicall({
    allowFailure: true,
    contracts: markets.map((m) => ({ address: guard, abi: IODOracleGuardAbi, functionName: "read" as const, args: [m.id] as const })),
  });
  const halted = new Set(markets.filter((_, i) => reads[i]?.status === "success" && Number((reads[i] as { result: { session: number } }).result.session) === SESSION_HALTED).map((m) => m.id.toLowerCase()));
  if (!halted.size) return [];
  const rows = await context.sql<{ id: string }[]>`select id from gears where lower(market_a) = any(string_to_array(${[...halted].join(",")}, ','))`;
  return rows.map((r) => r.id);
}

export function createQueuedSellsJob(context: CrankContext, maxPerPass = context.config.CRANK_QUEUE_MAX_PER_PASS) {
  const minter = contractAddress(context, "ODMinter");
  const retryMs = context.config.CRANK_QUEUE_RETRY_MS;
  const retryAt = new Map<string, number>();
  const misses = new Map<string, number>();
  return async (): Promise<Record<string, unknown>> => {
    const nowMs = context.now(await context.metadata()).getTime();
    for (const [ticket, at] of retryAt) if (at <= nowMs) retryAt.delete(ticket);
    const backingOff = [...retryAt.keys()];
    const halted = await haltedGears(context).catch((error: unknown) => {
      context.logger.warn({ err: safeErrorSummary(error) }, "Could not read the market sessions; trying every open ticket this pass");
      return [] as string[];
    });
    const rows = await context.sql<OpenTicket[]>`
      with open as (
        select o.ticket, o.gear, o.account, o.tokens, o.queued_at,
               exists (select 1 from queued_sells f where f.gear = o.gear and f.account = o.account and f.status = 'open'
                         and f.ticket::text = any(string_to_array(${backingOff.join(",")}, ','))) as flagged
        from queued_sells o
        where o.status = 'open' and o.ticket::text <> all(string_to_array(${backingOff.join(",")}, ','))
          and o.gear <> all(string_to_array(${halted.join(",")}, ','))
      ), capped as (
        select *, row_number() over (partition by gear, account order by ticket) as seller_rank from open
      ), kept as (
        select *, row_number() over (partition by gear order by ticket) as rn from capped
        where seller_rank <= case when flagged then ${FLAGGED_PER_SELLER_PER_GEAR}::int else ${PER_SELLER_PER_GEAR}::int end
      )
      select ticket::text as ticket, gear, account, tokens::text as tokens, queued_at from kept
      order by rn, ticket
      limit ${maxPerPass * 8}`;
    // Dust is judged on the chain's own value per token, read once per gear.
    const gearIds = [...new Set(rows.map((r) => r.gear))];
    const values = new Map<string, bigint>();
    if (gearIds.length) {
      const read = await chunkedMulticall(context, gearIds.map((id) => ({ address: minter, abi: IODMinterAbi, functionName: "valuePerToken", args: [id] }))).catch(() => [] as unknown[]);
      gearIds.forEach((id, i) => { const v = read[i] as readonly [bigint, boolean] | undefined; if (v) values.set(id, v[0]); });
    }
    const isDust = (row: OpenTicket) => (BigInt(row.tokens) * (values.get(row.gear) ?? 0n)) / 10n ** 18n < DUST_VALUE_WAD && values.has(row.gear);
    const real = rows.filter((r) => !isDust(r)).slice(0, maxPerPass);
    const dust = rows.filter(isDust).slice(0, Math.min(maxPerPass - real.length, DUST_PER_PASS));
    const batch = [...real, ...dust];

    let filled = 0;
    let simulated = false;
    const failed: { ticket: string; error: string }[] = [];
    let belowMinimum = 0;
    for (const { ticket } of batch) {
      try {
        const result = await context.tx.submit({ label: "queued-sells", to: minter, data: encodeFunctionData({ abi: IODMinterAbi, functionName: "fillQueued", args: [BigInt(ticket)] }) });
        simulated ||= result.simulated;
        filled++;
        retryAt.delete(ticket);
        misses.delete(ticket);
      } catch (error) {
        const summary = safeErrorSummary(error);
        // A held nonce or a missing signer is not the ticket's fault: stop and let the scheduler retry the whole pass.
        if (HELD_QUEUE.test(summary.message)) throw error;
        // Whatever the reason, it is this ticket's: it backs off alone, 10 minutes doubling to 6 hours.
        const n = (misses.get(ticket) ?? 0) + 1;
        misses.set(ticket, n);
        retryAt.set(ticket, nowMs + Math.min(MAX_BACKOFF_MS, retryMs * 2 ** (n - 1)));
        if (revertNameOf(error) === "Slippage") belowMinimum++;
        failed.push({ ticket, error: summary.message.slice(0, 160) });
      }
    }
    if (misses.size > 10_000) for (const ticket of misses.keys()) if (!retryAt.has(ticket)) misses.delete(ticket);
    if (failed.length) context.logger.info({ failed: failed.length, first: failed[0] }, "Queued sells not fillable yet; retried later");
    const oldestRows = await context.sql<{ oldest: Date | string | null }[]>`select min(queued_at) as oldest from queued_sells where status = 'open'`;
    const oldest = oldestRows?.[0]?.oldest ? new Date(oldestRows[0].oldest).getTime() : undefined;
    return {
      candidates: rows.length, attempted: batch.length, filled, notFillable: failed.length, belowMinimum, deferred: Math.max(0, rows.length - batch.length),
      dust: dust.length, oldestOpenMinutes: oldest ? Math.floor((nowMs - oldest) / 60_000) : 0, dryRun: simulated,
    };
  };
}

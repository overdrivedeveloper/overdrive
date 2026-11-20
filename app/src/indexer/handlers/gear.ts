import { toBigInt, WAD } from "../../lib/fixed";
import type { ChainEvent, IndexerContext } from "../types";
import { asAddress, asNumber, gearStatusName, ZERO_BYTES32 } from "../units";
import { addr, big, id32, iso, recordEntity } from "./common";
import { applyEntity } from "./entities";
import { pairVolKey } from "../../db/queries/gears";
import { staleRecordMessage } from "../../lib/gear-catalog";

const SECONDS_PER_YEAR = 31_536_000n;

/** Records an entity change and applies it once (a replay of the same log is a no-op). */
async function change(context: IndexerContext, event: ChainEvent, scope: string, ref: string, kind: string, data: Record<string, unknown>): Promise<void> {
  if (await recordEntity(context.tx, event, scope, ref, kind, data)) {
    await applyEntity(context.tx, context.deployment, { scope, ref, kind, data, block: event.blockNumber, ts: event.ts });
  }
}
export { change };

export async function handleRegistryEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const id = id32(event, "id");
  context.kinds.add("config");
  if (event.eventName === "GearListed") {
    const marketB = id32(event, "marketB");
    const token = addr(event, "token");
    // GearListed has no cap or spread and listGear emits no GearParamsSet: read them from the registry (P01).
    // A failed read keeps the configured defaults; later GearParamsSet events overwrite in order.
    let params: { capUsdWad: bigint; spreadBps: number } | undefined;
    try { params = await context.readGearParams?.(id as `0x${string}`, event.blockNumber); } catch (error) { context.logger.warn({ err: error, gear: id }, "gear params read failed at listing"); }
    await change(context, event, "gear", id, "listed", {
      marketA: id32(event, "marketA"), marketB: marketB === ZERO_BYTES32 ? null : marketB, gear: asNumber(event.args.gear), token, unitWad: big(event, "unitWad"),
      ...(params ? { capUsdWad: params.capUsdWad.toString(), spreadBps: params.spreadBps } : {}),
    });
    context.gearByToken.set(token, id);
    context.newTokens.push(token);
    if (!context.deployment.gears.some((g) => g.id.toLowerCase() === id)) context.logger.error({ gear: id, token }, staleRecordMessage([id]));
  } else if (event.eventName === "GearParamsSet") {
    await change(context, event, "gear", id, "params", { capUsdWad: big(event, "capUsdWad"), spreadBps: asNumber(event.args.spreadBps) });
  } else if (event.eventName === "GearStatusSet") {
    await change(context, event, "gear", id, "status", { status: gearStatusName(event.args.status) });
  }
}

/** The latest posted sigma (bps) for a market at or before this event, as a WAD fraction, or undefined. */
async function sigmaAt(context: IndexerContext, market: string, event: ChainEvent): Promise<bigint | undefined> {
  const rows = await context.tx<{ sigma_bps: string }[]>`
    SELECT sigma_bps FROM vol_posts WHERE gear_or_underlying = ${market}
      AND (block < ${event.blockNumber.toString()} OR (block = ${event.blockNumber.toString()} AND log_index <= ${event.logIndex}))
    ORDER BY block DESC, log_index DESC LIMIT 1`;
  return rows[0] ? toBigInt(rows[0].sigma_bps) * 10n ** 14n : undefined;
}

/** `Accrued` (minter): nf_history row, then gears.nf recomputed from the latest history row (R14). */
export async function handleAccrued(context: IndexerContext, event: ChainEvent): Promise<void> {
  const gear = id32(event, "gearId");
  const nf = big(event, "nf");
  const toll = BigInt(String(event.args.tollPerSecWad ?? 0n));
  const rows = await context.tx<{ market_a: string; market_b: string | null; power_wad: string }[]>`SELECT market_a, market_b, power_wad FROM gears WHERE id = ${gear}`;
  let sigma: bigint | undefined;
  let usage: string | null = null;
  if (rows[0]) {
    // the minter reads a pair's sigma under the oracle pair key (ODMinterPricing: b == 0 ? a : keccak256(abi.encode(a, b)))
    sigma = await sigmaAt(context, pairVolKey({ marketA: rows[0].market_a, marketB: rows[0].market_b }) ?? rows[0].market_a, event);
    if (sigma !== undefined) {
      // derived: usage = toll - 1/2 p (p - 1) sigma^2 per second (sigma is annualised)
      const p = toBigInt(rows[0].power_wad);
      const variance = (sigma * sigma) / WAD;
      const diffusion = (((p * (p - WAD)) / (2n * WAD)) * variance) / WAD / SECONDS_PER_YEAR;
      usage = (toll - diffusion).toString();
    }
  }
  const inserted = await context.tx`
    INSERT INTO nf_history (gear, ts, block, tx_hash, log_index, nf, toll, toll_value_usd_wad, sigma_hat, usage, session)
    VALUES (${gear}, ${iso(event.ts)}, ${event.blockNumber.toString()}, ${event.txHash}, ${event.logIndex}, ${nf}, ${toll.toString()}, ${big(event, "tollValueUsdWad")},
            ${sigma === undefined ? null : sigma.toString()}, ${usage}, NULL)
    ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING 1`;
  if (inserted.length > 0) await recomputeNf(context.tx, [gear]);
  context.snapshotNeeded = true;
  context.kinds.add("snapshot");
}

/** gears.nf = nf of the latest nf_history row, or 1e18 when there is none (R14). */
export async function recomputeNf(tx: IndexerContext["tx"], gears: readonly string[]): Promise<void> {
  for (const gear of gears) {
    await tx`
      UPDATE gears SET
        nf = COALESCE((SELECT nf FROM nf_history WHERE gear = ${gear} ORDER BY block DESC, log_index DESC LIMIT 1), 1000000000000000000),
        last_accrual = (SELECT ts FROM nf_history WHERE gear = ${gear} ORDER BY block DESC, log_index DESC LIMIT 1)
      WHERE id = ${gear}`;
  }
}

export async function handleSettled(context: IndexerContext, event: ChainEvent): Promise<void> {
  await change(context, event, "gear", id32(event, "gearId"), "status", { status: "retired" });
  context.kinds.add("config");
}

export { asAddress };

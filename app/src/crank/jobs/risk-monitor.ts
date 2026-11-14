// R17 (MON-1): every 60 s calls the permissionless IODGovernor.pokeRisk(markets) and reads the risk metrics twice: from the
// indexed tables and from the contract. A pause is sent only when both agree, CRANK_AUTOPAUSE=1 and the crank key holds
// GUARDIAN_ROLE (default: not granted, so the monitor is alert-only). The only transactions it can send are
// IODGovernor.pokeRisk and IODGovernor.setBuysPaused(true); only the 48 h timelock can unpause (D14).
import { encodeFunctionData, type Address } from "viem";
import { IODGovernorAbi } from "../../abi";
import { raiseAlert } from "../alerts";
import { readJobMeta, saveJobMeta, type CrankContext } from "../context";
import { contractAddress } from "../gears";
import { GUARDIAN_ROLE } from "../startup";
import { HELD_QUEUE } from "../tx";

// Thresholds are constants in code, not settings (a settings change is a code review).
/** Governor share price this far under its 7-day peak, read from the contract (the vault's own price, VAULT-1). */
export const DRAWDOWN_PAUSE_BPS = 2000;
/** The indexed equity must show at least this much of a drop for the contract's number to be believed. */
export const INDEXED_DRAWDOWN_CONFIRM_BPS = 1000;
/** Exit reserve under this share of its floor. */
export const EXIT_RESERVE_MIN_BPS = 5000;
/** The hedger's last good run is older than this. */
export const HEDGER_DOWN_SECONDS = 900;
/** An indexer snapshot older than this is not trusted: indexed metrics cannot confirm anything. */
export const INDEXER_STALE_SECONDS = 1800;
export const PEAK_WINDOW_MS = 7 * 86_400_000;

export interface RiskInputs {
  /** Indexed Governor equity (latest governor_ledger row) and its 7-day peak, WAD. */
  equity: bigint;
  peakEquity: bigint;
  /** Latest exit_reserve_log row, raw USDG. */
  exitReserve: bigint;
  exitReserveFloor: bigint;
  /** The indexer stores no stress number; null means the indexed side cannot confirm it. */
  stressLoss: bigint | null;
  stressBudget: bigint | null;
  hedgerDownSeconds: number | null;
  snapshotAgeSeconds: number;
}
export interface ChainRiskView {
  /** convertToAssets(10 ** decimals): the vault's own share price. NEVER equity divided by totalSupply. */
  sharePrice: bigint;
  peakSharePrice: bigint;
  exitReserve: bigint;
  exitReserveFloor: bigint;
  stressLoss: bigint;
  stressBudget: bigint;
  hedgeStale: boolean;
}
export type RiskTriggerName = "drawdown" | "exit_reserve_low" | "stress_over_budget" | "hedge_stale";
export interface RiskTrigger { name: RiskTriggerName; pausable: boolean; detail: string }

const bps = (peak: bigint, now: bigint): number => (peak > 0n && now < peak ? Number(((peak - now) * 10_000n) / peak) : 0);
const PAUSABLE: Record<RiskTriggerName, boolean> = { drawdown: true, exit_reserve_low: true, stress_over_budget: true, hedge_stale: false };

/** Both views evaluated with the same rules. `triggers` are the ones the CONTRACT view fires; `agreed` fired on both sides;
 * `disagreed` fired on exactly one side (alert only). A stale indexer snapshot fires nothing on the indexed side. */
export function evaluateRisk(inputs: RiskInputs, chainView: ChainRiskView): { triggers: RiskTrigger[]; agreed: RiskTrigger[]; disagreed: RiskTrigger[] } {
  const indexedUsable = inputs.snapshotAgeSeconds <= INDEXER_STALE_SECONDS;
  const chain: Record<RiskTriggerName, string | undefined> = {
    drawdown: bps(chainView.peakSharePrice, chainView.sharePrice) >= DRAWDOWN_PAUSE_BPS ? `share price ${bps(chainView.peakSharePrice, chainView.sharePrice)} bps under its peak` : undefined,
    exit_reserve_low: chainView.exitReserveFloor > 0n && chainView.exitReserve * 10_000n < chainView.exitReserveFloor * BigInt(EXIT_RESERVE_MIN_BPS) ? `exit reserve ${chainView.exitReserve} under ${EXIT_RESERVE_MIN_BPS} bps of the floor ${chainView.exitReserveFloor}` : undefined,
    stress_over_budget: chainView.stressBudget > 0n && chainView.stressLoss > chainView.stressBudget ? `stress loss ${chainView.stressLoss} over budget ${chainView.stressBudget}` : undefined,
    hedge_stale: chainView.hedgeStale ? "the hedge post is stale" : undefined,
  };
  const indexed: Record<RiskTriggerName, string | undefined> = indexedUsable ? {
    drawdown: bps(inputs.peakEquity, inputs.equity) >= INDEXED_DRAWDOWN_CONFIRM_BPS ? `indexed equity ${bps(inputs.peakEquity, inputs.equity)} bps under its peak` : undefined,
    exit_reserve_low: inputs.exitReserveFloor > 0n && inputs.exitReserve * 10_000n < inputs.exitReserveFloor * BigInt(EXIT_RESERVE_MIN_BPS) ? "indexed exit reserve under its floor share" : undefined,
    stress_over_budget: inputs.stressLoss !== null && inputs.stressBudget !== null && inputs.stressBudget > 0n && inputs.stressLoss > inputs.stressBudget ? "indexed stress over budget" : undefined,
    hedge_stale: inputs.hedgerDownSeconds !== null && inputs.hedgerDownSeconds >= HEDGER_DOWN_SECONDS ? `hedger down ${inputs.hedgerDownSeconds} s` : undefined,
  } : { drawdown: undefined, exit_reserve_low: undefined, stress_over_budget: undefined, hedge_stale: undefined };
  const names = Object.keys(PAUSABLE) as RiskTriggerName[];
  const triggers: RiskTrigger[] = [], agreed: RiskTrigger[] = [], disagreed: RiskTrigger[] = [];
  for (const name of names) {
    const c = chain[name], i = indexed[name];
    const trigger = { name, pausable: PAUSABLE[name], detail: c ?? i ?? "" };
    if (c) triggers.push(trigger);
    if (c && i) agreed.push(trigger);
    else if (c || i) disagreed.push(trigger);
  }
  return { triggers, agreed, disagreed };
}

async function readIndexed(context: CrankContext, nowMs: number): Promise<RiskInputs> {
  const ledger = await context.sql<{ equity: string | null; peak: string | null }[]>`
    select (select equity::text from governor_ledger order by ts desc limit 1) as equity,
           (select max(equity)::text from governor_ledger where ts > (select max(ts) from governor_ledger) - interval '7 days') as peak`;
  const reserve = await context.sql<{ balance: string; floor: string }[]>`select balance::text, "floor"::text from exit_reserve_log order by ts desc, block desc limit 1`;
  const status = await context.sql<{ job: string; last_ok: Date | string | null }[]>`select job, last_ok from service_status where job in ('indexer', 'hedger')`;
  const age = (job: string): number | null => {
    const at = status.find((s) => s.job === job)?.last_ok;
    return at ? Math.max(0, Math.floor((nowMs - new Date(at).getTime()) / 1000)) : null;
  };
  const equity = BigInt(ledger[0]?.equity ?? "0");
  return {
    equity, peakEquity: BigInt(ledger[0]?.peak ?? "0"),
    exitReserve: BigInt(reserve[0]?.balance ?? "0"), exitReserveFloor: BigInt(reserve[0]?.floor ?? "0"),
    stressLoss: null, stressBudget: null,
    hedgerDownSeconds: age("hedger"), snapshotAgeSeconds: age("indexer") ?? Number.MAX_SAFE_INTEGER,
  };
}

export function createRiskMonitorJob(context: CrankContext) {
  const governor = contractAddress(context, "ODGovernor");
  let guardianGranted: boolean | undefined;
  async function hasGuardianRole(): Promise<boolean> {
    if (guardianGranted !== undefined) return guardianGranted;
    const account = context.clients.walletClient?.account?.address;
    if (!account) return (guardianGranted = false);
    guardianGranted = await context.clients.stateClient.readContract({
      address: governor, abi: [{ type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] }] as const,
      functionName: "hasRole", args: [GUARDIAN_ROLE, account as Address],
    }).catch(() => false);
    return guardianGranted;
  }
  return async (): Promise<Record<string, unknown>> => {
    const nowMs = context.now(await context.metadata()).getTime();
    // MON-1: poke first, so the contract's stress and equity numbers are current for the reads below.
    try {
      await context.tx.submit({ label: "risk-monitor:poke", to: governor, data: encodeFunctionData({ abi: IODGovernorAbi, functionName: "pokeRisk", args: [context.deployment.markets.map((m) => m.id)] }) });
    } catch (error) {
      if (error instanceof Error && HELD_QUEUE.test(error.message)) throw error;
      context.logger.warn({ err: error instanceof Error ? error.message.slice(0, 160) : "error" }, "pokeRisk failed; reading the current numbers anyway");
    }
    const read = <T,>(functionName: string, args: readonly unknown[] = []) => context.clients.stateClient.readContract({ address: governor, abi: IODGovernorAbi, functionName, args } as never) as Promise<T>;
    const decimals = await read<number>("decimals");
    const [sharePrice, exitReserve, exitReserveFloor, stress, hedgeStale, paused] = await Promise.all([
      read<bigint>("convertToAssets", [10n ** BigInt(decimals)]), read<bigint>("exitReserve"), read<bigint>("exitReserveFloor"),
      read<readonly [bigint, bigint]>("stressLoss"), read<boolean>("hedgeStale"), read<readonly [boolean, string]>("buysPaused"),
    ]);
    const meta = await readJobMeta(context, "risk-monitor");
    let peak = typeof meta.peakSharePrice === "string" ? BigInt(meta.peakSharePrice) : sharePrice;
    let newPeakAt = typeof meta.peakAt === "number" ? meta.peakAt : nowMs;
    // The peak is the highest share price read in the last 7 days; it resets when it ages out.
    if (sharePrice >= peak || nowMs - newPeakAt > PEAK_WINDOW_MS) { peak = sharePrice; newPeakAt = nowMs; }
    const chainView: ChainRiskView = { sharePrice, peakSharePrice: peak, exitReserve, exitReserveFloor, stressLoss: stress[0], stressBudget: stress[1], hedgeStale };
    const inputs = await readIndexed(context, nowMs);
    const result = evaluateRisk(inputs, chainView);
    await saveJobMeta(context, "risk-monitor", { peakSharePrice: peak.toString(), peakAt: newPeakAt });
    // Every input is logged, every pass.
    context.logger.info({ inputs: { ...inputs, equity: inputs.equity.toString(), peakEquity: inputs.peakEquity.toString(), exitReserve: inputs.exitReserve.toString(), exitReserveFloor: inputs.exitReserveFloor.toString() },
      chain: Object.fromEntries(Object.entries(chainView).map(([k, v]) => [k, String(v)])), agreed: result.agreed.map((t) => t.name), disagreed: result.disagreed.map((t) => t.name) }, "Risk monitor inputs");
    for (const t of result.disagreed) {
      await raiseAlert(context, { key: `risk:disagree:${t.name}`, level: "warn", text: `Risk monitor: ${t.name} fires on one view only (${t.detail}); not pausing` }, { quietMs: 1_800_000 });
    }
    const pausable = result.agreed.filter((t) => t.pausable);
    for (const t of result.agreed.filter((x) => !x.pausable)) {
      await raiseAlert(context, { key: `risk:${t.name}`, level: "warn", text: `Risk monitor: ${t.name} (${t.detail})` }, { quietMs: 1_800_000 });
    }
    let pausedNow = false;
    if (pausable.length) {
      const canPause = context.config.CRANK_AUTOPAUSE && (await hasGuardianRole());
      const names = pausable.map((t) => t.name).join(", ");
      if (canPause && !paused[0]) {
        const sent = await context.tx.submit({ label: "risk-monitor:pause", to: governor, data: encodeFunctionData({ abi: IODGovernorAbi, functionName: "setBuysPaused", args: [true] }) });
        pausedNow = true;
        await context.sql`insert into pause_log (ts, block, tx_hash, log_index, scope, ref, action, actor, reason)
          values (${new Date(nowMs).toISOString()}::timestamptz, ${sent.receipt?.blockNumber?.toString() ?? "0"}, ${sent.hash ?? `simulated:${nowMs}`}, -1, 'global', null, 'pause', ${context.clients.walletClient?.account?.address ?? null}, ${`crank risk monitor: ${names}`})
          on conflict do nothing`;
        await raiseAlert(context, { key: `risk:paused:${names}`, level: "critical", text: `Buys PAUSED by the crank risk monitor (${names}): ${pausable.map((t) => t.detail).join("; ")}. Sells stay open. Only the 48 h timelock can unpause.` }, { quietMs: 0 });
      } else {
        await raiseAlert(context, { key: `risk:would-pause:${names}`, level: "critical", text: `Risk monitor: ${names} confirmed by both views (${pausable.map((t) => t.detail).join("; ")}). ${paused[0] ? "Buys are already paused." : "Not pausing: autopause is off or the crank holds no guardian role."} Only the 48 h timelock can unpause.` }, { quietMs: 600_000 });
      }
    }
    return { agreed: result.agreed.map((t) => t.name), disagreed: result.disagreed.map((t) => t.name), triggers: result.triggers.map((t) => t.name), paused: pausedNow, sharePrice: sharePrice.toString(), peakSharePrice: peak.toString() };
  };
}

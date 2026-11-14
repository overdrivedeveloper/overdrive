// Verification and batch planning (R3, R5, R9, R10). Every candidate is re-read on chain in ONE multicall (vault, health, the
// gear's markets, the oracle reading and the weekend uplift of each market) right before a seal; only vaults the chain still calls
// liquidatable enter a plan. The only calls this service ever builds are IODBacker.sealBatch and IODBacker.executeBatch.
import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { IODBackerAbi, IODGearRegistryAbi, IODOracleGuardAbi } from "../abi";
import type { ServiceClients } from "../chain/clients";
import { safeErrorSummary } from "../log";
import { expectedBonusUsdg } from "./economics";
import { healthConsistent, healthFromTuple, isLiquidatable } from "./health";
import { combinedDecision } from "./policy";
import type { BatchPlan, Candidate, HealthView, PriceReading, VaultView, Verified } from "./types";

export type { BatchPlan } from "./types";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export interface LiquidatorAddresses { backer: Address; oracleGuard: Address; gearRegistry: Address }

export function liquidatorAddresses(contracts: Record<string, string>): LiquidatorAddresses {
  const need = (name: string): Address => {
    const a = contracts[name];
    if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`deployment has no ${name} address`);
    return getAddress(a);
  };
  return { backer: need("ODBacker"), oracleGuard: need("ODOracleGuard"), gearRegistry: need("ODGearRegistry") };
}

type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };

/** One multicall for the whole candidate set. A failing read marks only its own vault (R9). Candidates without a market hint get
 * their markets from a registry read first (the gears table had no row yet). */
export async function verifyOnChain(clients: Pick<ServiceClients, "stateClient">, c: readonly Candidate[], addresses: LiquidatorAddresses): Promise<Verified[]> {
  if (!c.length) return [];
  const client = clients.stateClient;
  const missing = [...new Set(c.filter((x) => !x.marketA).map((x) => x.gearId))];
  const hinted = new Map<string, Hex[]>();
  if (missing.length) {
    const res = (await client.multicall({ allowFailure: true, contracts: missing.map((id) => ({ address: addresses.gearRegistry, abi: IODGearRegistryAbi, functionName: "gear", args: [id] })) } as never)) as CallResult[];
    res.forEach((r, i) => {
      if (r.status === "success") hinted.set(missing[i]!.toLowerCase(), marketsOf(r.result));
    });
  }
  const marketsHint = (x: Candidate): Hex[] => (x.marketA ? [x.marketA, ...(x.marketB ? [x.marketB] : [])] : hinted.get(x.gearId.toLowerCase()) ?? []);
  const gears = [...new Set(c.map((x) => x.gearId.toLowerCase()))] as Hex[];
  const markets = [...new Set(c.flatMap((x) => marketsHint(x).map((m) => m.toLowerCase())))] as Hex[];

  const calls: unknown[] = [];
  for (const x of c) {
    calls.push({ address: addresses.backer, abi: IODBackerAbi, functionName: "vault", args: [x.vaultId] });
    calls.push({ address: addresses.backer, abi: IODBackerAbi, functionName: "health", args: [x.vaultId] });
  }
  for (const g of gears) calls.push({ address: addresses.gearRegistry, abi: IODGearRegistryAbi, functionName: "gear", args: [g] });
  for (const m of markets) {
    calls.push({ address: addresses.oracleGuard, abi: IODOracleGuardAbi, functionName: "read", args: [m] });
    calls.push({ address: addresses.backer, abi: IODBackerAbi, functionName: "upliftActive", args: [m] });
  }
  const results = (await client.multicall({ allowFailure: true, contracts: calls } as never)) as CallResult[];
  const at = (i: number): CallResult => results[i] ?? { status: "failure", error: new Error("missing multicall result") };
  const base = c.length * 2;
  const gearMarkets = new Map<string, Hex[] | undefined>();
  gears.forEach((g, i) => { const r = at(base + i); gearMarkets.set(g, r.status === "success" ? marketsOf(r.result) : undefined); });
  const mBase = base + gears.length;
  const readings = new Map<string, { reading?: PriceReading; upliftOk: boolean; error?: string }>();
  markets.forEach((m, i) => {
    const r = at(mBase + 2 * i), u = at(mBase + 2 * i + 1);
    readings.set(m, {
      ...(r.status === "success" ? { reading: readingOf(r.result) } : { error: safeErrorSummary(r.error).message }),
      upliftOk: u.status === "success" && upliftOf(u.result) !== undefined,
    });
  });

  return c.map((x, i): Verified => {
    const out = (verdict: Verified["verdict"], reason?: string, extra: Partial<Verified> = {}): Verified =>
      ({ vaultId: x.vaultId, gearId: x.gearId, verdict, ...(reason ? { reason } : {}), ...extra });
    try {
      const v = at(2 * i), h = at(2 * i + 1);
      if (v.status !== "success") return out("read_failed", `vault(): ${safeErrorSummary(v.error).message}`);
      if (h.status !== "success") return out("read_failed", `health(): ${safeErrorSummary(h.error).message}`);
      const vault = vaultOf(x.vaultId, v.result);
      const health = healthFromTuple(h.result as [bigint, bigint, bigint, bigint, bigint]);
      const extra: Partial<Verified> = { vault, health };
      if (vault.owner === zeroAddress) return out("malformed", "vault has no owner", extra);
      if (!same(vault.gearId, x.gearId)) return out("gear_mismatch", `chain gear ${vault.gearId}`, extra);
      if (vault.debtTokens === 0n) return out("no_debt", undefined, extra);
      if (vault.batchId !== 0n) return out("in_batch", `batch ${vault.batchId}`, extra);
      if (!healthConsistent(health)) return out("malformed", "health() tuple is inconsistent", extra);
      const chainMarkets = gearMarkets.get(x.gearId.toLowerCase());
      if (!chainMarkets) return out("read_failed", "gear(): unreadable", extra);
      const hint = marketsHint(x).map((m) => m.toLowerCase());
      if (chainMarkets.length !== hint.length || chainMarkets.some((m, k) => !same(m, hint[k]))) return out("read_failed", "gear markets differ from the index", extra);
      const reads = chainMarkets.map((m) => readings.get(m.toLowerCase()));
      const failed = reads.find((r) => !r?.reading);
      if (failed) return out("read_failed", `oracle read(): ${failed?.error ?? "missing"}`, extra);
      if (reads.some((r) => !r!.upliftOk)) return out("uplift_unreadable", "upliftActive() unreadable", extra);
      const decision = combinedDecision(reads.map((r) => r!.reading!));
      const more = { ...extra, markets: chainMarkets, closedMarket: decision.closed };
      if (!decision.ok) return out(decision.verdict ?? "stale", decision.reason, more);
      // Open or closed, the verdict is the contract's own health() at the price it holds: no off-chain price is ever used (R4).
      return isLiquidatable(health) ? out("liquidatable", undefined, more) : out("recovered", `ratio ${health.ratioBps} >= maintenance ${health.maintenanceBps}`, more);
    } catch (error) {
      return out("malformed", safeErrorSummary(error).message);
    }
  });
}

function marketsOf(result: unknown): Hex[] {
  const g = result as { marketA: Hex; marketB: Hex };
  if (!g || !/^0x[0-9a-fA-F]{64}$/.test(g.marketA)) throw new Error("gear() returned no market");
  return [g.marketA.toLowerCase() as Hex, ...(g.marketB && !same(g.marketB, ZERO32) ? [g.marketB.toLowerCase() as Hex] : [])];
}

function readingOf(result: unknown): PriceReading {
  const r = result as PriceReading;
  return { p: BigInt(r.p), refP: BigInt(r.refP), session: Number(r.session), fresh: Boolean(r.fresh), buysPaused: Boolean(r.buysPaused), reason: r.reason, updatedAt: BigInt(r.updatedAt) };
}

function upliftOf(result: unknown): { active: boolean; bps: number } | undefined {
  if (!Array.isArray(result) || result.length < 2) return undefined;
  return { active: Boolean(result[0]), bps: Number(result[1]) };
}

function vaultOf(vaultId: bigint, result: unknown): VaultView {
  const t = result as readonly [Address, Hex, bigint, bigint, bigint];
  if (!Array.isArray(t) || t.length < 5) throw new Error("vault() returned a malformed tuple");
  return { vaultId, owner: t[0], gearId: t[1], collateralUsdg: BigInt(t[2]), debtTokens: BigInt(t[3]), batchId: BigInt(t[4]) };
}

/** Rough gas of sealing and executing n vaults, used to bound a plan before the live estimate replaces it. */
export const PLAN_GAS_BASE = 160_000n;
export const PLAN_GAS_PER_VAULT = 120_000n;

/** Only vaults with a `vault()` view, nonzero debt, no batch, and a liquidatable chain verdict (R5). */
export function isOpenLiquidatable(v: Verified): v is Verified & { vault: VaultView; health: HealthView } {
  return v.verdict === "liquidatable" && !!v.vault && !!v.health && v.vault.debtTokens > 0n && v.vault.batchId === 0n && same(v.vault.gearId, v.gearId) && isLiquidatable(v.health);
}

/** One plan per gear, worst health first, each bounded by vault count and gas (R10). Plans are ordered by their worst vault. */
export function buildPlans(v: readonly Verified[], caps: { maxVaults: number; gasBudget: bigint }): BatchPlan[] {
  const ok = v.filter(isOpenLiquidatable).sort((a, b) => (a.health.ratioBps < b.health.ratioBps ? -1 : a.health.ratioBps > b.health.ratioBps ? 1 : a.vaultId < b.vaultId ? -1 : 1));
  const byGear = new Map<string, (typeof ok)[number][]>();
  for (const x of ok) {
    const key = x.vault.gearId.toLowerCase();
    const list = byGear.get(key) ?? [];
    list.push(x);
    byGear.set(key, list);
  }
  const plans: BatchPlan[] = [];
  for (const list of byGear.values()) {
    const maxByGas = caps.gasBudget <= PLAN_GAS_BASE ? 0 : Number((caps.gasBudget - PLAN_GAS_BASE) / PLAN_GAS_PER_VAULT);
    const take = list.slice(0, Math.max(0, Math.min(caps.maxVaults, maxByGas)));
    if (!take.length) continue;
    plans.push({
      gearId: take[0]!.vault.gearId,
      vaultIds: take.map((x) => x.vaultId),
      expectedBonusUsdg: take.reduce((s, x) => s + expectedBonusUsdg(x.health), 0n),
      gasEstimate: PLAN_GAS_BASE + PLAN_GAS_PER_VAULT * BigInt(take.length),
    });
  }
  return plans;
}

// ------------------------------------------------------------------------------------------------- the only calls we build
export const encodeSeal = (gearId: Hex, vaultIds: readonly bigint[]): Hex => encodeFunctionData({ abi: IODBackerAbi, functionName: "sealBatch", args: [gearId, [...vaultIds]] });
export const encodeExecute = (batchId: bigint): Hex => encodeFunctionData({ abi: IODBackerAbi, functionName: "executeBatch", args: [batchId] });

/** Decodes a transaction before it is sent: the target must be IODBacker and the call sealBatch or executeBatch (R5). */
export function assertLiquidatorCall(to: Address, data: Hex, backer: Address): { name: "sealBatch" | "executeBatch"; args: readonly unknown[] } {
  if (!same(to, backer)) throw new Error(`liquidator refuses a call to ${to}: only IODBacker`);
  const decoded = decodeFunctionData({ abi: IODBackerAbi, data });
  if (decoded.functionName !== "sealBatch" && decoded.functionName !== "executeBatch") throw new Error(`liquidator refuses ${decoded.functionName}`);
  return { name: decoded.functionName, args: decoded.args ?? [] };
}

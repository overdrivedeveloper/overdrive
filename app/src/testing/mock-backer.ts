// A stand-in for ODBacker (todo 07 is not built yet) on top of the shared FakeChain, built to the real IODBacker ABI. Its health()
// is an INDEPENDENT integer implementation (cross-multiplied, never calling liquidator/health.ts), so the parity test compares two
// codes. Thresholds per gear group (RACE 250/200, others 200/150) plus the weekend uplift live only here, in the test double.
// Bonus model (until 07 lands): seized = min(collateral, ceil(debtUsdg * 10000 / 9500)), bonus = floor(5% of seized),
// bad debt = max(0, debtUsdg - (seized - bonus)), drawn from ODInsurance (Covered event).
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, maxUint256, toHex, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { IODBackerAbi, IODInsuranceAbi } from "../abi";
import { RevertError } from "../chain/revert";
import type { ServiceClients } from "../chain/clients";
import type { Sql } from "postgres";
import { FakeChain, MARKET_ETH, MARKET_NVDA, MARKET_TSLA, WAD } from "./mock-chain";

export interface MockVault { owner: Address; gearId: Hex; collateralUsdg: bigint; debtTokens: bigint; batchId: bigint }
export interface MockGear { id: Hex; marketA: Hex; marketB: Hex; race: boolean; valueWad: bigint; token: Address }
export interface MockBatch { batchId: bigint; gearId: Hex; vaultIds: bigint[]; sealedValueWad: bigint; sealedAt: bigint; status: "sealed" | "executed" | "voided" }
export interface MockLog { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; logIndex: number; transactionHash: Hex }

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const USDG_TO_WAD = 10n ** 12n;
const rev = (name: string, args: unknown[] = []): never => { throw new RevertError({ name, args, signature: "0x" }, undefined); };
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export class MockBacker {
  vaults = new Map<bigint, MockVault>();
  gears = new Map<Hex, MockGear>();
  batches = new Map<bigint, MockBatch>();
  /** Weekend uplift per market, in basis points (0 = off). */
  uplift = new Map<Hex, number>();
  logs: MockLog[] = [];
  block = 10n;
  nextBatch = 1n;
  nextVault = 1n;
  readyDelay = 60n;
  window = 900n;
  insuranceBalance = 1_000_000_000_000n;
  /** Holder balances of gear tokens: nothing in the liquidator may ever change them. */
  holders = new Map<string, bigint>();
  /** Next executeBatch voids the batch with this reason instead of liquidating. */
  voidNext: string | undefined;
  /** Counts of reads per function, for "read from the chain on every pass" assertions. */
  readCount = new Map<string, number>();

  constructor(public chain: FakeChain = new FakeChain()) {
    const r = chain.readers;
    const count = (name: string) => this.readCount.set(name, (this.readCount.get(name) ?? 0) + 1);
    r.set("ODBacker.vault", ([id]) => { count("vault"); const v = this.vaults.get(id as bigint); return v ? [v.owner, v.gearId, v.collateralUsdg, v.debtTokens, this.liveBatch(v)] : [zeroAddress, ZERO32, 0n, 0n, 0n]; });
    r.set("ODBacker.health", ([id]) => { count("health"); return this.health(id as bigint); });
    r.set("ODBacker.upliftActive", ([m]) => { count("upliftActive"); const bps = this.uplift.get(m as Hex) ?? 0; return [bps > 0, bps]; });
    r.set("ODGearRegistry.gear", ([id]) => {
      const g = this.gears.get(id as Hex);
      if (!g) rev("UnknownGear", [id]);
      return { marketA: g!.marketA, marketB: g!.marketB, gear: g!.race ? 2 : 1, token: g!.token, p0: WAD, unitWad: WAD, capUsdWad: WAD, spreadBps: 30, collateralBps: g!.race ? 25000 : 20000, maintenanceBps: g!.race ? 20000 : 15000, status: 1, listedAt: 1n };
    });
    chain.mutators.set("ODBacker.sealBatch", (args, commit) => this.seal(args[0] as Hex, args[1] as bigint[], commit));
    chain.mutators.set("ODBacker.executeBatch", (args, commit) => this.executeBatch(args[0] as bigint, commit, true));
  }

  addGear(id: Hex, marketA: Hex, opts: { race?: boolean; valueWad?: bigint; marketB?: Hex } = {}): MockGear {
    const g: MockGear = { id, marketA, marketB: opts.marketB ?? ZERO32, race: opts.race ?? false, valueWad: opts.valueWad ?? WAD, token: getAddress(`0x${keccak256(toHex(`gear-token-${id}`)).slice(26)}`) };
    this.gears.set(id, g);
    return g;
  }
  openVault(gearId: Hex, collateralUsdg: bigint, debtTokens: bigint, owner?: Address): bigint {
    const id = this.nextVault++;
    this.vaults.set(id, { owner: owner ?? getAddress(`0x${keccak256(toHex(`backer-${id}`)).slice(26)}`), gearId, collateralUsdg, debtTokens, batchId: 0n });
    return id;
  }

  /** A vault's batch, or 0 once that batch expired unexecuted (the vault is free to be sealed again). */
  liveBatch(v: MockVault): bigint {
    const b = this.batches.get(v.batchId);
    if (!b || b.status !== "sealed") return 0n;
    return this.chain.nowSeconds > b.sealedAt + this.readyDelay + this.window ? 0n : v.batchId;
  }

  // ------------------------------------------------------------------------------------------- the independent health()
  thresholds(gearId: Hex): { required: bigint; maintenance: bigint } {
    const g = this.gears.get(gearId)!;
    const uplift = BigInt(Math.max(this.uplift.get(g.marketA) ?? 0, g.marketB === ZERO32 ? 0 : this.uplift.get(g.marketB) ?? 0));
    return { required: (g.race ? 25_000n : 20_000n) + uplift, maintenance: (g.race ? 20_000n : 15_000n) + uplift };
  }
  debtValueWad(v: MockVault, valueWad?: bigint): bigint { return (v.debtTokens * (valueWad ?? this.gears.get(v.gearId)!.valueWad)) / WAD; }
  health(id: bigint): [bigint, bigint, bigint, bigint, bigint] {
    const v = this.vaults.get(id);
    if (!v) return [0n, 0n, maxUint256, 0n, 0n];
    const debt = this.debtValueWad(v);
    const { required, maintenance } = this.thresholds(v.gearId);
    const ratio = debt === 0n ? maxUint256 : (v.collateralUsdg * USDG_TO_WAD * 10_000n) / debt;
    return [v.collateralUsdg, debt, ratio, required, maintenance];
  }
  /** Cross-multiplied liquidation test: collateral * 1e16 < maintenance * debt. */
  liquidatableAt(id: bigint, valueWad?: bigint): boolean {
    const v = this.vaults.get(id)!;
    const debt = this.debtValueWad(v, valueWad);
    return debt > 0n && v.collateralUsdg * USDG_TO_WAD * 10_000n < this.thresholds(v.gearId).maintenance * debt;
  }

  // ----------------------------------------------------------------------------------------------------- writes
  private emit(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>, commitToReceipt: boolean): void {
    const event = (abi as readonly { type: string; name?: string; inputs?: { name: string; type: string; indexed?: boolean }[] }[]).find((e) => e.type === "event" && e.name === eventName)!;
    const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
    const nonIndexed = event.inputs!.filter((i) => !i.indexed);
    const data = encodeAbiParameters(nonIndexed as never, nonIndexed.map((i) => args[i.name]) as never);
    const log: MockLog = { address, topics, data, blockNumber: this.block, logIndex: this.logs.length, transactionHash: keccak256(toHex(`tx-${this.block}`)) };
    this.logs.push(log);
    if (commitToReceipt) this.chain.pendingLogs.push({ address, topics, data });
  }
  private get backer(): Address { return this.chain.deployment.contracts.ODBacker as Address; }
  private get insurance(): Address { return this.chain.deployment.contracts.ODInsurance as Address; }

  seal(gearId: Hex, ids: readonly bigint[], commit: boolean): bigint {
    if (!ids.length) rev("EmptyBatch");
    if (!this.gears.has(gearId)) rev("NotBackable", [gearId]);
    for (const id of ids) {
      const v = this.vaults.get(id);
      if (!v || v.gearId.toLowerCase() !== gearId.toLowerCase()) rev("Healthy", [id]);
      if (this.liveBatch(v!) !== 0n) rev("InBatch", [id]);
      if (!this.liquidatableAt(id)) rev("Healthy", [id]);
    }
    if (commit) {
      this.block++;
      const batchId = this.nextBatch++;
      const g = this.gears.get(gearId)!;
      for (const id of ids) this.vaults.get(id)!.batchId = batchId;
      this.batches.set(batchId, { batchId, gearId, vaultIds: [...ids], sealedValueWad: g.valueWad, sealedAt: this.chain.nowSeconds, status: "sealed" });
      this.emit(IODBackerAbi as Abi, this.backer, "BatchSealed", { batchId, gearId, sealedValueWad: g.valueWad, sealedAt: this.chain.nowSeconds, vaultIds: [...ids] }, true);
    }
    return 80_000n + 30_000n * BigInt(ids.length);
  }

  executeBatch(batchId: bigint, commit: boolean, toReceipt: boolean): bigint {
    const b = this.batches.get(batchId);
    if (!b || b.status !== "sealed") rev("BatchExpired");
    const readyAt = b!.sealedAt + this.readyDelay;
    if (this.chain.nowSeconds < readyAt) rev("BatchNotReady", [readyAt]);
    if (this.chain.nowSeconds > readyAt + this.window) rev("BatchExpired");
    if (!commit) return 60_000n + 50_000n * BigInt(b!.vaultIds.length);
    this.block++;
    if (this.voidNext) {
      b!.status = "voided";
      for (const id of b!.vaultIds) this.vaults.get(id)!.batchId = 0n;
      this.emit(IODBackerAbi as Abi, this.backer, "BatchVoided", { batchId, reason: toHex(this.voidNext, { size: 32 }) }, toReceipt);
      this.voidNext = undefined;
      return 60_000n;
    }
    let badTotal = 0n;
    for (const id of b!.vaultIds) {
      const v = this.vaults.get(id)!;
      v.batchId = 0n;
      // The seal fixed the price: a later wick (either way) does not change what is liquidated; a topped-up vault is skipped.
      if (!this.liquidatableAt(id, b!.sealedValueWad)) continue;
      const debtUsdg = ceilDiv(this.debtValueWad(v, b!.sealedValueWad), USDG_TO_WAD);
      const want = ceilDiv(debtUsdg * 10_000n, 9_500n);
      const seized = want < v.collateralUsdg ? want : v.collateralUsdg;
      const bonus = (seized * 500n) / 10_000n;
      const covered = seized - bonus;
      const bad = debtUsdg > covered ? debtUsdg - covered : 0n;
      badTotal += bad;
      const debtTokens = v.debtTokens;
      v.collateralUsdg -= seized;
      v.debtTokens = 0n;
      this.emit(IODBackerAbi as Abi, this.backer, "Liquidated", { batchId, vaultId: id, debtTokens, collateralSeized: seized, bonusUsdg: bonus, badDebtUsdg: bad }, toReceipt);
    }
    if (badTotal > 0n) {
      const sent = badTotal < this.insuranceBalance ? badTotal : this.insuranceBalance;
      this.insuranceBalance -= sent;
      this.emit(IODInsuranceAbi as Abi, this.insurance, "Covered", { to: this.backer, requested: badTotal, sent }, toReceipt);
    }
    b!.status = "executed";
    return 60_000n + 50_000n * BigInt(b!.vaultIds.length);
  }

  /** Another liquidator (anyone can call) executes the batch first; its logs are on chain but not in our receipt. */
  executeAsOther(batchId: bigint): void { this.executeBatch(batchId, true, false); }
  /** Another liquidator seals a batch (it reaches us only through events). */
  sealAsOther(gearId: Hex, ids: readonly bigint[]): bigint {
    const before = this.chain.pendingLogs.length;
    this.seal(gearId, ids, true);
    this.chain.pendingLogs.splice(before);
    return this.nextBatch - 1n;
  }

  getLogs(params: { address?: Address | Address[]; fromBlock?: bigint; toBlock?: bigint }): MockLog[] {
    const addresses = params.address === undefined ? undefined : (Array.isArray(params.address) ? params.address : [params.address]).map((a) => a.toLowerCase());
    return this.logs.filter((l) => (!addresses || addresses.includes(l.address.toLowerCase()))
      && (params.fromBlock === undefined || l.blockNumber >= params.fromBlock) && (params.toBlock === undefined || l.blockNumber <= params.toBlock));
  }

  /** FakeChain clients plus getLogs / getBlockNumber / getBlock tied to this backer's block height and the chain clock. */
  clients(account?: unknown): ServiceClients {
    const base = this.chain.clients(account) as unknown as Record<string, Record<string, unknown>>;
    const self = this;
    const extend = (c: Record<string, unknown>) => ({
      ...c,
      getLogs: async (p: { address?: Address | Address[]; fromBlock?: bigint; toBlock?: bigint }) => self.getLogs(p),
      getBlockNumber: async () => self.block,
      getBlock: async () => ({ number: self.block, timestamp: self.chain.nowSeconds, gasLimit: self.chain.blockGasLimit, baseFeePerGas: 1_000_000n, hash: "0x01" }),
      getGasPrice: async () => self.gasPriceWei,
    });
    return { ...base, logsClient: extend(base.logsClient!), stateClient: extend(base.stateClient!), txClient: extend(base.txClient!) } as unknown as ServiceClients;
  }
  gasPriceWei = 1_000_000n;
}

// ------------------------------------------------------------------------------------------------------ test world

export const GEAR_TSLA = keccak256(toHex("gear-tsla-sport"));
export const GEAR_NVDA_RACE = keccak256(toHex("gear-nvda-race"));
export const LIQUIDATOR_ACCOUNT = getAddress(`0x${keccak256(toHex("liquidator-account")).slice(26)}`);

/** A chain with TSLA, NVDA and ETH priced (ETH at 3000 for gas costing), a TSLA Sport gear and an NVDA Race gear. */
export function liquidationWorld(): { chain: FakeChain; backer: MockBacker } {
  const chain = new FakeChain();
  chain.addMarketPrice(MARKET_TSLA);
  chain.addMarketPrice(MARKET_NVDA);
  chain.addMarketPrice(MARKET_ETH, { p: 3000n * WAD, refP: 3000n * WAD });
  const backer = new MockBacker(chain);
  backer.addGear(GEAR_TSLA, MARKET_TSLA);
  backer.addGear(GEAR_NVDA_RACE, MARKET_NVDA, { race: true });
  return { chain, backer };
}

/** Writes the mock's gears and vaults into gears / backer_vaults the way the indexer would (health left null, as 13b does). */
export async function indexVaults(sql: Sql, backer: MockBacker, opts: { status?: (id: bigint) => string } = {}): Promise<void> {
  for (const g of backer.gears.values()) {
    await sql`insert into gears (id, market_a, market_b, underlying, power, power_wad, token, cap_usd, spread_bps, status)
      values (${g.id}, ${g.marketA}, ${g.marketB === ZERO32 ? null : g.marketB}, 'X', 2, ${(2n * WAD).toString()}, ${g.token.toLowerCase()}, 0, 30, 'active')
      on conflict (id) do nothing`;
  }
  for (const [id, v] of backer.vaults) {
    await sql`insert into backer_vaults (id, owner, gear, collateral, debt_tokens, status)
      values (${id.toString()}, ${v.owner.toLowerCase()}, ${v.gearId}, ${v.collateralUsdg.toString()}, ${v.debtTokens.toString()}, ${opts.status?.(id) ?? "open"})
      on conflict (id) do update set collateral = excluded.collateral, debt_tokens = excluded.debt_tokens, status = excluded.status`;
  }
}

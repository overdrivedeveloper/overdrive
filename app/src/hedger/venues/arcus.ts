// Arcus venue (R15). The adapter speaks to an ArcusPort: orders go out through the port (the live port routes them through
// the transaction queue, todo 14, to the Arcus contracts named in the deployment file), positions and equity are read on
// chain, and postsEquity is false because the Governor can read Arcus equity itself.
// Live: Arcus perps are an off-chain order book with Ed25519 API keys (docs.arcus.xyz); LiveArcusPort in arcus-live.ts
// speaks its REST API. Its account is off chain, so a live venue posts its equity (postsEquity true) like Hyperliquid, and
// it cannot deposit (owner's runbook), so it is built with fundable false. The defaults keep the mock's on-chain model.
import { USDG_TO_WAD, WAD } from "../../lib/fixed";
import type { IHedgeVenue, VenueFill } from "../types";
import { ARCUS_API_URL, ArcusHttp, LiveArcusPort, loadArcusSigner, type ArcusFetch, type ArcusNetwork } from "./arcus-live";

export interface ArcusPort {
  /** markets listed on Arcus, by underlying symbol; open = the market accepts orders right now */
  markets(): Promise<Map<string, { open: boolean; proxy: boolean }>>;
  /** signed position in units (WAD), read on chain */
  positionUnits(underlying: string): Promise<bigint>;
  /** account equity in raw USDG, read on chain */
  equityUsd(): Promise<bigint>;
  mark(underlying: string): Promise<{ px: bigint; updatedAtMs: number }>;
  depthUsd(underlying: string, side: "buy" | "sell"): Promise<bigint>;
  /** places an immediate-or-cancel order; returns the fill (filledUsd signed) */
  placeOrder(underlying: string, deltaUsd: bigint, limitPx: bigint, clientId: string): Promise<VenueFill>;
  orderByClientId(clientId: string): Promise<VenueFill | null>;
  /** deposits USDG from the hedger wallet into the venue (same chain); bounded by the caller */
  deposit(usd: bigint): Promise<void>;
  healthy(): Promise<{ ok: boolean; reason?: string }>;
}

export class ArcusVenue implements IHedgeVenue {
  readonly name = "arcus" as const;
  readonly postsEquity: boolean;
  readonly fundable: boolean;
  private listed = new Map<string, { open: boolean; proxy: boolean }>();
  constructor(private readonly port: ArcusPort, private readonly now: () => number = () => Date.now(), opts: { fundable?: boolean; postsEquity?: boolean } = {}) {
    this.fundable = opts.fundable ?? true;
    this.postsEquity = opts.postsEquity ?? false;
  }

  readonly basis = (underlying: string) => (this.listed.get(underlying)?.proxy ? { proxy: true, note: "index proxy on Arcus" } : { proxy: false });

  async healthy(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const h = await this.port.healthy();
      if (h.ok) this.listed = await this.port.markets();
      return h;
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  canTrade(underlying: string): boolean { return this.listed.get(underlying)?.open === true; }

  async markPrice(underlying: string): Promise<{ px: bigint; ageMs: number }> {
    const m = await this.port.mark(underlying);
    return { px: m.px, ageMs: Math.max(0, this.now() - m.updatedAtMs) };
  }

  async netPositionUsd(underlying: string): Promise<bigint> {
    const units = await this.port.positionUnits(underlying);
    if (units === 0n) return 0n;
    const { px } = await this.port.mark(underlying);
    return (units * px) / WAD / USDG_TO_WAD;
  }

  marginEquityUsd(): Promise<bigint> { return this.port.equityUsd(); }
  maxTradeUsd(underlying: string, side: "buy" | "sell"): Promise<bigint> { return this.port.depthUsd(underlying, side); }
  fillByClientId(_underlying: string, clientId: string): Promise<VenueFill | null> { return this.port.orderByClientId(clientId); }
  deposit(usd: bigint): Promise<void> { return this.port.deposit(usd); }

  async trade(underlying: string, deltaUsd: bigint, opts: { maxSlippageBps: number; clientId: string }): Promise<VenueFill> {
    const { px } = await this.port.mark(underlying);
    const bps = BigInt(opts.maxSlippageBps);
    const limit = deltaUsd > 0n ? (px * (10_000n + bps)) / 10_000n : (px * (10_000n - bps)) / 10_000n;
    return this.port.placeOrder(underlying, deltaUsd, limit, opts.clientId);
  }
}

/**
 * The live port (arcus-live.ts). Refuses to build without an account address, and outside dry run without the Ed25519
 * API signing key file. In dry run it reads only (no signer), like the Hyperliquid venue.
 */
export function createLiveArcusPort(o: { network: ArcusNetwork; baseUrl?: string; account: string; accountIndex: number; signingKeyFile?: string; dryRun: boolean; fetch?: ArcusFetch }): LiveArcusPort {
  if (!/^0x[0-9a-fA-F]{40}$/.test(o.account)) throw new Error("Arcus credentials missing: HEDGER_VENUES includes arcus but ARCUS_ACCOUNT_ADDRESS is not set");
  if (!o.dryRun && !o.signingKeyFile) throw new Error("Arcus credentials missing: HEDGER_DRY_RUN=0 needs ARCUS_API_SIGNING_KEY_FILE");
  const signer = !o.dryRun && o.signingKeyFile ? loadArcusSigner(o.signingKeyFile) : undefined;
  const http = new ArcusHttp({ baseUrl: o.baseUrl || ARCUS_API_URL[o.network], ...(o.fetch ? { fetch: o.fetch } : {}) });
  return new LiveArcusPort({ http, account: o.account, accountIndex: o.accountIndex, ...(signer ? { signer } : {}) });
}

/** An in-memory Arcus: on-chain style reads, IOC fills at the limit or better, session-bound markets. */
export class MockArcusPort implements ArcusPort {
  units = new Map<string, bigint>();
  cash: bigint;
  open = true;
  up = true;
  orders: (VenueFill & { clientId: string; underlying: string; limitPx: bigint })[] = [];
  deposits: bigint[] = [];
  reads = { position: 0, equity: 0 };
  constructor(public marks: Record<string, bigint>, cashUsd = 1_000_000n * 1_000_000n, public proxies: string[] = [], public depth = 10n ** 15n, private readonly clock: () => number = () => Date.now()) {
    this.cash = cashUsd;
  }
  async markets() { return new Map(Object.keys(this.marks).map((s) => [s, { open: this.open, proxy: this.proxies.includes(s) }])); }
  async positionUnits(u: string) { this.reads.position++; return this.units.get(u) ?? 0n; }
  async equityUsd() {
    this.reads.equity++;
    let total = this.cash;
    for (const [u, n] of this.units) total += (n * this.marks[u]!) / WAD / USDG_TO_WAD;
    return total;
  }
  async mark(u: string) {
    const px = this.marks[u];
    if (px === undefined) throw new Error(`arcus mock: no market ${u}`);
    return { px, updatedAtMs: this.clock() };
  }
  async depthUsd() { return this.depth; }
  async placeOrder(u: string, deltaUsd: bigint, limitPx: bigint, clientId: string): Promise<VenueFill> {
    if (!this.open) throw new Error("arcus mock: market closed");
    const px = (await this.mark(u)).px;
    if (deltaUsd > 0n ? px > limitPx : px < limitPx) return { ref: "", filledUsd: 0n, avgPx: px, feesUsd: 0n };
    this.units.set(u, (this.units.get(u) ?? 0n) + (deltaUsd * USDG_TO_WAD * WAD) / px);
    this.cash -= deltaUsd;
    const fill = { ref: `arcus-${this.orders.length + 1}`, filledUsd: deltaUsd, avgPx: px, feesUsd: 0n };
    this.orders.push({ ...fill, clientId, underlying: u, limitPx });
    return fill;
  }
  async orderByClientId(id: string) {
    const o = this.orders.find((x) => x.clientId === id);
    return o ? { ref: o.ref, filledUsd: o.filledUsd, avgPx: o.avgPx, feesUsd: o.feesUsd } : null;
  }
  async deposit(usd: bigint) { this.deposits.push(usd); this.cash += usd; }
  async healthy() { return this.up ? { ok: true } : { ok: false, reason: "arcus mock down" }; }
}

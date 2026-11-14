// A TypeScript model of ODAgentRouter's policy rules (contracts/src/agent/ODAgentRouter.sol), used as the "router mock"
// by the MCP tests. It decodes real router calldata with the generated ABI and reverts with the contract's own error
// names (each one encoded with the ABI, so a renamed error breaks the test). The Solidity suite is the authority.
import { decodeFunctionData, encodeErrorResult, getAddress, type Address, type Hex } from "viem";
import { IODAgentRouterAbi } from "../abi";

export interface MockPolicy { agent: Address; budgetUsdg: bigint; spentUsdg: bigint; maxPerTradeUsdg: bigint; expiresAt: bigint; canSell: boolean; canBack: boolean; revoked: boolean }
export interface MockGear { marketA: Hex; marketB: Hex | null; kind: number; collateralBps: number; maintenanceBps: number; status: number }
export class MockRevert extends Error {
  constructor(readonly errorName: string, readonly data: Hex) { super(errorName); }
}

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const lc = (a: string) => a.toLowerCase();

export class MockRouter {
  readonly policies = new Map<string, MockPolicy>();
  readonly markets = new Map<string, Hex[]>();
  readonly gears = new Map<string, MockGear>();
  readonly vaults = new Map<bigint, { owner: Address; gearId: Hex }>();
  readonly trades: Array<{ owner: Address; agent: Address; action: string; usdg: bigint }> = [];
  nextVault = 1n;
  constructor(public now: () => number) {}

  private key = (owner: string, agent: string) => `${lc(owner)}:${lc(agent)}`;
  setPolicy(owner: Address, agent: Address, p: { budgetUsdg: bigint; maxPerTradeUsdg: bigint; expiresAt: number; canSell?: boolean; canBack?: boolean; markets: Hex[] }) {
    this.policies.set(this.key(owner, agent), { agent, budgetUsdg: p.budgetUsdg, spentUsdg: 0n, maxPerTradeUsdg: p.maxPerTradeUsdg, expiresAt: BigInt(p.expiresAt), canSell: p.canSell ?? false, canBack: p.canBack ?? false, revoked: false });
    this.markets.set(this.key(owner, agent), [...p.markets]);
  }
  revoke(owner: Address, agent: Address) { const p = this.policies.get(this.key(owner, agent)); if (p) p.revoked = true; }
  addGear(id: Hex, g: Partial<MockGear> & { marketA: Hex }) { this.gears.set(lc(id), { marketB: null, kind: 1, collateralBps: 20_000, maintenanceBps: 15_000, status: 1, ...g }); }

  private revert(name: string, args: unknown[] = []): never {
    throw new MockRevert(name, encodeErrorResult({ abi: IODAgentRouterAbi, errorName: name as never, args: args as never }));
  }
  private active(owner: Address, agent: Address): MockPolicy {
    const p = this.policies.get(this.key(owner, agent));
    if (!p || lc(p.agent) === lc("0x0000000000000000000000000000000000000000")) this.revert("NoPolicy", [owner, agent]);
    if (p!.revoked) this.revert("PolicyIsRevoked", [owner, agent]);
    if (BigInt(this.now()) >= p!.expiresAt) this.revert("PolicyExpired", [p!.expiresAt]);
    return p!;
  }
  private requireGear(owner: Address, agent: Address, gearId: Hex): MockGear {
    const g = this.gears.get(lc(gearId));
    if (!g) throw new MockRevert("UnknownGear", "0x");
    const allowed = new Set((this.markets.get(this.key(owner, agent)) ?? []).map(lc));
    if (!allowed.has(lc(g.marketA))) this.revert("MarketNotAllowed", [g.marketA]);
    if (g.marketB && g.marketB !== ZERO32 && !allowed.has(lc(g.marketB))) this.revert("MarketNotAllowed", [g.marketB]);
    return g;
  }
  private charge(p: MockPolicy, usdg: bigint) {
    if (usdg > p.maxPerTradeUsdg) this.revert("MaxPerTradeExceeded", [usdg, p.maxPerTradeUsdg]);
    if (p.spentUsdg + usdg > p.budgetUsdg) this.revert("BudgetExceeded", [p.spentUsdg, usdg, p.budgetUsdg]);
    p.spentUsdg += usdg;
  }

  /** Run router calldata as `agent` (msg.sender). Returns normally on success, throws MockRevert with the contract's error. */
  execute(agent: Address, data: Hex): { action: string } {
    const { functionName, args } = decodeFunctionData({ abi: IODAgentRouterAbi, data }) as { functionName: string; args: readonly unknown[] };
    const nowSec = BigInt(this.now());
    switch (functionName) {
      case "buyFor": {
        const [owner, gearId, usdgIn] = args as [Address, Hex, bigint, bigint, bigint];
        const p = this.active(owner, agent); this.requireGear(owner, agent, gearId); this.charge(p, usdgIn);
        this.trades.push({ owner, agent, action: "buy", usdg: usdgIn });
        return { action: "buy" };
      }
      case "sellFor": {
        const [owner, gearId, tokens] = args as [Address, Hex, bigint, bigint, bigint];
        const p = this.active(owner, agent);
        if (!p.canSell) this.revert("SellNotAllowed");
        this.requireGear(owner, agent, gearId);
        this.trades.push({ owner, agent, action: "sell", usdg: tokens });
        return { action: "sell" };
      }
      case "backFor": {
        const [owner, vaultId, gearId, collateral, , , deadline] = args as [Address, bigint, Hex, bigint, bigint, bigint, bigint];
        if (nowSec > deadline) throw new MockRevert("Expired", "0x");
        const p = this.active(owner, agent);
        if (!p.canBack) this.revert("BackNotAllowed");
        this.requireGear(owner, agent, gearId);
        this.charge(p, collateral);
        this.trades.push({ owner, agent, action: "back", usdg: collateral });
        return { action: "back" };
      }
      default: throw new MockRevert("UnknownFunction", "0x");
    }
  }

  /** A viem-shaped reader over this state: policyOf, remainingBudget, allowedMarkets and the registry's gear(). */
  reader(): { readContract(a: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<unknown>; reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      readContract: async ({ functionName, args }) => {
        reads.push(functionName);
        if (functionName === "gear") {
          const g = this.gears.get(lc(args[0] as string));
          if (!g) return { marketA: ZERO32, marketB: ZERO32, gear: 0, collateralBps: 0, maintenanceBps: 0, status: 0 };
          return { marketA: g.marketA, marketB: g.marketB ?? ZERO32, gear: g.kind, collateralBps: g.collateralBps, maintenanceBps: g.maintenanceBps, status: g.status };
        }
        const [owner, agent] = args as [Address, Address];
        const k = this.key(owner, agent);
        const p = this.policies.get(k) ?? { agent: "0x0000000000000000000000000000000000000000" as Address, budgetUsdg: 0n, spentUsdg: 0n, maxPerTradeUsdg: 0n, expiresAt: 0n, canSell: false, canBack: false, revoked: false };
        if (functionName === "policyOf") return { ...p, agent: p.agent === "0x0000000000000000000000000000000000000000" ? p.agent : getAddress(p.agent) };
        if (functionName === "remainingBudget") return p.spentUsdg >= p.budgetUsdg ? 0n : p.budgetUsdg - p.spentUsdg;
        if (functionName === "allowedMarkets") return [...(this.markets.get(k) ?? [])];
        throw new Error(`unexpected read ${functionName}`);
      },
    };
  }
}

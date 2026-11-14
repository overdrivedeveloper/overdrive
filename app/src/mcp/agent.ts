import { createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { IODAgentRouterAbi, IODGearRegistryAbi, IODMinterAbi } from "../abi";
import { ToolError } from "./api-client";
import type { PolicyMirror } from "./config";

/** How far the server may go. read_only: no write tools. prepare: write tools return calldata and never send. send: write
 * tools sign with the agent key and broadcast, only with a live on-chain policy. */
export type Mode = "read_only" | "prepare" | "send";

/** IODAgentRouter.policyOf plus the markets from allowedMarkets (the PolicySet event's list). The router is the authority;
 * this copy only saves a doomed transaction. */
export interface PolicyView {
  owner: Address; agent: Address; budgetUsdg: bigint; spentUsdg: bigint; maxPerTradeUsdg: bigint; expiresAt: number;
  canSell: boolean; canBack: boolean; revoked: boolean; markets: Hex[];
}

export interface PolicyReader {
  read(owner: Address, agent: Address): Promise<PolicyView | null>;
  /** Called after a send so an environment mirror tracks spend. The chain reader ignores it: the chain moved. */
  recordSpend?(owner: Address, usdg: bigint): void;
}

/** The registry facts a back needs (IODGearRegistry.gear). */
export interface GearFacts { marketA: Hex; marketB: Hex | null; kind: "CRUISE" | "SPORT" | "RACE" | "ECO" | "REVERSE"; collateralBps: number; maintenanceBps: number; settled: boolean }
export interface GearReader { read(gearId: Hex): Promise<GearFacts> }

/** An order the API quoted (the unsigned ODMinter transaction) or, for back, the plan the tool built. */
export interface Intent { kind?: string; tx?: { to: string; data: string; value?: string }; expectedOut?: string; minOut?: string }
export interface BackPlan { gearId: Hex; vaultId: bigint; collateralUsdg: bigint; mintTokens: bigint; minProceedsUsdg: bigint; deadline: bigint }

export type RouterCall =
  | { kind: "buy"; gearId: Hex; markets: Hex[]; spendUsdg: bigint; args: readonly [owner: Address, gearId: Hex, usdgIn: bigint, minTokensOut: bigint, deadline: bigint] }
  | { kind: "sell"; gearId: Hex; markets: Hex[]; spendUsdg: 0n; args: readonly [owner: Address, gearId: Hex, tokens: bigint, minUsdgOut: bigint, deadline: bigint] }
  | { kind: "back"; gearId: Hex; markets: Hex[]; spendUsdg: bigint; args: readonly [owner: Address, vaultId: bigint, gearId: Hex, collateralUsdg: bigint, mintTokens: bigint, minProceedsUsdg: bigint, deadline: bigint] };

/** What the caller asked for, checked against what the intent decodes to (R4). Any field left out is not checked. */
export interface IntentExpect { gearId?: Hex; minter?: Address; amount?: bigint; minOut?: bigint; deadline?: bigint; deadlineWithin?: readonly [bigint, bigint]; markets?: Hex[] }

const bad = () => new ToolError("BAD_INTENT", "The API returned a transaction that does not match the requested action. Nothing was signed.");
const lc = (a: string) => a.toLowerCase();

export function encodeRouterCall(call: RouterCall): Hex {
  switch (call.kind) {
    case "buy": return encodeFunctionData({ abi: IODAgentRouterAbi, functionName: "buyFor", args: [...call.args] });
    case "sell": return encodeFunctionData({ abi: IODAgentRouterAbi, functionName: "sellFor", args: [...call.args] });
    case "back": return encodeFunctionData({ abi: IODAgentRouterAbi, functionName: "backFor", args: [...call.args] });
  }
}

/** Turn an API intent (unsigned ODMinter calldata) or a back plan into the matching router call with `owner` as the
 * beneficiary. The intent is the one source for gear, amount, minimum out and deadline; only the entry point changes.
 * Anything that does not decode to exactly the requested action is BAD_INTENT. */
export function routerCallFromIntent(kind: "buy" | "sell" | "back", intent: Intent | BackPlan, owner: Address, expect: IntentExpect = {}): RouterCall {
  const markets = expect.markets ?? [];
  if (kind === "back") {
    const plan = intent as BackPlan;
    if (typeof plan.gearId !== "string" || typeof plan.deadline !== "bigint") throw bad();
    if (expect.gearId && lc(plan.gearId) !== lc(expect.gearId)) throw bad();
    return { kind, gearId: plan.gearId, markets, spendUsdg: plan.collateralUsdg, args: [owner, plan.vaultId, plan.gearId, plan.collateralUsdg, plan.mintTokens, plan.minProceedsUsdg, plan.deadline] };
  }
  const i = intent as Intent;
  if (i.kind !== kind || !i.tx || typeof i.tx.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(i.tx.data)) throw bad();
  // The target must be the minter (the API's own, or the pinned one): calldata for any other contract is refused.
  if (expect.minter && lc(i.tx.to) !== lc(expect.minter)) throw bad();
  let decoded: { functionName: string; args: readonly unknown[] | undefined };
  try { decoded = decodeFunctionData({ abi: IODMinterAbi, data: i.tx.data as Hex }) as typeof decoded; } catch { throw bad(); }
  if (decoded.functionName !== kind || !decoded.args) throw bad();
  const [gearId, amount, minOut, recipient, deadline] = decoded.args as [Hex, bigint, bigint, Address, bigint];
  if (lc(recipient) !== lc(owner)) throw bad(); // proceeds and tokens go to the owner, never to the agent or a third party
  if (expect.gearId && lc(gearId) !== lc(expect.gearId)) throw bad();
  if (expect.amount !== undefined && amount !== expect.amount) throw bad();
  if (expect.minOut !== undefined && minOut !== expect.minOut) throw bad();
  if (expect.deadline !== undefined && deadline !== expect.deadline) throw bad();
  if (expect.deadlineWithin && (deadline < expect.deadlineWithin[0] || deadline > expect.deadlineWithin[1])) throw bad();
  if (kind === "buy") return { kind, gearId, markets, spendUsdg: amount, args: [owner, gearId, amount, minOut, deadline] };
  return { kind, gearId, markets, spendUsdg: 0n, args: [owner, gearId, amount, minOut, deadline] };
}

/** The router's own rules in the router's own order, applied before signing. Codes are the contract's error names. */
export function checkPolicy(policy: PolicyView | null, call: RouterCall, nowSeconds: number): ToolError | null {
  const refuse = (code: string, message: string) => new ToolError(code, message);
  if (call.kind === "back" && BigInt(nowSeconds) > call.args[6]) return refuse("Expired", "The deadline has passed.");
  if (!policy) return refuse("NoPolicy", "No agent policy is set for this owner. The owner sets one on the agent router first.");
  if (policy.revoked) return refuse("PolicyIsRevoked", "The owner revoked this agent.");
  if (nowSeconds >= policy.expiresAt) return refuse("PolicyExpired", "This agent policy has expired.");
  if (call.kind === "sell" && !policy.canSell) return refuse("SellNotAllowed", "This agent may not sell.");
  if (call.kind === "back" && !policy.canBack) return refuse("BackNotAllowed", "This agent may not back.");
  const allowed = new Set(policy.markets.map(lc));
  if (call.markets.length === 0) return refuse("MarketNotAllowed", "The gear's markets could not be confirmed against the policy.");
  for (const m of call.markets) if (!allowed.has(lc(m))) return refuse("MarketNotAllowed", "This gear's market is not in the agent's allowed list.");
  if (call.kind !== "sell") {
    if (call.spendUsdg > policy.maxPerTradeUsdg) return refuse("MaxPerTradeExceeded", "The amount is above the per-trade limit.");
    if (policy.spentUsdg + call.spendUsdg > policy.budgetUsdg) return refuse("BudgetExceeded", "The amount is above the remaining budget.");
  }
  return null;
}

/** The one read call the chain reader needs; a viem PublicClient satisfies it and tests pass a mock. */
export interface ChainReader {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

/** ODAgentRouter.allowedMarkets is a public view on the contract but is not declared in IODAgentRouter, so the generated ABI
 * lacks it. Declared here, once; it moves into the interface when the contract next changes (noted in STATUS). */
export const ALLOWED_MARKETS_ABI = parseAbi(["function allowedMarkets(address owner, address agent) view returns (bytes32[])"]);

const ZERO = "0x0000000000000000000000000000000000000000";

/** The policy as the router holds it (policyOf, remainingBudget, allowedMarkets): the owner's on-chain word, not a copy. */
export function chainPolicyReader(chain: ChainReader, router: Address): PolicyReader {
  const read = (functionName: string, args: readonly unknown[]) => chain.readContract({ address: router, abi: functionName === "allowedMarkets" ? ALLOWED_MARKETS_ABI : IODAgentRouterAbi, functionName, args });
  return {
    async read(owner, agent) {
      let raw: { agent: Address; budgetUsdg: bigint; spentUsdg: bigint; maxPerTradeUsdg: bigint; expiresAt: bigint | number; canSell: boolean; canBack: boolean; revoked: boolean };
      let markets: readonly Hex[];
      let remaining: bigint;
      try {
        [raw, markets, remaining] = await Promise.all([read("policyOf", [owner, agent]), read("allowedMarkets", [owner, agent]), read("remainingBudget", [owner, agent])]) as [typeof raw, readonly Hex[], bigint];
      } catch {
        // Never echo the underlying message: viem errors can embed the RPC URL.
        throw new ToolError("POLICY_READ_FAILED", "The agent policy could not be read from the router. Try again shortly.");
      }
      if (lc(raw.agent) === ZERO) return null; // an unset policy is the zero struct
      return {
        owner, agent, budgetUsdg: raw.budgetUsdg, spentUsdg: raw.budgetUsdg - remaining, maxPerTradeUsdg: raw.maxPerTradeUsdg, expiresAt: Number(raw.expiresAt),
        canSell: raw.canSell, canBack: raw.canBack, revoked: raw.revoked, markets: [...markets],
      };
    },
  };
}

const KINDS = ["CRUISE", "SPORT", "RACE", "ECO", "REVERSE"] as const;
/** Gear facts from IODGearRegistry.gear. Unreadable fails closed. */
export function chainGearReader(chain: ChainReader, registry: Address): GearReader {
  return {
    async read(gearId) {
      let g: { marketA: Hex; marketB: Hex; gear: number; collateralBps: number; maintenanceBps: number; status: number };
      try { g = await chain.readContract({ address: registry, abi: IODGearRegistryAbi, functionName: "gear", args: [gearId] }) as typeof g; }
      catch { throw new ToolError("GEAR_READ_FAILED", "The gear could not be read from the registry. Try again shortly."); }
      const kind = KINDS[Number(g.gear)];
      if (!kind || Number(g.status) === 0) throw new ToolError("UNKNOWN_GEAR", "The registry does not list this gear.");
      return { marketA: g.marketA, marketB: lc(g.marketB) === `0x${"0".repeat(64)}` ? null : g.marketB, kind, collateralBps: Number(g.collateralBps), maintenanceBps: Number(g.maintenanceBps), settled: Number(g.status) === 4 };
    },
  };
}

/** Dev fallback only (AGENT_POLICY_FROM_ENV=1, never in production): the policy kept in the environment. Spend is tracked in memory. */
export function envPolicyReader(mirror: PolicyMirror | undefined, agent: Address): PolicyReader {
  let current = mirror ? { ...mirror } : undefined;
  return {
    async read(owner) {
      if (!current || lc(current.owner) !== lc(owner)) return null;
      return {
        owner, agent, budgetUsdg: BigInt(current.budgetUsdg), spentUsdg: BigInt(current.spentUsdg), maxPerTradeUsdg: BigInt(current.maxPerTradeUsdg), expiresAt: current.expiresAt,
        canSell: current.canSell, canBack: current.canBack, revoked: current.revoked, markets: current.markets as Hex[],
      };
    },
    recordSpend(_owner, usdg) {
      if (current) current = { ...current, spentUsdg: (BigInt(current.spentUsdg) + usdg).toString() };
    },
  };
}

export interface Executor { send(call: { to: Address; data: Hex }): Promise<{ txHash: Hex }> }

/** Signs with the agent key and broadcasts through the configured RPC. */
export function viemExecutor(args: { rpcUrl: string; chainId: number; account: LocalAccount }): Executor {
  const chain = { id: args.chainId, name: `chain-${args.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [args.rpcUrl] } } } as const;
  const wallet = createWalletClient({ account: args.account, chain, transport: http(args.rpcUrl) });
  const client = createPublicClient({ chain, transport: http(args.rpcUrl) });
  return {
    async send({ to, data }) {
      try {
        const estimate = await client.estimateGas({ to, data, account: args.account });
        const txHash = await wallet.sendTransaction({ to, data, account: args.account, chain, gas: (estimate * 125n) / 100n });
        const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
        if (receipt.status !== "success") throw new ToolError("TX_REVERTED", "The router refused the transaction.", { txHash });
        return { txHash };
      } catch (error) {
        if (error instanceof ToolError) throw error;
        // Never echo the underlying message: viem errors can embed the RPC URL.
        throw new ToolError("TX_FAILED", "The transaction could not be sent or was refused by the router.");
      }
    },
  };
}

export interface AgentRuntime {
  readonly account: LocalAccount;
  readonly owner: Address | undefined;
  readonly router: Address | undefined;
  readonly policy: PolicyReader;
  readonly gears: GearReader | undefined;
  readonly executor: Executor;
  /** Set false only in tests that must reach the chain-side rules. */
  readonly clientSideChecks: boolean;
  readonly now: () => number;
  /** One write at a time per owner, so two buys cannot both pass the same remaining budget (R5). */
  locked<T>(owner: Address, run: () => Promise<T>): Promise<T>;
}

export function createAgentRuntime(args: {
  key: Hex; owner?: Address | undefined; router?: Address | undefined; policy: PolicyReader; gears?: GearReader | undefined; executor: (account: LocalAccount) => Executor;
  clientSideChecks?: boolean; now?: () => number;
}): AgentRuntime {
  const account = privateKeyToAccount(args.key);
  const tails = new Map<string, Promise<unknown>>();
  return {
    account, owner: args.owner ? getAddress(args.owner) : undefined, router: args.router ? getAddress(args.router) : undefined,
    policy: args.policy, gears: args.gears, executor: args.executor(account), clientSideChecks: args.clientSideChecks ?? true, now: args.now ?? Date.now,
    locked<T>(owner: Address, run: () => Promise<T>): Promise<T> {
      const key = owner.toLowerCase();
      const next = (tails.get(key) ?? Promise.resolve()).then(run, run);
      const tail = next.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return next;
    },
  };
}

/** Policy read, named refusal, sign, send, spend mirror: one owner at a time. A failed or reverted send never advances the mirror. */
export async function sendRouterCall(agent: AgentRuntime, router: Address, call: RouterCall, owner: Address): Promise<{ txHash: Hex }> {
  return agent.locked(owner, async () => {
    if (agent.clientSideChecks) {
      const refusal = checkPolicy(await agent.policy.read(owner, agent.account.address), call, Math.floor(agent.now() / 1000));
      if (refusal) throw refusal;
    }
    const sent = await agent.executor.send({ to: router, data: encodeRouterCall(call) });
    if (call.kind !== "sell") agent.policy.recordSpend?.(owner, call.spendUsdg);
    return sent;
  });
}

/** The mode that actually runs: never above what was asked, the key and a readable, live on-chain policy allow (R1). */
export async function resolveMode(agent: AgentRuntime | undefined, requested: Mode, owner: Address | undefined): Promise<Mode> {
  if (!agent || requested === "read_only") return "read_only";
  if (requested === "prepare" || !owner) return "prepare";
  try {
    const policy = await agent.policy.read(owner, agent.account.address);
    const live = policy !== null && !policy.revoked && Math.floor(agent.now() / 1000) < policy.expiresAt;
    return live ? "send" : "prepare";
  } catch {
    return "prepare";
  }
}

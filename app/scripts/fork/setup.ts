// Fork stack setup, called by up.sh (fork only; every write goes to the local anvil node).
//   bun scripts/fork/setup.ts --keystores          throwaway keystores for the signing roles in $FORK_DIR/keys (mode 600)
//   bun scripts/fork/setup.ts --config             $FORK_DIR/deploy-config.json: contracts/script/config/fork.json with the
//                                                  roles moved to anvil dev accounts (config/deploy.fork.json)
//   bun scripts/fork/setup.ts --clear-delegations  removes EIP-7702 delegation code from every anvil dev account (R4)
//   bun scripts/fork/setup.ts --relax              applies RELAXATIONS through the timelock (R5), once per deployment
//   bun scripts/fork/setup.ts --list-gears         runs deploy-fork.sh's list-gears Safe batch for real: the owner (anvil
//                                                  account 1 = ownerSafe) schedules it on the timelock, the clock moves
//                                                  past minDelay, the owner executes it. Once per deployment.
//   bun scripts/fork/setup.ts --fill-gears        rewrites deployment.json `gears` from the registry (up.sh runs it after --list-gears)
//   bun scripts/fork/setup.ts --env                one env file per service in $FORK_DIR/env (keystore form, R7)
//
// Fork-only relaxations (this list and the fork report; never in DeploySystem or deploy-fork.sh). Each is sent by the
// TimelockController itself through anvil impersonation, the same path a scheduled timelock call takes:
//   R5.1 ODOracleGuard maxAgeOpen and maxAgeExtended = 30 days for every market: the fork never sees a new Chainlink print,
//        so after any warp the real feeds would age past the production bound and every market would read HALTED.
//   R5.2 ODOracleGuard maxAgeClosed = 14 days (the contract maximum): same reason, for closed-session reads.
//   R5.3 ODOracleGuard refBandBps = 2000 (the contract maximum) and refMaxAge = 1 day (the maximum): feeds, Pyth and pools
//        are frozen at the fork block, so a gap the live market closes in minutes would pause buys for the whole run.
//   R5.4 Pyth Core (external, not ours) answers from MockPyth code put at its address with anvil_setCode, priced from each
//        market's Chainlink feed with publishTime = the fork clock (refreshed by warp.ts and `setup.ts --refresh-pyth`).
//        The real Pyth Core holds prices days old and can only be updated with signed Hermes updates (an API key), so
//        every market would read REF_UNAVAILABLE and the list-gears batch reverts MarketNotReady (seen 2026-11-14).
// The freshness, halted and band paths are still exercised in 22b with a mock feed swapped in for one market.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, erc20Abi, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { IODOracleGuardAbi } from "@/abi/IODOracleGuard";
import { ABIS, IODGearRegistryAbi, IODGovernorAbi } from "@/abi";
import { fund } from "./fund";
import { warpTarget } from "./warp";
import {
  addressOf, ANVIL_URL, anvilAccounts, API_URL, asTimelock, assertFork, DATABASE_URL, DEPLOYMENT_FILE, encryptKeystore, FORK_DIR,
  forkClients, keyOf, loadDeployment, loadForkConfig, PORTS, ROOT, runOnce, walletFor, type Role,
} from "./lib";
import { bytes32Text, marketId as sharedMarketId } from "../../src/indexer/units";

export interface Relaxation { id: string; contract: string; what: string; why: string }
export const RELAXATIONS: readonly Relaxation[] = [
  { id: "R5.1", contract: "ODOracleGuard", what: "maxAgeOpen and maxAgeExtended = 3 days (the guard's setMarket ceiling), every market", why: "real feeds are frozen at the fork block; warps would read HALTED" },
  { id: "R5.2", contract: "ODOracleGuard", what: "maxAgeClosed = 14 days (contract maximum), every market", why: "closed-session reads after warps" },
  { id: "R5.3", contract: "ODOracleGuard", what: "refBandBps = 2000 and refMaxAge = 1 day (contract maxima), every market", why: "feed, Pyth and pools frozen at different prices" },
  { id: "R5.4", contract: "Pyth Core (external)", what: "MockPyth code at the Pyth Core address, priced from the Chainlink feed, publishTime = fork clock", why: "real Pyth prices are days old; updates need signed Hermes data" },
  { id: "R5.5", contract: "ODOracleGuard", what: "each market's feed swapped (setMarket, timelock) for a mirror MockAggregator holding the real feed's answer and decimals at the fork block, re-stamped at the current chain time on every refreshPyth (warp, freshen)", why: "the guard caps maxAgeOpen at 3 days and the run warps more than that; the frozen real feeds would read HALTED" },
];

const feedAbi = [
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
const stockAbi = [{ type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const mockPythAbi = [
  { type: "function", name: "setPrice", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "int64" }, { type: "uint64" }, { type: "int32" }, { type: "uint256" }], outputs: [] },
] as const;

/** Pyth price (raw, expo = -feed decimals) matching a Chainlink answer; divides out the Stock Token multiplier when the
 * guard multiplies Pyth by it (pythMultiplierEmbedded false on a stock market). Pure, tested. */
export function pythFromFeed(answer: bigint, multiplierWad: bigint | undefined): bigint {
  return multiplierWad && multiplierWad > 0n ? (answer * 10n ** 18n) / multiplierWad : answer;
}

function mockPythCode(): Hex {
  const p = Bun.spawnSync([join(process.env.HOME ?? "", ".foundry/bin/forge"), "inspect", "test/mocks/MockPyth.sol:MockPyth", "deployedBytecode"], { cwd: join(ROOT, "contracts"), stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim().split("\n").pop() ?? "";
  if (p.exitCode !== 0 || !/^0x[0-9a-fA-F]+$/.test(out)) throw new Error(`forge inspect MockPyth failed: ${p.stderr.toString().slice(-400)}`);
  return out as Hex;
}

/** R5.4: MockPyth code at the Pyth Core address (once), then a fresh price per market from its Chainlink feed. */
/** R5.5: once, every market's feed becomes a mirror MockAggregator (real answer and decimals at the fork block) through the
 * timelock; afterwards each call re-stamps the mirrors at the chain clock (answer unchanged). Returns the mirror count. */
export async function mirrorFeeds(): Promise<number> {
  const { pub } = await assertFork();
  const dep = loadDeployment();
  const guard = getAddress(dep.contracts.ODOracleGuard ?? "");
  const file = join(FORK_DIR, "mirror-feeds.json");
  const mirrors: Record<string, { real: Address; mirror: Address }> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const w = walletFor("spare1");
  const now = (await pub.getBlock()).timestamp;
  const send = async (hash: Hex, what: string) => { if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`${what}: ${hash} reverted`); };
  // only the real markets: the harness's own mock markets (MCK*) already sit on MockAggregator feeds that the stale,
  // closed and split flows drive by hand, so re-stamping them would hide the very staleness those flows assert
  for (const m of dep.markets) {
    if (mirrors[m.symbol] || /^MCK/.test(m.symbol)) continue;
    const id = marketId(m.symbol);
    const cfg = (await pub.readContract({ address: guard, abi: IODOracleGuardAbi, functionName: "config", args: [id] })) as unknown as MarketCfg;
    const [, answer] = await pub.readContract({ address: cfg.feed, abi: feedAbi, functionName: "latestRoundData" });
    const dec = await pub.readContract({ address: cfg.feed, abi: feedAbi, functionName: "decimals" });
    const p = Bun.spawnSync([join(process.env.HOME ?? "", ".foundry/bin/forge"), "inspect", "test/mocks/MockAggregator.sol:MockAggregator", "bytecode"], { cwd: join(ROOT, "contracts"), stdout: "pipe", stderr: "pipe" });
    const code = (p.stdout.toString().trim().split("\n").pop() ?? "") as Hex;
    if (p.exitCode !== 0 || !/^0x[0-9a-fA-F]+$/.test(code)) throw new Error(`forge inspect MockAggregator failed: ${p.stderr.toString().slice(-400)}`);
    const hash = await w.deployContract({ abi: [], bytecode: `${code}${encodeAbiParameters([{ type: "uint8" }, { type: "int256" }], [Number(dec), answer]).slice(2)}` as Hex, chain: null, account: w.account! } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    const mirror = getAddress(r.contractAddress!);
    // the guard wants aggregator() to be a contract other than the feed itself
    await send(await w.writeContract({ address: mirror, abi: mirrorAbi, functionName: "setAggregator", args: [getAddress(dep.external.usdg!)], chain: null, account: w.account! }), `mirror ${m.symbol} setAggregator`);
    await send(await w.writeContract({ address: mirror, abi: mirrorAbi, functionName: "setRound", args: [answer, now], chain: null, account: w.account! }), `mirror ${m.symbol} setRound`);
    await send(await asTimelock((tw, t) => tw.writeContract({ address: guard, abi: IODOracleGuardAbi, functionName: "setMarket", args: [id, { ...cfg, feed: mirror } as never], gas: 10_000_000n, chain: null, account: t } as never)), `mirror ${m.symbol} setMarket`);
    mirrors[m.symbol] = { real: getAddress(cfg.feed), mirror };
    writeFileSync(file, `${JSON.stringify(mirrors, null, 1)}\n`);
  }
  for (const [sym, x] of Object.entries(mirrors)) {
    if (/^MCK/.test(sym)) continue;
    const [, answer] = await pub.readContract({ address: x.mirror, abi: feedAbi, functionName: "latestRoundData" });
    await send(await w.writeContract({ address: x.mirror, abi: mirrorAbi, functionName: "setRound", args: [answer, now], chain: null, account: w.account! }), `mirror ${sym} restamp`);
  }
  return Object.keys(mirrors).length;
}
const mirrorAbi = parseAbi(["function setRound(int256 answer, uint256 updatedAt) external", "function setAggregator(address) external"]);

export async function refreshPyth(): Promise<number> {
  const { pub, test } = await assertFork();
  if (existsSync(join(FORK_DIR, "relaxations.json"))) await mirrorFeeds();
  const dep = loadDeployment();
  const pyth = getAddress(dep.external.pythCore ?? "");
  const guard = getAddress(dep.contracts.ODOracleGuard ?? "");
  const marker = join(FORK_DIR, "mock-pyth.code");
  if (!existsSync(marker)) writeFileSync(marker, mockPythCode());
  const code = readFileSync(marker, "utf8").trim() as Hex;
  if ((await pub.getCode({ address: pyth }))?.toLowerCase() !== code.toLowerCase()) await test.setCode({ address: pyth, bytecode: code });
  const now = (await pub.getBlock()).timestamp;
  const wallet = walletFor("spare1");
  let n = 0;
  for (const m of dep.markets) {
    const cfg = (await pub.readContract({ address: guard, abi: IODOracleGuardAbi, functionName: "config", args: [marketId(m.symbol)] })) as unknown as MarketCfg;
    if (/^0x0+$/.test(cfg.pythId)) continue;
    const [, answer] = await pub.readContract({ address: cfg.feed, abi: feedAbi, functionName: "latestRoundData" });
    const dec = await pub.readContract({ address: cfg.feed, abi: feedAbi, functionName: "decimals" });
    const stock = cfg.stockToken !== "0x0000000000000000000000000000000000000000" && !cfg.pythMultiplierEmbedded;
    const mult = stock ? await pub.readContract({ address: cfg.stockToken, abi: stockAbi, functionName: "uiMultiplier" }) : undefined;
    const hash = await wallet.writeContract({
      address: pyth, abi: mockPythAbi, functionName: "setPrice", args: [cfg.pythId, pythFromFeed(answer, mult), 0n, -Number(dec), now], chain: null, account: wallet.account!,
    });
    if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`mock Pyth ${m.symbol}: ${hash} reverted`);
    n++;
  }
  return n;
}

/** Roles that sign in the services or the deploy, each with a throwaway keystore (prefix = keys.ts env prefix). */
export const SIGNING_ROLES: readonly { role: Role; prefix: string }[] = [
  { role: "deployer", prefix: "DEPLOYER" }, { role: "crank", prefix: "CRANK" }, { role: "hedger", prefix: "HEDGER" },
  { role: "liquidator", prefix: "LIQUIDATOR" }, { role: "volSigner", prefix: "VOL_SIGNER" }, { role: "volSender", prefix: "VOL_SENDER" },
  { role: "paymasterSigner", prefix: "PAYMASTER_SIGNER" }, { role: "agent", prefix: "AGENT" },
];
export const keystorePath = (role: Role) => join(FORK_DIR, "keys", `${role}.json`);
export const passwordFile = () => join(FORK_DIR, "keys", "password");

export function writeKeystores(): number {
  mkdirSync(join(FORK_DIR, "keys"), { recursive: true, mode: 0o700 });
  if (!existsSync(passwordFile())) writeFileSync(passwordFile(), randomBytes(24).toString("hex"), { mode: 0o600 });
  const pw = readFileSync(passwordFile(), "utf8").trim();
  let made = 0;
  for (const { role } of SIGNING_ROLES) {
    const file = keystorePath(role);
    const want = addressOf(role).slice(2).toLowerCase();
    if (existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as { address: string }).address === want) continue;
    writeFileSync(file, encryptKeystore(keyOf(role), pw), { mode: 0o600 });
    made++;
  }
  return made;
}

/** contracts/script/config/fork.json with every role moved to the anvil dev account config/deploy.fork.json names. */
export function forkDeployConfig(base: Record<string, unknown>, roleMap: Record<string, Role>, addr: (r: Role) => Address): Record<string, unknown> {
  const roles = { ...(base.roles as Record<string, string>) };
  for (const [k, role] of Object.entries(roleMap)) {
    if (!(k in roles)) throw new Error(`deploy config has no role ${k}`);
    roles[k] = getAddress(addr(role));
  }
  return { ...base, roles };
}

function writeDeployConfig(): void {
  const cfg = loadForkConfig();
  const base = JSON.parse(readFileSync(join(ROOT, "contracts/script/config/fork.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(FORK_DIR, "deploy-config.json"), `${JSON.stringify(forkDeployConfig(base, cfg.roles, addressOf), null, 1)}\n`);
  console.log(`setup: deploy config with roles on anvil dev accounts (${join(FORK_DIR, "deploy-config.json")})`);
}

export async function clearDevDelegations(): Promise<number> {
  const { pub, test } = await assertFork();
  let cleared = 0;
  for (const address of anvilAccounts().available_accounts) {
    const code = await pub.getCode({ address });
    if (code && code !== "0x") { await test.setCode({ address, bytecode: "0x" }); cleared++; }
  }
  return cleared;
}

type MarketCfg = {
  feed: Address; stockToken: Address; multiplierEmbedded: boolean; pythMultiplierEmbedded: boolean; alwaysOpen: boolean; pythId: Hex;
  twapPool: Address; maxAgeOpen: number; maxAgeExtended: number; maxAgeClosed: number; refMaxAge: number; twapWindow: number;
  refBandBps: number; continuityBps: number; enabled: boolean;
};
/** The relaxed MarketConfig for one market (pure, tested). Leaves refMaxAge alone when no Pyth id is set. */
/** ODOracleGuard.setMarket bounds (MAX_MAX_AGE_OPEN, MAX_MAX_AGE_CLOSED, MAX_REF_BAND_BPS, MAX_REF_MAX_AGE): a relaxation
 * past them reverts InvalidConfig, so every relaxed value is clamped to them. */
export const GUARD_BOUNDS = { maxAgeOpen: 3 * 86_400, maxAgeClosed: 14 * 86_400, refBandBps: 2000, refMaxAge: 86_400 } as const;

export function relaxedMarket(cfg: MarketCfg, r = loadForkConfig().relaxations): MarketCfg {
  const b = GUARD_BOUNDS;
  return {
    ...cfg,
    maxAgeOpen: Math.min(Math.max(cfg.maxAgeOpen, r.feedMaxAgeSec), b.maxAgeOpen),
    maxAgeExtended: cfg.alwaysOpen && cfg.maxAgeExtended === 0 ? 0 : Math.min(Math.max(cfg.maxAgeExtended, r.feedMaxAgeSec), b.maxAgeOpen),
    maxAgeClosed: Math.min(Math.max(cfg.maxAgeClosed, r.feedMaxAgeClosedSec), b.maxAgeClosed),
    refBandBps: Math.min(Math.max(cfg.refBandBps, r.refBandBps), b.refBandBps),
    refMaxAge: /^0x0+$/.test(cfg.pythId) ? cfg.refMaxAge : Math.min(Math.max(cfg.refMaxAge, r.refMaxAgeSec), b.refMaxAge),
  };
}

/** Market ids as the deployment's ODOracleGuard knows them (bytes32 of the symbol, right-padded). */
export const marketId = (symbol: string): Hex => sharedMarketId(symbol);

/** Governor capital the fork seeds once, in USDG. Same path as the exercise harness (ensureCapital): fund spare2, allow it as a
 * depositor through the timelock, deposit. Without equity the Governor's cap is 0 and every buy closes with CAP. */
export const SEED_CAPITAL_USDG = 4_000_000;

async function seedCapital(): Promise<string> {
  const { pub } = await assertFork();
  const d = loadDeployment();
  const gov = getAddress(d.contracts.ODGovernor!);
  const usdg = getAddress(d.external.usdg!);
  const supply = (await pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "totalSupply" })) as bigint;
  if (supply > 0n) return `Governor capital already seeded (${supply} shares)`;
  const who = addressOf("spare2");
  await fund([who], SEED_CAPITAL_USDG, 10);
  const ok = async (hash: Hex, what: string) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${what} reverted (${hash})`);
  };
  await ok(await asTimelock((w, t) => w.writeContract({ address: gov, abi: IODGovernorAbi, functionName: "setDepositor", args: [who, true], gas: 1_000_000n, chain: null, account: t } as never)), "setDepositor");
  const w = walletFor("spare2");
  await ok(await w.writeContract({ address: usdg, abi: erc20Abi, functionName: "approve", args: [gov, 2n ** 255n], chain: null, account: w.account! }), "approve");
  await ok(await w.writeContract({ address: gov, abi: IODGovernorAbi, functionName: "deposit", args: [BigInt(SEED_CAPITAL_USDG) * 10n ** 6n, who], gas: 3_000_000n, chain: null, account: w.account! } as never), "Governor deposit");
  // Cache the new equity and stress now rather than at the crank's next pass (permissionless).
  const c = walletFor("crank");
  await ok(await c.writeContract({ address: gov, abi: IODGovernorAbi, functionName: "pokeRisk", args: [d.markets.map((m) => marketId(m.symbol))], gas: 8_000_000n, chain: null, account: c.account! } as never), "pokeRisk");
  return `Governor capital seeded: ${SEED_CAPITAL_USDG} USDG from spare2`;
}

/**
 * The vol engine's oracle address and market keys, read from the deployment record. The engine keys a market as
 * keccak256(symbol) by default, but the deployed minter reads the oracle under the deployment's market id (the
 * right-padded bytes32 of the symbol, `marketId`), so without these overrides every post lands on a key nothing reads and
 * buys stay closed with VOL_HARD_STALE. Pair gears read keccak256(abi.encode(idA, idB)). Empty until the deploy wrote the
 * record (the engine then refuses to start, which is the old behaviour, not a silent wrong key).
 */
export function volEngineEnv(file = DEPLOYMENT_FILE): Record<string, string> {
  if (!existsSync(file)) return {};
  const d = JSON.parse(readFileSync(file, "utf8")) as Partial<ForkDeploymentLike>;
  const oracle = d.contracts?.ODVolOracle;
  const ids = new Map<string, Hex>();
  for (const m of d.markets ?? []) ids.set(m.symbol.toUpperCase(), (m.id as Hex | undefined) ?? marketId(m.symbol));
  const keys = [...ids].map(([sym, id]) => `${sym}=${id.toLowerCase()}`);
  for (const g of d.gears ?? []) {
    const a = g.marketA?.toUpperCase();
    const b = g.marketB?.toUpperCase();
    if (!a || !b || !ids.has(a) || !ids.has(b)) continue;
    const pair = `${a}/${b}=${keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [ids.get(a)!, ids.get(b)!]))}`;
    if (!keys.includes(pair)) keys.push(pair);
  }
  return { ...(oracle ? { VOL_ORACLE_ADDRESS: getAddress(oracle) } : {}), ...(keys.length ? { VOL_KEYS: keys.join(",") } : {}) };
}
type ForkDeploymentLike = {
  contracts: Record<string, string>;
  markets: { symbol: string; id?: string }[];
  gears: { marketA?: string | null; marketB?: string | null }[];
};

async function relax(): Promise<void> {
  const marker = join(FORK_DIR, "relaxations.json");
  if (existsSync(marker)) { console.log("setup: relaxations already applied (relaxations.json)"); return; }
  const { pub } = await assertFork();
  const dep = loadDeployment();
  const guard = getAddress(dep.contracts.ODOracleGuard ?? "");
  const applied: { market: string; tx: Hex }[] = [];
  await asTimelock(async (wallet, timelock) => {
    for (const m of dep.markets) {
      const id = marketId(m.symbol);
      const cfg = (await pub.readContract({ address: guard, abi: IODOracleGuardAbi, functionName: "config", args: [id] })) as unknown as MarketCfg;
      const hash = await wallet.writeContract({
        address: guard, abi: IODOracleGuardAbi, functionName: "setMarket", args: [id, relaxedMarket(cfg) as never], chain: null, account: timelock,
      });
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`relax ${m.symbol}: ${hash} reverted`);
      applied.push({ market: m.symbol, tx: hash });
    }
  });
  writeFileSync(marker, `${JSON.stringify({ relaxations: RELAXATIONS, applied, by: "timelock (impersonated)" }, null, 1)}\n`);
  console.log(`setup: relaxations ${RELAXATIONS.map((x) => x.id).join(", ")} applied through the timelock on ${applied.length} markets`);
}

interface SafeBatch { chainId?: string | number; transactions: { to: Address; value: string; data: Hex }[] }

async function sendBatch(file: string, label: string): Promise<Hex[]> {
  const { pub } = await assertFork();
  const batch = JSON.parse(readFileSync(file, "utf8")) as SafeBatch;
  const owner = walletFor("owner");
  const hashes: Hex[] = [];
  for (const t of batch.transactions) {
    let hash: Hex;
    try {
      hash = await owner.sendTransaction({ to: getAddress(t.to), data: t.data, value: BigInt(t.value || "0"), chain: null, account: owner.account! });
    } catch (e) {
      // TimelockUnexpectedOperationState: the operation was scheduled by an earlier, interrupted run.
      if (label.startsWith("schedule") && String((e as Error).message).includes("0x5ead8eb5")) { console.log(`setup: ${label} already scheduled`); continue; }
      throw e;
    }
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label}: ${hash} reverted`);
    hashes.push(hash);
  }
  return hashes;
}

/** Pushes the US session calendar the way the crank's sessions job does (same `computeSessions` and `setSessionsWithKinds`, signed by
 * the crank keeper). Called directly, never through `crank --once`: that waits forever on the single-instance lock once the crank
 * service runs. A push made before a warp keeps a weekend instant CLOSED (a later push starts at the next open). */
export async function pushSessionCalendar(): Promise<string> {
  const { pub } = await assertFork();
  const dep = loadDeployment();
  const { computeSessions, KIND_CODE } = await import("../../src/crank/sessions");
  const { IODMarketHoursAbi } = await import("@/abi/IODMarketHours");
  const next = computeSessions(new Date(Number((await pub.getBlock()).timestamp) * 1000), "us_equity", 30);
  const w = walletFor("crank");
  const hash = await w.writeContract({
    address: getAddress(dep.contracts.ODMarketHours ?? ""), abi: IODMarketHoursAbi, functionName: "setSessionsWithKinds", gas: 8_000_000n, chain: null, account: w.account!,
    args: [next.map((x) => ({ open: x.open, close: x.close })), next.map((x) => KIND_CODE[x.kind as "regular" | "extended"])],
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`session calendar push reverted (${hash})`);
  return hash;
}

/** Moves the clock at least `minSec`, then to the first US regular session (+10 min) that ODMarketHours reports OPEN for
 * a stock market (holidays are skipped by asking the contract, not a calendar). Returns the new timestamp. */
export async function warpToOpenSession(minSec = 0): Promise<number> {
  const { pub, test } = await assertFork();
  const dep = loadDeployment();
  const guard = getAddress(dep.contracts.ODOracleGuard ?? "");
  const stock = dep.markets.find((m) => m.kind === "stock");
  let from = Number((await pub.getBlock()).timestamp) + minSec;
  for (let i = 0; i < 10; i++) {
    const now = Number((await pub.getBlock()).timestamp);
    const target = warpTarget(from, "to-next-open") + 600;
    await test.increaseTime({ seconds: target - now });
    await test.mine({ blocks: 1 });
    if (!stock) return target;
    const r = (await pub.readContract({ address: guard, abi: IODOracleGuardAbi, functionName: "read", args: [marketId(stock.symbol)] })) as { session: number };
    if (r.session === SESSION_OPEN) return target;
    from = target + 3600;
  }
  throw new Error("no open session found within 10 tries");
}
export const SESSION_OPEN = 0; // ODTypes Session.OPEN

async function listGears(): Promise<void> {
  const marker = join(FORK_DIR, "gears-listed.json");
  if (existsSync(marker)) { console.log("setup: list-gears skip (gears-listed.json)"); return; }
  const schedule = join(ROOT, ".batches", "fork-list-gears.json");
  const execute = join(ROOT, ".batches", "fork-list-gears.execute.json");
  if (!existsSync(schedule)) { console.log("setup: list-gears skip (no batch: every gear listed)"); return; }
  const { pub, test } = await assertFork();
  const dep = loadDeployment();
  if (getAddress(dep.admin.ownerSafe) !== addressOf("owner")) throw new Error("ownerSafe is not anvil account 1; was the deploy config remapped?");
  const scheduled = await sendBatch(schedule, "schedule list-gears");
  // Past minDelay, then on to the next US regular session (+10 min): a stock market lists only from a live price, and a
  // closed-session read has no last good price on a fresh deployment.
  await test.increaseTime({ seconds: Number(dep.admin.minDelaySec) + 1 });
  await test.mine({ blocks: 1 });
  // ODMarketHours is keeper-fed: push the US session calendar as the crank keeper (the crank service is not up yet and its
  // single-instance lock would block `crank --once`), then the clock goes to a session the contract calls OPEN.
  await pushSessionCalendar();
  const target = await warpToOpenSession();
  await refreshPyth();
  const executed = await sendBatch(execute, "execute list-gears");
  writeFileSync(marker, `${JSON.stringify({ scheduled, executed, clockAt: new Date(target * 1000).toISOString() }, null, 1)}\n`);
  console.log(`setup: list-gears scheduled and executed through the timelock (${scheduled.length}+${executed.length} txs, clock now ${new Date(target * 1000).toISOString()})`);
}

const GEAR_NAMES = ["CRUISE", "SPORT", "RACE", "ECO", "REVERSE"] as const;
export const POWER_OF_GEAR: Record<number, string> = { 0: "1.5", 1: "2", 2: "3", 3: "0.5", 4: "-1" };
const asciiOf = (b: Hex) => bytes32Text(b);

/** The deployment file's `gears` rebuilt from ODGearRegistry (the deploy writes `gears: []` before the list-gears batch runs, and the
 * API resolves a gear, its symbol, cap and unit only from that file). Writes the file when the list changed; true when it did. */
export async function fillDeploymentGears(): Promise<boolean> {
  const { pub } = await assertFork();
  const file = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Record<string, unknown> & { gears: unknown[]; contracts: Record<string, string> };
  const reg = getAddress(file.contracts.ODGearRegistry ?? "");
  const hook = getAddress(file.contracts.ODHook ?? "");
  const n = Number(await pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "gearCount" }));
  const gears: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const id = (await pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "gearIdAt", args: [BigInt(i)] })) as Hex;
    const g = (await pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "gear", args: [id] })) as unknown as { marketA: Hex; marketB: Hex; gear: number; token: Address; unitWad: bigint; capUsdWad: bigint; spreadBps: number };
    const symbol = (await pub.readContract({ address: g.token, abi: parseAbi(["function symbol() view returns (string)"]), functionName: "symbol" })) as string;
    const poolId = (await pub.readContract({ address: hook, abi: ABIS.IODHook as never, functionName: "poolIdOf", args: [id] })) as Hex;
    gears.push({
      id, symbol, gear: GEAR_NAMES[g.gear], power: POWER_OF_GEAR[g.gear], marketA: asciiOf(g.marketA), marketB: /^0x0+$/.test(g.marketB) ? null : asciiOf(g.marketB),
      token: getAddress(g.token), poolId, capUsd: (g.capUsdWad / 10n ** 18n).toString(), spreadBps: g.spreadBps, unitUsd: (g.unitWad / 10n ** 18n).toString(),
    });
  }
  if (JSON.stringify(gears) === JSON.stringify(file.gears)) { console.log(`setup: deployment gears already filled (${n})`); return false; }
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify({ ...file, gears }, null, 2)}\n`);
  console.log(`setup: deployment.json gears filled from the registry (${n})`);
  return true;
}

export function envText(vars: Record<string, string | number>): string {
  return `${Object.entries(vars).map(([k, v]) => `${k}=${/[\s"'$`\\]/.test(String(v)) ? JSON.stringify(String(v)) : v}`).join("\n")}\n`;
}

function existingMcpToken(): string | undefined {
  const file = join(FORK_DIR, "env", "mcp.env");
  if (!existsSync(file)) return undefined;
  return /^MCP_HTTP_TOKEN=([0-9a-f]{32})$/m.exec(readFileSync(file, "utf8"))?.[1];
}

const keyVars = (role: Role, prefix: string) => ({ [`${prefix}_KEYSTORE`]: keystorePath(role), [`${prefix}_KEYSTORE_PASSWORD_FILE`]: passwordFile() });

/** One env file per service, in the production shape (keystores, no raw keys), pointed at the fork only. */
export function serviceEnv(): Record<string, Record<string, string | number>> {
  const shared = {
    NODE_ENV: "development", NETWORK: "fork", CHAIN_ID: 31337, DATABASE_URL, PUBLIC_RPC_URL: ANVIL_URL, RPC_URL_OVERRIDE: ANVIL_URL,
    RPC_BACKUP_URL: "", ALCHEMY_API_KEYS: "", DEPLOYMENT_FILE, LOG_LEVEL: "info",
    INDEXER_POLL_ACTIVE_MS: 1000, INDEXER_POLL_BASE_MS: 2000, INDEXER_POLL_IDLE_MS: 5000,
  };
  return {
    indexer: { ...shared },
    // The API refuses a role that can write: it reads through the SELECT-only role of scripts/api-readonly-role.sql
    // (trust auth on the fork's own loopback cluster, so no password).
    api: {
      ...shared, DATABASE_URL: DATABASE_URL.replace(/^postgres:\/\/[^@]+@/, "postgres://overdrive_api@"), API_PORT: PORTS.api, API_RATE_LIMIT_PER_MINUTE: 0, API_WRITE_RATE_LIMIT_PER_MINUTE: 0,
      CORS_ORIGINS: [PORTS.web].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(","),
    },
    crank: { ...shared, ...keyVars("crank", "CRANK"), CRANK_DRY_RUN: 0, CRANK_TOLL_MAX_AGE_SECONDS: 300 },
    hedger: { ...shared, ...keyVars("hedger", "HEDGER"), // Live hedge posting is refused by src/bin/hedger.ts until the transaction queue lands (its own message); dry run
      // until then (22c G05 needs it live: follow-up).
      HEDGER_DRY_RUN: 1, HEDGER_VENUES: "mock" },
    liquidator: { ...shared, ...keyVars("liquidator", "LIQUIDATOR"), LIQUIDATOR_DRY_RUN: 0 },
    mcp: {
      // The hosted HTTP server is read only and refuses to start holding an agent key.
      ...shared, OD_API_URL: API_URL, AGENT_RPC_URL: ANVIL_URL, AGENT_CHAIN_ID: 31337,
      AGENT_OWNER: addressOf("agentOwner"), MCP_MODE: "read_only", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: PORTS.mcp,
      MCP_HTTP_TOKEN: existingMcpToken() ?? randomBytes(16).toString("hex"), MCP_RATE_LIMIT_PER_MINUTE: 600,
    },
    "vol-engine": {
      DATABASE_URL, ...keyVars("volSigner", "VOL_SIGNER"), ...keyVars("volSender", "VOL_SENDER"), VOL_SEND: 1, VOL_CLOCK: "chain",
      VOL_CHAIN_ID: 31337, VOL_RPC_URL: ANVIL_URL, ...volEngineEnv(),
    },
    // Vite gives process env priority over web/.env.fork, so a stack on another PORT_OFFSET points the site at its own API.
    web: { VITE_API_ORIGIN: API_URL, VITE_CHAIN_ID: 31337 },
  };
}

function writeEnv(): void {
  mkdirSync(join(FORK_DIR, "env"), { recursive: true, mode: 0o700 });
  for (const [name, vars] of Object.entries(serviceEnv())) writeFileSync(join(FORK_DIR, "env", `${name}.env`), envText(vars), { mode: 0o600 });
  console.log(`setup: env files in ${join(FORK_DIR, "env")}`);
}

if (import.meta.main) {
  const has = (f: string) => process.argv.includes(f);
  if (has("--keystores")) console.log(`setup: throwaway keystores in ${join(FORK_DIR, "keys")} (${writeKeystores()} written)`);
  if (has("--config")) writeDeployConfig();
  if (has("--clear-delegations")) console.log(`setup: cleared EIP-7702 delegation code on ${await clearDevDelegations()} anvil dev accounts`);
  if (has("--relax")) await relax();
  if (has("--relax") || has("--refresh-pyth")) console.log(`setup: R5.4 mock Pyth priced from the feeds for ${await refreshPyth()} markets`);
  if (has("--list-gears")) await listGears();
  if (has("--fill-gears")) await fillDeploymentGears();
  if (has("--env")) writeEnv();
  if (has("--seed-capital")) console.log(`setup: ${await seedCapital()}`);
  void forkClients;
}

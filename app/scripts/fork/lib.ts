// Shared helpers for the anvil mainnet-fork scripts (setup, fund, warp, warm, exercise). Ports and paths follow env.sh.
// Fork only: every client here talks to the local anvil node, which must report chain 31337 and an anvil client version.
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  bytesToHex, concat, createPublicClient, createTestClient, createWalletClient, getAddress, http, keccak256, parseAbi,
  type Address, type Hex, type PublicClient, type TestClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const FORK_CHAIN_ID = 31337;
const offset = Number(process.env.PORT_OFFSET ?? "0");
export const APP = resolve(import.meta.dir, "../..");
export const ROOT = resolve(APP, "..");
export const FORK_DIR = process.env.FORK_DIR ?? join(process.env.HOME ?? APP, ".overdrive", "fork");
export const PORTS = {
  anvil: 8545 + offset, cache: 9545 + offset, pg: 5433 + offset, api: 3101 + offset, mcp: 3102 + offset, web: 4291 + offset,
} as const;
export const ANVIL_URL = process.env.ANVIL_URL ?? `http://127.0.0.1:${PORTS.anvil}`;
export const API_URL = process.env.API_URL ?? `http://127.0.0.1:${PORTS.api}`;
export const MCP_URL = `http://127.0.0.1:${PORTS.mcp}`;
export const DATABASE_URL = process.env.DATABASE_URL ?? `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:${PORTS.pg}/od_fork`;
export const DEPLOYMENT_FILE = join(FORK_DIR, "deployment.json");
export const FORK_CONFIG_FILE = join(import.meta.dir, "config", "deploy.fork.json");

export const forkChain = {
  id: FORK_CHAIN_ID, name: "Overdrive fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
} as const;

/** True for a loopback RPC URL (the only kind a fork script may talk to). */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/** anvil's `--config-out` file: the dev accounts and their well-known keys. Lives in FORK_DIR, never in the repo. */
export interface AnvilAccounts { available_accounts: Address[]; private_keys: Hex[] }
export function anvilAccounts(): AnvilAccounts {
  const file = join(FORK_DIR, "anvil-accounts.json");
  if (!existsSync(file)) throw new Error(`${file} is missing: start the fork with scripts/fork/up.sh`);
  return JSON.parse(readFileSync(file, "utf8")) as AnvilAccounts;
}

/** Who plays which part on the fork. config/deploy.fork.json maps the deploy roles to the same indexes. */
export const ROLE_INDEX = {
  deployer: 0, owner: 1, guardian: 2, crank: 3, hedger: 4, volSigner: 5, paymasterSigner: 6, treasury: 7, liquidator: 8,
  volSender: 9, agent: 10, agentOwner: 11, alice: 12, bob: 13, carol: 14, backer: 15, backer2: 16, dave: 17, spare1: 18, spare2: 19,
} as const;
export type Role = keyof typeof ROLE_INDEX;
const indexOf = (role: Role | number) => (typeof role === "number" ? role : ROLE_INDEX[role]);

export const addressOf = (role: Role | number): Address => {
  const a = anvilAccounts().available_accounts[indexOf(role)];
  if (!a) throw new Error(`anvil account ${indexOf(role)} missing (start anvil with --accounts 20)`);
  return getAddress(a);
};
/** The dev key of a role (anvil's well-known keys, fork only). Never print it. */
export const keyOf = (role: Role | number): Hex => {
  const k = anvilAccounts().private_keys[indexOf(role)];
  if (!k) throw new Error(`anvil key ${indexOf(role)} missing`);
  return k;
};

/** The deployment written by app/scripts/deploy-fork.sh (contracts/script/DeploySystem.s.sol), copied into FORK_DIR. */
export interface ForkDeployment {
  chainId: number;
  network: string;
  startBlock: number;
  deployer: Address;
  admin: { ownerSafe: Address; timelock: Address; guardianSafe: Address; minDelaySec: number };
  external: Record<string, Address>;
  contracts: Record<string, Address>;
  markets: { symbol: string; kind: string; feed: Address; stockAsset: Address; [k: string]: unknown }[];
  gears: { symbol?: string; token?: Address; [k: string]: unknown }[];
}
export function loadDeployment(file = DEPLOYMENT_FILE): ForkDeployment {
  if (!existsSync(file)) throw new Error(`${file} is missing: run scripts/fork/up.sh first`);
  const d = JSON.parse(readFileSync(file, "utf8")) as ForkDeployment;
  if (d.chainId !== FORK_CHAIN_ID) throw new Error(`deployment is chain ${d.chainId}, not the fork (${FORK_CHAIN_ID})`);
  return d;
}

export interface ForkConfig {
  roles: Record<string, Role>;
  usdgHolder: Address;
  relaxations: { feedMaxAgeSec: number; feedMaxAgeClosedSec: number; refBandBps: number; refMaxAgeSec: number };
  warm: { codeOnly: Address[] };
}
export const loadForkConfig = (file = FORK_CONFIG_FILE): ForkConfig => JSON.parse(readFileSync(file, "utf8")) as ForkConfig;

export interface ForkClients { pub: PublicClient; test: TestClient<"anvil"> }
export function forkClients(url = ANVIL_URL): ForkClients {
  if (!isLocalUrl(url)) throw new Error(`fork scripts only talk to a local node, not ${url}`);
  const transport = http(url, { timeout: 120_000, retryCount: 3 });
  return {
    pub: createPublicClient({ chain: forkChain, transport, pollingInterval: 250 }) as PublicClient,
    test: createTestClient({ chain: forkChain, mode: "anvil", transport }),
  };
}

/** Throws unless the node is a local anvil on chain 31337 (todo 22 R1). Call first in every script that writes. */
export async function assertFork(url = ANVIL_URL): Promise<ForkClients> {
  const c = forkClients(url);
  const id = await c.pub.getChainId();
  if (id !== FORK_CHAIN_ID) throw new Error(`not the anvil fork: chain ${id}, expected ${FORK_CHAIN_ID}; refusing`);
  const version = String(await c.pub.request({ method: "web3_clientVersion" as never }));
  if (!version.toLowerCase().includes("anvil")) throw new Error(`not an anvil node (${version}); refusing`);
  return c;
}

/** A wallet for one of anvil's dev accounts (signs locally with its well-known key). */
export function walletFor(role: Role | number): WalletClient {
  return createWalletClient({ chain: forkChain, transport: http(ANVIL_URL, { timeout: 120_000 }), account: privateKeyToAccount(keyOf(role)) });
}

/** A wallet that sends as `address` through anvil impersonation (contracts included). Used for the timelock and the USDG
 * holder; nothing is written to storage directly. Gives the address 100 ETH for gas. */
export async function impersonated(test: TestClient<"anvil">, address: Address): Promise<WalletClient> {
  await test.impersonateAccount({ address });
  await test.setBalance({ address, value: 10n ** 20n });
  return createWalletClient({ chain: forkChain, transport: http(ANVIL_URL, { timeout: 120_000 }), account: address });
}

/** Runs `fn` as the timelock (every fork relaxation and admin step goes through it, never through storage writes). */
export async function asTimelock<T>(fn: (wallet: WalletClient, timelock: Address) => Promise<T>): Promise<T> {
  const { test } = forkClients();
  const timelock = getAddress(loadDeployment().admin.timelock);
  const wallet = await impersonated(test, timelock);
  try {
    return await fn(wallet, timelock);
  } finally {
    await test.stopImpersonatingAccount({ address: timelock });
  }
}

/** Gas estimate taken one second ahead of the next block (todo 22 R8): a time-based accrual estimated in the same second
 * as the send under-reports gas. Uses a snapshot, so the chain clock is unchanged afterwards. */
export async function estimateGasAhead(args: { account: Address; to: Address; data: Hex; value?: bigint }): Promise<bigint> {
  const { pub, test } = forkClients();
  const id = await test.snapshot();
  try {
    await test.increaseTime({ seconds: 1 });
    await test.mine({ blocks: 1 });
    return await pub.estimateGas(args);
  } finally {
    await test.revert({ id });
  }
}

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }

/** Web3 Secret Storage v3 (scrypt, aes-128-ctr) for the throwaway fork keystores; small scrypt N because the keys are
 * anvil's public dev keys. src/keys.ts decryptKeystore reads it back; forge reads it with --keystore. */
export function encryptKeystore(key: Hex, password: string, n = 4096): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk = scryptSync(Buffer.from(password.normalize("NFKD"), "utf8"), salt, 32, { N: n, r: 8, p: 1, maxmem: 256 * n * 8 + 1024 * 1024 });
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(Buffer.from(key.slice(2), "hex")), c.final()]);
  const mac = keccak256(concat([bytesToHex(new Uint8Array(dk.subarray(16, 32))), bytesToHex(new Uint8Array(ct))]));
  return JSON.stringify({
    version: 3, id: crypto.randomUUID(), address: privateKeyToAccount(key).address.slice(2).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr", ciphertext: ct.toString("hex"), cipherparams: { iv: iv.toString("hex") },
      kdf: "scrypt", kdfparams: { dklen: 32, n, r: 8, p: 1, salt: salt.toString("hex") }, mac: mac.slice(2),
    },
  });
}

/** Next instant at or after `from` whose New York wall clock is weekday `dow` (0 Sun..6 Sat) at hh:mm. */
export function nextNy(from: number, dow: number, hh: number, mm = 0): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
    return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? ""), h: Number(p.hour), m: Number(p.minute) };
  };
  let t = Math.ceil(from / 60) * 60;
  for (let i = 0; i < 60 * 24 * 8; i++, t += 60) {
    const p = parts(t);
    if (p.dow === dow && p.h === hh && p.m === mm) return t;
  }
  throw new Error("no such time within 8 days");
}

/** Reads one of FORK_DIR/env/<name>.env (KEY=value lines, JSON-quoted values) into an object. */
export function readEnvFile(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(FORK_DIR, "env", `${name}.env`), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.startsWith('"') ? (JSON.parse(m[2]!) as string) : m[2]!;
  }
  return out;
}

/** Runs a service's production entry point once (`bun src/bin/<name>.ts --once`) with its fork env file plus `extra`. */
export function runOnce(name: "crank" | "liquidator", extra: Record<string, string> = {}): { ok: boolean; output: string } {
  const env = { ...process.env, ...readEnvFile(name), ...extra };
  const p = Bun.spawnSync([process.execPath, `src/bin/${name}.ts`, "--once"], { cwd: APP, env, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, output: `${p.stdout.toString()}${p.stderr.toString()}` };
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { getAddress, isAddress } from "viem";
import schema from "../../deployments/schema.json";

export type Address = `0x${string}`;

export interface Deployment {
  chainId: number;
  network: "mainnet" | "testnet" | "fork" | "anvil";
  commit: string;
  deployedAt: string;
  startBlock: number;
  deployer: Address;
  admin: { ownerSafe: Address; timelock: Address; guardianSafe: Address; minDelaySec: number };
  external: {
    usdg: Address;
    poolManager: Address;
    stateView: Address;
    v4Quoter: Address;
    pythCore: Address;
    permit2: Address;
    entryPoint: Address;
    v3Factory: Address;
  };
  contracts: Record<string, Address | "">;
  markets: Array<{
    id: `0x${string}`;
    symbol: string;
    kind: "stock" | "crypto";
    feed: Address;
    stockToken: Address | null;
    multiplierEmbedded: boolean;
    pythId: `0x${string}` | null;
    twapPool: Address | null;
    alwaysOpen: boolean;
  }>;
  gears: Array<{
    id: `0x${string}`;
    symbol: string;
    gear: "CRUISE" | "SPORT" | "RACE" | "ECO" | "REVERSE";
    power: string;
    marketA: string;
    marketB: string | null;
    token: Address;
    poolId: `0x${string}`;
    capUsd: string;
    spreadBps: number;
    unitUsd: string;
  }>;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const DIR = join(import.meta.dir, "..", "..", "deployments");

/** Every 20-byte hex string in the file must be a correctly checksummed address (ids and pool ids are 32 bytes). */
function assertChecksums(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]{40}$/.test(value) && (!isAddress(value, { strict: false }) || getAddress(value) !== value)) {
      throw new Error(`deployment: ${path} is not a checksummed address: ${value}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertChecksums(v, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertChecksums(v, `${path}.${k}`);
  }
}

/**
 * Contracts that may be empty on any network. ODStake: mainnet deploys in two phases, the system before the $OVRD token
 * exists and the stake after (contracts/script/DeployStake.s.sol), so a phase 1 record has no stake.
 */
export const OPTIONAL_CONTRACTS: ReadonlySet<string> = new Set(["ODStake"]);

/** Validates an object against the schema, the checksum rule and the "empty contracts only on anvil" rule (OPTIONAL_CONTRACTS aside). */
export function parseDeployment(raw: unknown): Deployment {
  if (!validate(raw)) {
    throw new Error(`deployment: schema violation: ${ajv.errorsText(validate.errors)}`);
  }
  assertChecksums(raw, "$");
  const d = raw as unknown as Deployment;
  if (d.network !== "anvil") {
    for (const [name, addr] of Object.entries(d.contracts)) {
      if (addr === "" && !OPTIONAL_CONTRACTS.has(name)) throw new Error(`deployment: contracts.${name} is empty on network ${d.network}`);
    }
  }
  return d;
}

function fileFor(chainId: number): string {
  if (chainId === 4663) return "mainnet.json";
  if (chainId === 46630) return "testnet.json";
  if (chainId === 31337) return "anvil.json";
  return `${chainId}.json`;
}

/** Loads app/deployments/<chain>.json (mainnet 4663, testnet 46630, anvil 31337, otherwise <chainId>.json). */
export function loadDeployment(chainId: number, dir: string = DIR): Deployment {
  const file = join(dir, fileFor(chainId));
  const d = parseDeployment(JSON.parse(readFileSync(file, "utf8")));
  if (d.chainId !== chainId) throw new Error(`deployment: ${file} is for chain ${d.chainId}, not ${chainId}`);
  return d;
}

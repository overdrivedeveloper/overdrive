// Thin wrapper over lib/deployments.ts (the one parser of app/deployments/<chain>.json). It adds the network checks and the
// fork identity check; it never re-parses addresses itself.
import { readFileSync } from "node:fs";
import { NETWORK_CHAIN_IDS, type RuntimeConfig } from "../config";
import { parseDeployment, type Deployment } from "../lib/deployments";

export type { Deployment };

export class DeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentError";
  }
}

/** The deployment `network` values a service NETWORK may run against ("fork" also accepts the anvil file). */
const ALLOWED: Record<RuntimeConfig["NETWORK"], readonly Deployment["network"][]> = {
  mainnet: ["mainnet"],
  testnet: ["testnet"],
  fork: ["fork", "anvil"],
};

/** Throws unless the deployment is the one this service's NETWORK and CHAIN_ID name. */
export function assertDeploymentNetwork(deployment: Pick<Deployment, "chainId" | "network">, config: Pick<RuntimeConfig, "NETWORK" | "CHAIN_ID">): void {
  if (deployment.chainId !== config.CHAIN_ID) {
    throw new DeploymentError(`deployment is for chain ${deployment.chainId} but CHAIN_ID is ${config.CHAIN_ID}`);
  }
  if (NETWORK_CHAIN_IDS[config.NETWORK] !== deployment.chainId) {
    throw new DeploymentError(`deployment chain ${deployment.chainId} does not match NETWORK ${config.NETWORK}`);
  }
  if (!ALLOWED[config.NETWORK].includes(deployment.network)) {
    throw new DeploymentError(`deployment network "${deployment.network}" cannot run with NETWORK=${config.NETWORK}`);
  }
}

/** Reads DEPLOYMENT_FILE through the shared parser (schema, checksums, empty-address rules) and checks the network. */
export function loadDeploymentFile(config: Pick<RuntimeConfig, "NETWORK" | "CHAIN_ID" | "DEPLOYMENT_FILE">): Deployment {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(config.DEPLOYMENT_FILE, "utf8"));
  } catch {
    throw new DeploymentError(`cannot read DEPLOYMENT_FILE ${config.DEPLOYMENT_FILE}`);
  }
  const deployment = parseDeployment(raw);
  assertDeploymentNetwork(deployment, config);
  return deployment;
}

export interface NodeProbe {
  chainId(): Promise<number>;
  clientVersion(): Promise<string>;
}

/** Boot check: eth_chainId equals CHAIN_ID, and on NETWORK=fork the node must be anvil (a fork must never point at a real node). */
export async function assertNodeIdentity(probe: NodeProbe, config: Pick<RuntimeConfig, "NETWORK" | "CHAIN_ID">): Promise<void> {
  const chainId = await probe.chainId();
  if (chainId !== config.CHAIN_ID) throw new DeploymentError(`node reports chain ${chainId}, expected CHAIN_ID ${config.CHAIN_ID}`);
  if (config.NETWORK === "fork") {
    const version = (await probe.clientVersion()).toLowerCase();
    if (!version.includes("anvil")) throw new DeploymentError("NETWORK=fork requires an anvil node; this node is not anvil");
  }
}

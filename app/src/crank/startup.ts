import { keccak256, stringToHex, parseAbi, type Address } from "viem";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";

const roleAbi = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);
export const KEEPER_ROLE = keccak256(stringToHex("KEEPER_ROLE"));
export const GUARDIAN_ROLE = keccak256(stringToHex("GUARDIAN_ROLE"));

export interface RoleRequirement { job: string; contract: string; address: Address; role: "KEEPER_ROLE" | "GUARDIAN_ROLE" }

/** The on-chain roles each enabled job needs from the crank key. `toll`, `poke`, `fees` and the queue are permissionless; only
 * `sessions` needs the KEEPER role (setSessionsWithKinds), and `risk-monitor` needs GUARDIAN_ROLE only when CRANK_AUTOPAUSE=1. */
export function requiredRoles(enabled: ReadonlySet<string>, deployment: Deployment, options: { autopause?: boolean } = {}): RoleRequirement[] {
  const needs: RoleRequirement[] = [];
  const marketHours = deployment.contracts.ODMarketHours;
  if (enabled.has("sessions") && marketHours) needs.push({ job: "sessions", contract: "ODMarketHours", address: marketHours as Address, role: "KEEPER_ROLE" });
  if (enabled.has("risk-monitor") && options.autopause) {
    for (const name of ["ODGovernor", "ODOracleGuard"]) {
      const address = deployment.contracts[name];
      if (address) needs.push({ job: "risk-monitor", contract: name, address: address as Address, role: "GUARDIAN_ROLE" });
    }
  }
  return needs;
}

/** Checks the crank account holds every role its enabled jobs need. Returns the missing ones; a role that cannot be read at
 * all (the contract has no hasRole) is reported as unverified, not missing. */
export async function checkRoles(
  clients: Pick<ServiceClients, "stateClient">,
  needs: readonly RoleRequirement[],
  account: Address,
): Promise<{ missing: RoleRequirement[]; unverified: RoleRequirement[] }> {
  if (!needs.length) return { missing: [], unverified: [] };
  const results = await clients.stateClient.multicall({
    allowFailure: true,
    contracts: needs.map((need) => ({
      address: need.address, abi: roleAbi, functionName: "hasRole" as const,
      args: [need.role === "KEEPER_ROLE" ? KEEPER_ROLE : GUARDIAN_ROLE, account] as const,
    })),
  });
  const missing: RoleRequirement[] = [];
  const unverified: RoleRequirement[] = [];
  results.forEach((result, index) => {
    if (result.status !== "success") unverified.push(needs[index]!);
    else if (!result.result) missing.push(needs[index]!);
  });
  return { missing, unverified };
}

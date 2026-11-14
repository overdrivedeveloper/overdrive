import type { Hex } from "viem";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";
import { IODGearAbi, IODGovernorAbi, IODMinterAbi, IODOracleGuardAbi } from "../abi";
import { wadToUsdg } from "../lib/fixed";
import { sessionName } from "./units";
import type { SnapshotReader } from "./snapshot";

/** Snapshot reads over the state route of the RPC pool. */
export function createChainReader(clients: ServiceClients, deployment: Deployment): SnapshotReader {
  const client = clients.stateClient;
  const governor = deployment.contracts.ODGovernor as `0x${string}`;
  const minter = deployment.contracts.ODMinter as `0x${string}`;
  const guard = deployment.contracts.ODOracleGuard as `0x${string}`;
  return {
    async price(market: Hex) {
      const read = await client.readContract({ address: guard, abi: IODOracleGuardAbi, functionName: "read", args: [market] });
      return { priceWad: read.p, fresh: read.fresh, source: read.refP > 0n ? "chainlink+ref" : "chainlink", session: sessionName(read.session) };
    },
    async gear(gearId: Hex, token: string) {
      const [supply, backerDebt, value] = await Promise.all([
        client.readContract({ address: token as `0x${string}`, abi: IODGearAbi, functionName: "totalSupply" }),
        client.readContract({ address: governor, abi: IODGovernorAbi, functionName: "backerDebt", args: [gearId] }),
        client.readContract({ address: minter, abi: IODMinterAbi, functionName: "valuePerToken", args: [gearId] }),
      ]);
      return { supply, backerDebt, valuePerTokenWad: value[0] };
    },
    async governor() {
      const [equity, exitReserve, exitReserveFloor] = await Promise.all([
        client.readContract({ address: governor, abi: IODGovernorAbi, functionName: "equity" }),
        client.readContract({ address: governor, abi: IODGovernorAbi, functionName: "exitReserve" }),
        client.readContract({ address: governor, abi: IODGovernorAbi, functionName: "exitReserveFloor" }),
      ]);
      return { equity: wadToUsdg(equity), exitReserve, exitReserveFloor };
    },
    // The Governor has no getter for the posted hedge; the hedger (todo 16) owns this column's source. Zero until it posts.
    hedgeDelta: async () => 0n,
  };
}

import { decodeEventLog, parseAbi, toEventSelector, type Abi, type Hex } from "viem";
import {
  IODAgentRouterAbi, IODBackerAbi, IODFeesAbi, IODGearAbi, IODGearRegistryAbi, IODGovernorAbi, IODMinterAbi, IODOracleGuardAbi, IODStakeAbi, IODVolOracleAbi,
} from "../abi";
import type { Deployment } from "../chain/deployment";
import type { ChainEvent, EventSource, RpcLog } from "./types";
import { asAddress, asBigInt, asNumber } from "./units";

const stockEventAbi = parseAbi([
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
  "event OraclePaused()",
  "event OracleUnpaused()",
]);

/** Timelock (OpenZeppelin TimelockController) and guardian Safe events the crank's admin-watch reads. */
const adminEventAbi = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
]);

/** Topics fetched from the Stock Tokens themselves (multiplier and oracle-pause events that drive split days). */
export const watchedStockTopics = stockEventAbi.map((event) => toEventSelector(event)) as readonly Hex[];

export interface EventAddressMaps {
  readonly deployment: Deployment;
  /** gear token address (lowercase) -> gear id */
  readonly gearByToken: ReadonlyMap<string, string>;
}

const CONTRACT_SOURCES: Record<string, { source: EventSource; abi: Abi }> = {
  ODGearRegistry: { source: "registry", abi: IODGearRegistryAbi as Abi },
  ODMinter: { source: "minter", abi: IODMinterAbi as Abi },
  ODGovernor: { source: "governor", abi: IODGovernorAbi as Abi },
  ODBacker: { source: "backer", abi: IODBackerAbi as Abi },
  ODOracleGuard: { source: "oracleGuard", abi: IODOracleGuardAbi as Abi },
  ODVolOracle: { source: "volOracle", abi: IODVolOracleAbi as Abi },
  ODFees: { source: "fees", abi: IODFeesAbi as Abi },
  ODStake: { source: "stake", abi: IODStakeAbi as Abi },
  ODAgentRouter: { source: "agentRouter", abi: IODAgentRouterAbi as Abi },
};

/** Every own-contract address the deployment names (lowercase), the timelock and the guardian Safe, and stock tokens separately. */
export function watchedAddresses(deployment: Deployment): { own: string[]; stock: string[] } {
  const own = new Set<string>();
  for (const [name, address] of Object.entries(deployment.contracts)) if (address && CONTRACT_SOURCES[name]) own.add(address.toLowerCase());
  own.add(deployment.admin.timelock.toLowerCase());
  own.add(deployment.admin.guardianSafe.toLowerCase());
  for (const gear of deployment.gears) own.add(gear.token.toLowerCase());
  const stock = deployment.markets.flatMap((market) => (market.stockToken ? [market.stockToken.toLowerCase()] : []));
  return { own: [...own], stock: [...new Set(stock)] };
}

function locate(address: string, maps: EventAddressMaps): { source: EventSource; abi: Abi } | undefined {
  const { deployment } = maps;
  for (const [name, entry] of Object.entries(CONTRACT_SOURCES)) {
    const configured = deployment.contracts[name];
    if (configured && address === configured.toLowerCase()) return entry;
  }
  if (address === deployment.admin.timelock.toLowerCase() || address === deployment.admin.guardianSafe.toLowerCase()) {
    return { source: "admin", abi: adminEventAbi as unknown as Abi };
  }
  if (maps.gearByToken.has(address)) return { source: "gear", abi: IODGearAbi as Abi };
  if (deployment.markets.some((market) => market.stockToken && address === market.stockToken.toLowerCase())) {
    return { source: "stock", abi: stockEventAbi as unknown as Abi };
  }
  return undefined;
}

function decoded(log: RpcLog, abi: Abi): { eventName: string; args: Record<string, unknown> } | undefined {
  try {
    const result = decodeEventLog({ abi, data: log.data, topics: log.topics as unknown as [Hex, ...Hex[]], strict: false });
    return { eventName: String(result.eventName), args: (result.args ?? {}) as unknown as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/** Decodes one RPC log against the ABI of the contract that emitted it; undefined when the address is not watched or the log does not decode. */
export function decodeChainLog(log: RpcLog, maps: EventAddressMaps, ts: Date): ChainEvent | undefined {
  const address = asAddress(log.address);
  const located = locate(address, maps);
  if (!located) return undefined;
  const event = decoded(log, located.abi);
  if (!event) return undefined;
  const blockNumber = asBigInt(log.blockNumber, -1n);
  const logIndex = asNumber(log.logIndex, -1);
  if (blockNumber < 0n || logIndex < 0 || !log.transactionHash) return undefined;
  return { address, blockNumber, txHash: log.transactionHash.toLowerCase(), logIndex, ts, eventName: event.eventName, args: event.args, source: located.source };
}

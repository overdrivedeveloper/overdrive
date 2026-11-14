import { getAddress, type Address } from "viem";
import type { Deployment } from "../lib/deployments";
import { ToolError } from "./api-client";
import { MAINNET_PIN } from "./pinned.generated";

// The deployment of record, pinned into the npm package. A server that runs on a user's machine must not take the
// addresses it prepares or sends transactions to from the API alone: with a pin, the agent router, quoter, minter, USDG
// and the gear tokens come from the package, and an API that serves other addresses is refused (DEPLOYMENT_MISMATCH).
// One source per copied value: pinned.generated.ts is written by scripts/gen-mcp-pin.ts from deployments/mainnet.json
// and pinned.test.ts keeps it equal to that file.

export interface PinnedDeployment {
  readonly chainId: number;
  readonly router: Address;
  readonly quoter: Address;
  readonly minter: Address;
  readonly usdg: Address;
  readonly registry: Address;
  /** Gear symbol (upper case) to its token. */
  readonly gears: Readonly<Record<string, Address>>;
}

/** The shape /v1/config serves, as far as the pin cares. */
export interface ServedConfig {
  readonly chainId?: number;
  readonly external?: Record<string, string>;
  readonly contracts?: Record<string, string>;
  readonly gears?: ReadonlyArray<{ symbol: string; token: string }>;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;
export const EMPTY_PIN = (chainId: number): PinnedDeployment => ({ chainId, router: ZERO, quoter: ZERO, minter: ZERO, usdg: ZERO, registry: ZERO, gears: {} });

/** Generated at release; empty until the mainnet deployment file exists. */
export const MAINNET_DEPLOYMENT: PinnedDeployment = MAINNET_PIN;

/** The pin a deployment file implies. The generator and the test both call this one function. */
export function pinFromDeployment(d: Pick<Deployment, "chainId" | "external" | "contracts" | "gears">): PinnedDeployment {
  const need = (name: string, value: string | undefined): Address => {
    if (!value) throw new Error(`deployment: ${name} is empty, cannot pin`);
    return getAddress(value);
  };
  return {
    chainId: d.chainId, router: need("ODAgentRouter", d.contracts.ODAgentRouter), quoter: need("v4Quoter", d.external.v4Quoter), minter: need("ODMinter", d.contracts.ODMinter),
    usdg: need("usdg", d.external.usdg), registry: need("ODGearRegistry", d.contracts.ODGearRegistry),
    gears: Object.fromEntries(d.gears.map((g) => [g.symbol.toUpperCase(), getAddress(g.token)] as const).sort(([a], [b]) => a.localeCompare(b))),
  };
}

const same = (a: string | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();
export const isEmptyPin = (pin: PinnedDeployment): boolean => same(pin.router, ZERO);

/** The pin for this chain, or undefined (a testnet, a fork or a release with an empty pin has none). */
export function pinFor(pin: PinnedDeployment | undefined, chainId: number): PinnedDeployment | undefined {
  return pin && pin.chainId === chainId && !isEmptyPin(pin) ? pin : undefined;
}

/** Refuse an API that serves any address other than the pinned ones. A name the API adds later is refused too: the
 * package learns new gears from a new version, not from the API. */
export function assertPinned(pin: PinnedDeployment, served: ServedConfig): void {
  const wrong: string[] = [];
  if (served.chainId !== undefined && served.chainId !== pin.chainId) wrong.push("chainId");
  if (!same(served.contracts?.ODAgentRouter, pin.router)) wrong.push("router");
  if (!same(served.external?.v4Quoter, pin.quoter)) wrong.push("quoter");
  if (!same(served.contracts?.ODMinter, pin.minter)) wrong.push("minter");
  if (!same(served.external?.usdg, pin.usdg)) wrong.push("USDG");
  if (!same(served.contracts?.ODGearRegistry, pin.registry)) wrong.push("registry");
  for (const g of served.gears ?? []) {
    const pinned = pin.gears[g.symbol.toUpperCase()];
    if (!pinned || !same(g.token, pinned)) wrong.push(`gear ${g.symbol.slice(0, 24)}`);
  }
  if (wrong.length > 0) {
    throw new ToolError("DEPLOYMENT_MISMATCH", `The API serves addresses this package was not built with (${wrong.join(", ")}). Nothing was prepared or sent. Update the package.`);
  }
}

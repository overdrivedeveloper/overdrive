import type { Deployment } from "../lib/deployments";

export interface GearRef { id: string; symbol: string; token: string; gear: string; spreadBps: number }
/** A gear by symbol (`TSLA-SPORT`, any case) or by its bytes32 id, from the deployment file only. */
export function resolveGear(deployment: Deployment, idOrSymbol: string): GearRef | undefined {
  const key = idOrSymbol.toLowerCase();
  const g = deployment.gears.find((x) => x.symbol.toLowerCase() === key || x.id.toLowerCase() === key);
  return g ? { id: g.id.toLowerCase(), symbol: g.symbol, token: g.token, gear: g.gear, spreadBps: g.spreadBps } : undefined;
}
export function resolveMarket(deployment: Deployment, idOrSymbol: string) {
  const key = idOrSymbol.toLowerCase();
  return deployment.markets.find((m) => m.symbol.toLowerCase() === key || m.id.toLowerCase() === key);
}

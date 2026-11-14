// Read-only venue check: resolves every route-table Hyperliquid market for the listed symbols live and prints the mid and
// visible depth per side; reports Arcus as unverified until its contracts are in the deployment file. Sends nothing.
// Usage: cd app && HL_NETWORK=testnet bun run scripts/hedger/venue-check.ts TSLA NVDA SPY QQQ ETH
import { bookFromL2, HlHttp, hlRoute, resolveAssets, type FetchLike, type HlNetwork } from "../../src/hedger/venues/hyperliquid";

export async function venueCheck(network: HlNetwork, symbols: readonly string[], o: { fetch?: FetchLike; print?: (l: string) => void } = {}): Promise<number> {
  const print = o.print ?? ((l: string) => console.log(l));
  const http = new HlHttp({ baseUrl: network === "testnet" ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz", ...(o.fetch ? { fetch: o.fetch } : {}) });
  const routes = symbols.map((s) => ({ s, r: hlRoute(network, s) }));
  const assets = await resolveAssets(http, routes.flatMap((x) => (x.r ? [x.r.coin] : [])));
  let missing = 0;
  for (const { s, r } of routes) {
    const a = r ? assets.get(r.coin) : undefined;
    if (!r || !a) { missing++; print(`MISSING  ${s} ${r?.coin ?? "(no route)"}`); continue; }
    const b = bookFromL2(((await http.post("/info", { type: "l2Book", coin: r.coin })) as { levels?: never }).levels);
    print(`OK       ${s} ${r.coin} asset=${a.asset} mid=${b.mid ?? "none"} bidDepthUsd=${b.bidDepthUsd.toFixed(0)} askDepthUsd=${b.askDepthUsd.toFixed(0)}${r.proxy ? " proxy" : ""}`);
  }
  print("UNVERIFIED arcus: perp ABI and addresses not in the deployment file (todo 00)");
  return missing ? 1 : 0;
}

if (import.meta.main) {
  const network = process.env.HL_NETWORK === "testnet" ? "testnet" : "mainnet";
  process.exit(await venueCheck(network, process.argv.slice(2).length ? process.argv.slice(2) : ["TSLA", "NVDA", "SPY", "QQQ", "ETH", "BTC"]));
}

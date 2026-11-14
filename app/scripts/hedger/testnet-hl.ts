// R18: Hyperliquid TESTNET proof, run by the owner (todo 23), never by an agent. Places and cancels one resting minimal
// order, then opens a minimal position with an IOC order, checks the position equals the fill, closes it reduce-only and
// checks it is flat. One line per step. Refuses anything but HL_NETWORK=testnet against the testnet API.
// Env: HL_NETWORK=testnet, HL_ACCOUNT_ADDRESS (the throwaway testnet account), HEDGER_PRIVATE_KEY or HEDGER_KEYSTORE +
// HEDGER_KEYSTORE_PASSWORD_FILE (its agent key), optional HL_TEST_SYMBOL (default TSLA), HL_TEST_USD (default 12).
// Usage: cd app && HL_NETWORK=testnet HL_ACCOUNT_ADDRESS=0x... HEDGER_KEYSTORE=... HEDGER_KEYSTORE_PASSWORD_FILE=... bun run scripts/hedger/testnet-hl.ts
import type { Hex } from "viem";
import { KEY_ROLES, resolveKey } from "../../src/keys";
import { bookFromL2, HlHttp, HlSigner, hlRoute, priceToWire, resolveAssets, sizeToWire, type FetchLike, type HlAction } from "../../src/hedger/venues/hyperliquid";

export const TESTNET_URL = "https://api.hyperliquid-testnet.xyz";

export interface RunOptions { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; print?: (line: string) => void; now?: () => number }

function allowedUrl(url: string): boolean {
  if (url === TESTNET_URL) return true;
  try { const u = new URL(url); return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost"); } catch { return false; }
}

/** Returns the exit code: 0 all steps passed, 1 a step failed, 2 refused. */
export async function runTestnetHl(env: Record<string, string | undefined>, o: RunOptions = {}): Promise<number> {
  const print = o.print ?? ((line: string) => console.log(line));
  const url = env.HL_API_URL?.trim() || TESTNET_URL;
  if (env.HL_NETWORK !== "testnet") { print("REFUSED  HL_NETWORK must be testnet; this script never touches mainnet"); return 2; }
  if (!allowedUrl(url)) { print(`REFUSED  ${url} is not the Hyperliquid testnet API`); return 2; }
  const account = env.HL_ACCOUNT_ADDRESS?.trim() as Hex | undefined;
  if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account)) { print("REFUSED  HL_ACCOUNT_ADDRESS is required"); return 2; }
  let key: Hex | undefined;
  try { key = resolveKey(KEY_ROLES.hedger, env); } catch (error) { print(`REFUSED  ${(error as Error).message}`); return 2; }
  if (!key) { print("REFUSED  no hedger agent key in the environment"); return 2; }

  const now = o.now ?? (() => Date.now());
  const http = new HlHttp({ baseUrl: url, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.sleep ? { sleep: o.sleep } : {}) });
  const signer = new HlSigner(key, "testnet");
  const symbol = env.HL_TEST_SYMBOL?.trim() || "TSLA";
  const usd = Number(env.HL_TEST_USD ?? "12");
  const step = (n: number, ok: boolean, text: string) => { print(`${ok ? "PASS" : "FAIL"}  ${n} ${text}`); return ok; };
  let nonce = now();
  const send = async (action: HlAction) => (await http.post("/exchange", await signer.sign(action, ++nonce))) as { status: string; response?: { data?: { statuses?: unknown[] } } };
  const position = async (coin: string, dex: string) => {
    const s = (await http.post("/info", { type: "clearinghouseState", user: account, ...(dex ? { dex } : {}) })) as { assetPositions?: { position: { coin: string; szi: string } }[] };
    return Number(s.assetPositions?.find((p) => p.position.coin === coin)?.position.szi ?? 0);
  };

  try {
    const route = hlRoute("testnet", symbol);
    if (!route) return step(1, false, `no route-table market for ${symbol}`) ? 0 : 1;
    const asset = (await resolveAssets(http, [route.coin])).get(route.coin);
    if (!step(1, asset !== undefined, `resolve ${route.coin} live${asset ? ` -> asset ${asset.asset}` : " (not listed or delisted)"}`) || !asset) return 1;
    const dex = route.coin.includes(":") ? route.coin.split(":")[0]! : "";
    const book = bookFromL2(((await http.post("/info", { type: "l2Book", coin: route.coin })) as { levels?: never }).levels);
    if (!step(2, book.mid !== null, `l2Book mid ${book.mid ?? "none (empty side)"}`) || book.mid === null) return 1;
    const size = sizeToWire(usd / book.mid, asset.szDecimals);
    const start = await position(route.coin, dex);

    const rest = await send({ type: "order", orders: [{ a: asset.asset, b: true, p: priceToWire(book.mid * 0.8, asset.szDecimals), s: size, r: false, t: { limit: { tif: "Alo" } } }], grouping: "na" });
    const resting = (rest.response?.data?.statuses?.[0] as { resting?: { oid: number } } | undefined)?.resting;
    if (!step(3, rest.status === "ok" && resting !== undefined, `place resting buy ${size} @ 80% of mid${resting ? ` oid ${resting.oid}` : `: ${JSON.stringify(rest).slice(0, 160)}`}`) || !resting) return 1;
    const cancel = await send({ type: "cancel", cancels: [{ a: asset.asset, o: resting.oid }] });
    if (!step(4, cancel.status === "ok" && cancel.response?.data?.statuses?.[0] === "success", `cancel oid ${resting.oid}`)) return 1;

    const open = await send({ type: "order", orders: [{ a: asset.asset, b: true, p: priceToWire(book.mid * 1.01, asset.szDecimals), s: size, r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
    const filled = (open.response?.data?.statuses?.[0] as { filled?: { totalSz: string; avgPx: string } } | undefined)?.filled;
    if (!step(5, open.status === "ok" && filled !== undefined, `IOC buy ${size}${filled ? ` filled ${filled.totalSz} @ ${filled.avgPx}` : `: ${JSON.stringify(open).slice(0, 160)}`}`) || !filled) return 1;
    const target = start + Number(filled.totalSz);
    const after = await position(route.coin, dex);
    if (!step(6, Math.abs(after - target) < 10 ** -asset.szDecimals / 2, `position ${after} equals target ${target}`)) return 1;

    const close = await send({ type: "order", orders: [{ a: asset.asset, b: false, p: priceToWire(book.mid * 0.99, asset.szDecimals), s: filled.totalSz, r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
    const closed = (close.response?.data?.statuses?.[0] as { filled?: { totalSz: string } } | undefined)?.filled;
    if (!step(7, close.status === "ok" && closed !== undefined, `reduce-only IOC sell ${filled.totalSz}`)) return 1;
    const end = await position(route.coin, dex);
    return step(8, Math.abs(end - start) < 10 ** -asset.szDecimals / 2, `position back to ${end} (start ${start})`) ? 0 : 1;
  } catch (error) {
    print(`FAIL  ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runTestnetHl(process.env));

// Builds the vol engine's history seed files from free public data and writes them under src/config (no secrets):
//   src/config/vol-weekend.json  { "NVDA": [0.012, ...] }   26 weeks of absolute Friday close -> Monday open moves
//   src/config/vol-moves.json    { "NVDA": [0.051, -0.07] } the 1-day move after each of the last 8 earnings reports
//
// Sources (no key, no account):
//   daily bars      Yahoo Finance chart endpoint, 3 years of daily open/close (query1.finance.yahoo.com/v8/finance/chart)
//   earnings dates  SEC EDGAR submissions (data.sec.gov): the filing time of each 8-K with Item 2.02 is the release time;
//                   after 16:00 New York time the reaction is the next session, otherwise the same session
//   SPY and QQQ have no earnings: they get a weekend series only. ETH and BTC trade 24/7 and need no seed.
// Run:  bun run scripts/seed-vol-history.ts            (writes the files)
//       bun run scripts/seed-vol-history.ts --check    (fetches, prints, writes nothing)
// SEC asks every client to identify itself: set SEC_USER_AGENT to a contact address before running.
// The engine reads these files from src/config (or VOL_CONFIG_DIR). Yahoo's endpoint is unofficial; if it changes the
// script fails loudly and keeps the old files.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { earningsMoves, parseEdgarReports, parseYahooBars, weekendGaps } from "../src/seed/vol-history";

// The listed equity names (docs/research/feeds.json) and the SEC central index key of each single-name stock.
const NO_EARNINGS = new Set(["SPY", "QQQ"]);
const NAMES = ["TSLA", "NVDA", "SPY", "QQQ", "AAPL", "MSFT", "META", "AMZN", "COIN", "MSTR", "PLTR", "AMD"];
const CIK: Record<string, string> = {
  NVDA: "0001045810", TSLA: "0001318605", AAPL: "0000320193", MSFT: "0000789019", META: "0001326801", AMZN: "0001018724",
  COIN: "0001679788", MSTR: "0001050446", PLTR: "0001321655", AMD: "0000002488",
};
const SEC_AGENT = process.env.SEC_USER_AGENT?.trim();
const check = process.argv.includes("--check");
const outDir = resolve(import.meta.dir, "../src/config");

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} returned HTTP ${response.status}`);
  return response.json();
}

if (!SEC_AGENT) throw new Error("set SEC_USER_AGENT to a contact address (SEC EDGAR requires one)");
const weekend: Record<string, number[]> = {};
const moves: Record<string, number[]> = {};
for (const name of NAMES) {
  const bars = parseYahooBars(
    await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${name}?range=3y&interval=1d`, { "User-Agent": "Mozilla/5.0" }),
  );
  weekend[name] = weekendGaps(bars, 26);
  if (NO_EARNINGS.has(name)) continue;
  const cik = CIK[name];
  if (!cik) throw new Error(`No SEC CIK configured for ${name}`);
  const reports = parseEdgarReports(await getJson(`https://data.sec.gov/submissions/CIK${cik}.json`, { "User-Agent": SEC_AGENT }));
  moves[name] = earningsMoves(bars, reports, 8);
  console.log(`${name}: ${weekend[name]!.length} weekend gaps, ${moves[name]!.length} earnings moves (${reports.length} reports found)`);
  if (moves[name]!.length < 8) console.warn(`${name}: fewer than 8 earnings moves; the engine fills the rest with its default`);
}
if (check) {
  console.log(JSON.stringify({ weekend, moves }, null, 2));
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "vol-weekend.json"), `${JSON.stringify(weekend, null, 2)}\n`);
  writeFileSync(resolve(outDir, "vol-moves.json"), `${JSON.stringify(moves, null, 2)}\n`);
  console.log(`wrote ${outDir}/vol-weekend.json and vol-moves.json`);
}

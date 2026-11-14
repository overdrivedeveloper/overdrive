// Exercise runner (todo 22): bun scripts/fork/exercise/index.ts [--area holders|backers|...] [--only H01,H02] [--resume]
// Each area file exports `flows: Flow[]`; 22c adds backers/governor/service areas by appending to AREAS below.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORK_DIR } from "../lib";
import { makeCtx, runFlow, syncDeployment, type Ctx, type Flow } from "./harness";
import { RESULTS_FILE, loadResults, saveResults, shouldRun, summary, toMarkdown } from "./results";

export interface Area { flows: Flow[]; /** Lists the gears and fixtures the flows need, before the first flow runs. */ prepare?: (ctx: Ctx) => Promise<void> }
export const AREAS: Record<string, () => Promise<Area>> = {
  holders: async () => import("./holders"),
  // 22c: backers, governor, hedger, crank, liquidation, first-money go here.
};

export function parseArgs(argv: string[]): { areas: string[]; only: string[]; resume: boolean } {
  const get = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    areas: get("area") ? get("area")!.split(",") : Object.keys(AREAS),
    only: get("only") ? get("only")!.split(",") : [],
    resume: argv.includes("--resume"),
  };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const ctx = await makeCtx();
  let results = loadResults();
  results = { ...results, forkBlock: String(await ctx.pub.getBlockNumber()) };
  const ran: string[] = [];
  const synced = new Set<string>();
  void synced;
  for (const area of args.areas) {
    const load = AREAS[area];
    if (!load) throw new Error(`unknown area ${area}; known: ${Object.keys(AREAS).join(", ")}`);
    const mod = await load();
    if (mod.prepare) { console.log(`prepare ${area} ...`); await mod.prepare(ctx); }
    for (const flow of mod.flows) {
      if (args.only.length && !args.only.includes(flow.id)) continue;
      if (!shouldRun(results, flow.id, args.resume)) { console.log(`skip ${flow.id} (passed)`); continue; }
      const r = await runFlow(flow, ctx, results);
      results = r.results;
      ran.push(flow.id);
      console.log(`${r.row.status.toUpperCase().padEnd(7)} ${flow.id} ${flow.name.slice(0, 60)}${r.row.error ? `\n        ${r.row.error.split("\n")[0]!.slice(0, 300)}` : ""}`);
    }
  }
  saveResults(results);
  writeFileSync(join(FORK_DIR, "results.md"), toMarkdown(results));
  const s = summary(results, ran);
  console.log(`\n${s.pass}/${s.total} passed, ${s.fail} failed, ${s.blocked} blocked  (${RESULTS_FILE}, ${join(FORK_DIR, "results.md")})`);
  process.exit(s.fail > 0 ? 1 : 0);
}

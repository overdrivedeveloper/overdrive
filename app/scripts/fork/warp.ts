// Moves the fork's clock (todo 22 R8): evm_increaseTime + evm_mine, then waits for the crank's next pass (a new line in
// its log after the warp) so time-based jobs (toll, queued sells, fees) have run. Fork only.
//   bun scripts/fork/warp.ts <seconds | to-next-open | to-next-close | to-weekend> [--no-wait]
// New York times: next open = next weekday 09:30, next close = next weekday 16:00, weekend = next Saturday 12:00.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertFork, FORK_DIR, nextNy } from "./lib";
import { refreshPyth } from "./setup";

/** Target timestamp for a warp argument (pure, tested). */
export function warpTarget(now: number, arg: string): number {
  if (/^\d+$/.test(arg)) return now + Number(arg);
  const weekdays = [1, 2, 3, 4, 5];
  if (arg === "to-next-open") return Math.min(...weekdays.map((d) => nextNy(now + 60, d, 9, 30)));
  if (arg === "to-next-close") return Math.min(...weekdays.map((d) => nextNy(now + 60, d, 16, 0)));
  if (arg === "to-weekend") return nextNy(now + 60, 6, 12, 0);
  throw new Error("usage: bun scripts/fork/warp.ts <seconds | to-next-open | to-next-close | to-weekend> [--no-wait]");
}

/** Waits until the crank log grows after `since` (ms), up to `timeoutMs`. False when no crank runs. */
export async function waitForCrankPass(since: number, timeoutMs = 90_000): Promise<boolean> {
  const log = join(FORK_DIR, "logs", "crank.log");
  if (!existsSync(join(FORK_DIR, "pids", "crank.pid")) || !existsSync(log)) return false;
  const start = statSync(log).size;
  for (const end = since + timeoutMs; Date.now() < end; await Bun.sleep(500)) if (statSync(log).size > start) return true;
  return false;
}

if (import.meta.main) {
  const arg = process.argv[2] ?? "";
  const { pub, test } = await assertFork();
  const now = Number((await pub.getBlock()).timestamp);
  const target = warpTarget(now, arg);
  await test.increaseTime({ seconds: target - now });
  await test.mine({ blocks: 1 });
  const after = Number((await pub.getBlock()).timestamp);
  console.log(`warp: ${new Date(now * 1000).toISOString()} -> ${new Date(after * 1000).toISOString()}`);
  // R5.4: the fork's mock Pyth is re-priced at the new clock, or every market would read REF_UNAVAILABLE after a day.
  console.log(`warp: mock Pyth refreshed for ${await refreshPyth()} markets`);
  if (!process.argv.includes("--no-wait")) {
    console.log(await waitForCrankPass(Date.now()) ? "warp: crank passed after the warp" : "warp: no crank pass seen (crank not running?)");
  }
}

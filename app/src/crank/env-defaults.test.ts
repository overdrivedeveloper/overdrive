import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRANK_JOBS, loadConfig } from "../config";

const TEMPLATE = join(import.meta.dir, "..", "..", "env", "crank.production.env.example");
const parse = (text: string): Record<string, string> => Object.fromEntries(
  text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("crank env", () => {
  test("template_jobs_all_known", () => {
    const env = parse(readFileSync(TEMPLATE, "utf8"));
    for (const key of ["CRANK_ENABLED_JOBS", "CRANK_DISABLED_JOBS"]) {
      for (const name of (env[key] ?? "").split(",").filter(Boolean)) expect(CRANK_JOBS as readonly string[]).toContain(name);
    }
    expect(env.CRANK_ENABLED_JOBS!.split(",").sort()).toEqual([...CRANK_JOBS].sort());
    // production form: keystore only, dry run on until armed, no raw key, no autopause
    expect(env.CRANK_DRY_RUN).toBe("1");
    expect(env.CRANK_AUTOPAUSE).toBe("0");
    expect(Object.keys(env).some((k) => k.endsWith("PRIVATE_KEY"))).toBe(false);
    expect(env.CRANK_KEYSTORE).toBeTruthy();
    const config = loadConfig({ ...env });
    expect(config.CRANK_DRY_RUN).toBe(true);
    expect(config.CRANK_ENABLED_JOBS).toEqual([...CRANK_JOBS]);
  });

  test("defaults_match_the_todo", () => {
    const base = { NODE_ENV: "test", NETWORK: "fork", DATABASE_URL: "postgres://localhost/x" };
    const config = loadConfig(base);
    expect(config).toMatchObject({
      CRANK_DRY_RUN: false, CRANK_AUTOPAUSE: false, CRANK_GAS_MULTIPLIER_BPS: 15_000, CRANK_GAS_HEADROOM: 500_000, CRANK_GAS_CAP: 32_000_000,
      CRANK_TOLL_MAX_AGE_SECONDS: 3600, CRANK_TOLL_BATCH: 40, CRANK_TOLL_GAS_TARGET: 8_000_000, CRANK_QUEUE_MAX_PER_PASS: 25,
      CRANK_QUEUE_RETRY_MS: 600_000, VOL_STALE_WARN_SECONDS: 900, FEES_MIN_USDG: 50,
    });
    expect(config.CRANK_ENABLED_JOBS).toEqual([...CRANK_JOBS]);
    // bounds: the toll age has a floor of 5 minutes and a batch never exceeds 45
    expect(() => loadConfig({ ...base, CRANK_TOLL_MAX_AGE_SECONDS: "60" })).toThrow();
    expect(() => loadConfig({ ...base, CRANK_TOLL_BATCH: "46" })).toThrow();
  });
});

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const COMMITTED = join(ROOT, "app", "src", "abi");

test("abisAreCurrent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "od-abi-"));
  const r = Bun.spawnSync(["bash", join(ROOT, "scripts", "export-abis.sh")], {
    env: { ...process.env, ABI_OUT_DIR: tmp },
  });
  expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);
  const fresh = readdirSync(tmp).sort();
  const committed = readdirSync(COMMITTED).filter((f) => f.endsWith(".json")).sort();
  expect(committed).toEqual(fresh);
  expect(fresh.length).toBeGreaterThanOrEqual(14);
  for (const f of fresh) {
    expect(readFileSync(join(COMMITTED, f), "utf8"), `${f} is stale: run scripts/export-abis.sh`).toBe(
      readFileSync(join(tmp, f), "utf8"),
    );
  }
}, 120_000);

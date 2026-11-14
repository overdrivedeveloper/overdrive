import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drift, generateAll } from "./gen";
import * as abis from "./index";

const ABI_DIR = import.meta.dir;
const ROOT = join(ABI_DIR, "..", "..", "..");

describe("abi gen", () => {
  test("check_detects_drift", () => {
    expect(drift(ABI_DIR, ABI_DIR)).toEqual([]);
    const tmp = mkdtempSync(join(tmpdir(), "od-gen-"));
    for (const [file, content] of generateAll(ABI_DIR)) writeFileSync(join(tmp, file), content);
    expect(drift(ABI_DIR, tmp)).toEqual([]);
    writeFileSync(join(tmp, "IODMinter.ts"), "// tampered\n");
    expect(drift(ABI_DIR, tmp)).toEqual(["IODMinter.ts"]);
    const json = mkdtempSync(join(tmpdir(), "od-json-"));
    cpSync(ABI_DIR, json, { recursive: true, filter: (src) => !src.endsWith(".ts") });
    writeFileSync(join(json, "IODFees.json"), "[]\n");
    for (const [file, content] of generateAll(ABI_DIR)) writeFileSync(join(tmp, file), content);
    expect(drift(json, tmp)).toContain("IODFees.ts");
    const r = Bun.spawnSync(["bun", "run", join(ROOT, "app/scripts/gen-abi-ts.ts"), "--check", "--json-dir", json, "--out-dir", tmp]);
    expect(r.exitCode).toBe(1);
  });
  test("every_interface_exported", () => {
    const names = readdirSync(join(ROOT, "contracts/src/interfaces")).filter((f) => /^IOD.*\.sol$/.test(f)).map((f) => f.replace(".sol", ""));
    expect(names.length).toBeGreaterThanOrEqual(14);
    for (const name of names) {
      expect((abis as Record<string, unknown>)[name], name).toBeDefined();
      expect((abis as Record<string, unknown>)[`${name}Abi`], name).toBeDefined();
    }
  });
});

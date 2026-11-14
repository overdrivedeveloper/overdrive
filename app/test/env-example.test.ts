import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_ENV_KEYS, loadConfig } from "../src/config";

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    expect(eq).toBeGreaterThan(0);
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

describe(".env.example", () => {
  const file = parseEnvFile(join(import.meta.dir, "..", ".env.example"));

  test("lists exactly the variables src/config.ts reads", () => {
    expect(Object.keys(file).sort()).toEqual([...CONFIG_ENV_KEYS].sort());
  });

  test("loads through loadConfig", () => {
    const config = loadConfig(file);
    expect(config.NETWORK).toBe("fork");
    expect(config.CHAIN_ID).toBe(31337);
  });

  test("holds no key, password or token", () => {
    for (const [name, value] of Object.entries(file)) {
      expect(value).not.toMatch(/0x[0-9a-fA-F]{64}/);
      if (name !== "DATABASE_URL") expect(value).not.toMatch(/:\/\/[^/\s]*:[^@\s]+@/);
    }
  });
});

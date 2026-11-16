import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pkgDir = join(import.meta.dir, "..", "..", "..", "sdk", "mcp");
const pkg = () => JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

describe("R12 package", () => {
  test("private_true_and_no_publish_config", () => {
    const p = pkg();
    expect(p.private).toBe(true);
    expect(p.publishConfig).toBeUndefined();
    expect(p.engines.node).toBe(">=20");
    expect(p.files).toEqual(["dist"]);
    expect(Object.values(p.bin)).toEqual(["dist/cli.js"]);
    expect(p.name).toMatch(/placeholder/); // the name is the owner's decision
    expect(p.scripts?.publish).toBeUndefined();
    expect(p.scripts?.prepublishOnly).toBeUndefined();
  });
  test("server.json carries no key, host or registry entry", () => {
    const text = readFileSync(join(pkgDir, "server.json"), "utf8");
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40,}|PRIVATE_KEY|https?:\/\//);
    expect(existsSync(join(pkgDir, "LICENSE"))).toBe(true);
  });
});

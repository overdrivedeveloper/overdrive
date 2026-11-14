// Packs the SDK, unpacks it into an empty temp folder and exercises it under plain Node with a local stub API (no network).
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "ovrd-smoke-"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8" });
const info = JSON.parse(out.slice(out.indexOf("[")))[0];
const files = info.files.map((f) => f.path).sort();
assert.deepEqual(files.filter((f) => !f.startsWith("dist/")), ["LICENSE", "README.md", "package.json"], "only LICENSE, README and package.json outside dist/");
assert.ok(files.every((f) => f.startsWith("dist/") ? /\.(js|d\.ts)$/.test(f) : true), "dist holds only .js and .d.ts");
assert.ok(!files.some((f) => /\.map$|src\/|test\/|openapi/.test(f)), "no sources, maps, tests");
assert.ok(!pkg.dependencies, "no runtime dependencies");

const dir = join(work, "unpacked");
mkdirSync(dir);
execFileSync("tar", ["-xzf", join(work, info.filename), "-C", dir]);
const A = "0x00000000000000000000000000000000000000aa";
const server = createServer((req, res) => {
  const body = req.url === "/v1/intent/buy" ? { tx: { to: A, data: "0x", value: "0" }, approvals: [] } : { ok: true };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const sdk = await import(join(dir, "package", "dist", "index.js"));
const od = new sdk.Overdrive({ baseUrl: base, chainId: 31337 });
assert.deepEqual(await od.health(), { ok: true });
await assert.rejects(od.intent("buy", {}), (e) => e instanceof sdk.OverdriveIntentMismatch, "the shipped deployment file refuses a foreign target");
assert.equal(sdk.formatUnits(sdk.parseUnits("25.5", 6), 6), "25.5");
assert.ok(sdk.DEPLOYMENTS.length >= 1);
server.close();
console.log(`smoke ok: ${pkg.name}@${pkg.version}, ${files.length} files, plain Node ${process.version}`);

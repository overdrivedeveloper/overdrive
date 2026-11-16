// Bundles the repository's MCP server (app/src/mcp, through src/cli.ts) into one Node ESM file, dist/cli.js, with every
// dependency inlined. Never publishes: the package is private. `--check` also verifies the bundle and runs the smoke test.
// Needs Bun and the app's packages: `cd ../../app && bun install --frozen-lockfile`.
// Usage: bun scripts/build.ts [--check]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const check = process.argv.includes("--check");
const appModules = join(root, "../../app/node_modules");
if (!existsSync(join(appModules, "viem"))) {
  console.error("build: the app's packages are missing. Run: (cd ../../app && bun install --frozen-lockfile)");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; private?: boolean; name: string };
let commit = "unknown";
try { commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* not a git checkout */ }

const out = join(root, "dist/cli.js");
const result = await Bun.build({
  entrypoints: [join(root, "src/cli.ts")],
  outdir: join(root, "dist"),
  naming: "cli.js",
  target: "node",
  format: "esm",
  // Whitespace and syntax only: identifiers stay readable, so the file can be audited against this source.
  minify: { whitespace: true, syntax: true, identifiers: false },
  sourcemap: "none",
  banner: `// ${pkg.name} ${pkg.version}, built from app/src/mcp at ${commit}. MIT.`,
  plugins: [{
    // http.ts and api/rate-limit.ts take getConnInfo from "hono/bun". That entry also loads Hono's Bun static-site and
    // WebSocket helpers, which read the Bun global at load and would stop the server on Node. Only getConnInfo is used.
    name: "hono-bun-conninfo-only",
    setup(build) {
      build.onResolve({ filter: /^hono\/bun$/ }, () => ({ path: join(appModules, "hono/dist/adapter/bun/conninfo.js") }));
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The bundle must run on plain Node: no Bun module, and the Bun global read only as globalThis.Bun.
const text = readFileSync(out, "utf8");
if (!text.startsWith("#!/usr/bin/env node\n")) throw new Error("build: the bundle does not start with the node shebang");
const bunImport = /from\s*["']bun(:[a-z]+)?["']|require\(["']bun(:[a-z]+)?["']\)|import\(["']bun(:[a-z]+)?["']\)/.exec(text);
if (bunImport) throw new Error(`build: the bundle imports a Bun module (${bunImport[0]})`);
const bare = [...text.matchAll(/(?<![.\w$])Bun(?![\w$])/g)].map((m) => text.slice(Math.max(0, m.index - 40), m.index + 40));
if (bare.length) throw new Error(`build: the bundle reads the Bun global directly (fails on Node):\n  ${bare.join("\n  ")}`);
console.log(`build: dist/cli.js ${(statSync(out).size / 1024).toFixed(0)} KB (${pkg.name} ${pkg.version}, ${commit})`);

if (check) {
  // R12: single bundled file, a bin, files limited to dist, private, node >= 20, no publish config.
  const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const problems: string[] = [];
  if (p.private !== true) problems.push("private must be true");
  if (JSON.stringify(p.files) !== JSON.stringify(["dist"])) problems.push('files must be ["dist"]');
  if (!p.bin || Object.values(p.bin).join() !== "dist/cli.js") problems.push("bin must be dist/cli.js");
  if (p.engines?.node !== ">=20") problems.push("engines.node must be >=20");
  if (p.publishConfig || p.scripts?.prepublishOnly || p.scripts?.prepack) problems.push("no publish config or publish hooks");
  if (problems.length) throw new Error(`build --check: ${problems.join("; ")}`);
  execFileSync("node", [join(root, "scripts/smoke.mjs")], { stdio: "inherit" });
}

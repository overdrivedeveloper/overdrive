// Regenerates src/api/formula.ts from vol-engine/FORMULA.md (the one published formula). `--check` fails on a difference.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const md = readFileSync(join(root, "..", "vol-engine", "FORMULA.md"), "utf8");
const target = join(root, "src", "api", "formula.ts");
const current = readFileSync(target, "utf8");
const m = /export const FORMULA_MD = (".*");\n/.exec(current);
if (process.argv.includes("--check")) {
  if (!m || JSON.parse(m[1]!) !== md) { console.error("src/api/formula.ts differs from vol-engine/FORMULA.md; run bun run scripts/gen-formula.ts"); process.exit(1); }
} else {
  writeFileSync(target, current.replace(/export const FORMULA_MD = ".*";\n/, () => `export const FORMULA_MD = ${JSON.stringify(md)};\n`));
}

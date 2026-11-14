// Regenerates the typed ABI modules in src/abi from the IOD*.json files that scripts/export-abis.sh writes.
//   bun run scripts/gen-abi-ts.ts            write src/abi/*.ts
//   bun run scripts/gen-abi-ts.ts --check    exit 1 if any generated file differs from the JSON (CI)
// Optional: --json-dir <dir> --out-dir <dir> (tests).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { drift, generateAll } from "../src/abi/gen";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const abiDir = resolve(import.meta.dir, "../src/abi");
const jsonDir = flag("--json-dir") ?? abiDir;
const outDir = flag("--out-dir") ?? abiDir;

if (args.includes("--check")) {
  const bad = drift(jsonDir, outDir);
  if (bad.length > 0) {
    console.error(`gen-abi-ts: out of date: ${bad.join(", ")}. Run: bun run scripts/gen-abi-ts.ts`);
    process.exit(1);
  }
  console.log("gen-abi-ts: typed ABI modules match the JSON");
} else {
  mkdirSync(outDir, { recursive: true });
  const files = generateAll(jsonDir);
  for (const [file, content] of files) writeFileSync(join(outDir, file), content);
  console.log(`gen-abi-ts: wrote ${files.size} files to ${outDir}`);
}

// Writes the API's OpenAPI document to ../sdk/openapi.json (the SDK's one input). `--check` fails when the committed file differs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiDocumentText } from "../src/api/dump";

const root = join(import.meta.dir, "..");
const target = join(root, "..", "sdk", "openapi.json");
const text = apiDocumentText();
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== text) { console.error("sdk/openapi.json differs from the API; run bun run scripts/dump-openapi.ts"); process.exit(1); }
} else {
  writeFileSync(target, text);
}

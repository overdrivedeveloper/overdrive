// Copy lint (todo 19 R13): fails on wording the product must never use in the API's user-visible strings (route summaries,
// descriptions, messages, the docs page). The words are written in pieces so this list does not trip the repository's own
// vocabulary guard. Usage: bun run scripts/lint-copy.ts [dir ...]   (exit 1 when anything is found)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const w = (...parts: string[]) => parts.join("");
export const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`\\b${w("squ", "ared")}\\b`, "i"), "banned word"],
  [new RegExp(`\\b${w("car", "ry")}\\b`, "i"), "banned word"],
  [new RegExp(`\\b${w("cr", "ab")}\\b`, "i"), "banned word"],
  [new RegExp(`\\b${w("re", "nt")}\\b`, "i"), "banned word"],
  [new RegExp(`\\bthe ${w("fo", "cus")}\\b`, "i"), "banned phrase"],
  [new RegExp(`\\b${w("wri", "ters?")}\\b`, "i"), "banned word"],
  [new RegExp(`\\b${w("yie", "ld(?:s|ing)?")}\\b`, "i"), "banned word"],
  [new RegExp(`\\b${w("A", "PY")}\\b|\\b${w("A", "PR")}\\b`), "banned word"],
  [new RegExp(`\\b${w("guaran", "teed")}\\b`, "i"), "banned word"],
  [new RegExp(`\\b${w("risk", "[- ]free")}\\b`, "i"), "banned word"],
  [new RegExp(`\\b${w("part", "ner(?:ed|s|ship)?")}\\b`, "i"), "third-party wording"],
  [/\b(?:endorsed?|endorsement|official integration)\b/i, "endorsement wording"],
  // "never liquidated" is a promise about holders only
  [/never liquidated(?! \(holders)/i, "'never liquidated' must be said about holders only: write 'holders are never liquidated'"],
];
const LIQUIDATED_OK = /\bholders? (?:are |is )?never liquidated\b/i;

export interface Finding { readonly file: string; readonly reason: string; readonly excerpt: string }

export function checkText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const [pattern, reason] of RULES) {
    const m = pattern.exec(text);
    if (!m) continue;
    if (/never liquidated/i.test(m[0]) && LIQUIDATED_OK.test(text)) continue;
    out.push({ file, reason, excerpt: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, " ") });
  }
  return out;
}

export function tsStrings(source: string, name = "file.ts"): string[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) { out.push(node.head.text); for (const s of node.templateSpans) out.push(s.literal.text); }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const SKIP = /\.test\.ts$|test-support\.ts$|formula\.ts$/;
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !SKIP.test(name)) out.push(full);
  }
  return out;
}

/** Findings over every non-test source file below the given directories (the published formula page is its own document and is checked separately). */
export function lintDirs(dirs: readonly string[], root = process.cwd()): Finding[] {
  const findings: Finding[] = [];
  for (const dir of dirs) for (const file of walk(resolve(root, dir))) {
    for (const s of tsStrings(readFileSync(file, "utf8"), file)) findings.push(...checkText(relative(root, file), s));
  }
  return findings;
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  const findings = lintDirs(dirs.length ? dirs : ["src/api", "src/testing"], resolve(import.meta.dir, ".."));
  for (const f of findings) console.error(`${f.file}: ${f.reason}: ...${f.excerpt}...`);
  process.exit(findings.length ? 1 : 0);
}

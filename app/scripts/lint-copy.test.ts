import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORMULA_MD } from "../src/api/formula";
import { checkText, lintDirs, tsStrings } from "./lint-copy";

const w = (...p: string[]) => p.join("");

test("api_strings_clean", async () => {
  const root = join(import.meta.dir, "..");
  expect(lintDirs(["src/api", "src/testing"], root)).toEqual([]);
  // the live API strings: summaries, descriptions and messages of the served OpenAPI document and docs page
  const { apiDocumentText } = await import("../src/api/dump");
  expect(checkText("openapi.json", apiDocumentText())).toEqual([]);
  expect(checkText("formula", FORMULA_MD)).toEqual([]);
  void readFileSync;
});

test("the lint catches what it must and says what it should", () => {
  for (const bad of [w("annual ", "yie", "ld"), w("the A", "PY"), w("gua", "ranteed profit"), w("risk", "-free"), w("a ", "squ", "ared token"), w("our ", "part", "ner"), w("pay re", "nt"), w("car", "ry cost"), w("the ", "Cr", "ab gear"), w("the fo", "cus"), w("wri", "ters")]) {
    expect(checkText("x", bad).length).toBeGreaterThan(0);
  }
  expect(checkText("x", "holders are never liquidated")).toEqual([]);
  expect(checkText("x", "a vault is never liquidated")).not.toEqual([]);
  expect(checkText("x", "current, carried forward, daily toll, backers, exit reserve")).toEqual([]);
  expect(tsStrings('const a = "one"; const b = `two ${a} three`;')).toEqual(["one", "two ", " three"]);
});

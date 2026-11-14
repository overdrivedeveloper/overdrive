import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderIndexVectors, renderNormVectors } from "../../scripts/gen-vectors";
import { type Gear, type Rounding, value } from "../../src/pricing/index";
import { normStep, tollValue } from "../../src/pricing/norm";
import { perSecond, tollPerYear, usage } from "../../src/pricing/toll";

const dir = (name: string) => fileURLToPath(new URL(`../../../contracts/test/vectors/${name}`, import.meta.url));

interface IndexCase {
  gear: number;
  inDomain: boolean;
  nf: string;
  p: string;
  p0: string;
  rnd: number;
  unit: string;
  value: string;
}

interface NormCase {
  cap: string;
  dt: string;
  gear: number;
  nf: string;
  nfNew: string;
  open: string;
  perSec: string;
  sigmaBps: string;
  tokens: string;
  tollPerYear: string;
  tollValue: string;
  usageMax: string;
  usageWad: string;
  vBefore: string;
}

test("vector files are current (generator output byte-equal)", () => {
  expect(readFileSync(dir("index-vectors.json"), "utf8")).toBe(renderIndexVectors());
  expect(readFileSync(dir("norm-vectors.json"), "utf8")).toBe(renderNormVectors());
});

test("index vectors: 500 cases exact to the wei", () => {
  const cases = JSON.parse(readFileSync(dir("index-vectors.json"), "utf8")).cases as IndexCase[];
  expect(cases.length).toBe(500);
  for (const c of cases) {
    const v = value(c.gear as Gear, BigInt(c.p), BigInt(c.p0), BigInt(c.nf), BigInt(c.unit), c.rnd as Rounding);
    expect(v.valueWad.toString()).toBe(c.value);
    expect(v.inDomain).toBe(c.inDomain);
  }
});

test("norm vectors: 500 cases exact to the wei", () => {
  const cases = JSON.parse(readFileSync(dir("norm-vectors.json"), "utf8")).cases as NormCase[];
  expect(cases.length).toBe(500);
  for (const c of cases) {
    const u = usage(BigInt(c.open), BigInt(c.cap), BigInt(c.usageMax));
    expect(u.toString()).toBe(c.usageWad);
    const y = tollPerYear(c.gear as Gear, BigInt(c.sigmaBps), u);
    expect(y.toString()).toBe(c.tollPerYear);
    const s = perSecond(y);
    expect(s.toString()).toBe(c.perSec);
    const nfNew = normStep(BigInt(c.nf), s, BigInt(c.dt));
    expect(nfNew.toString()).toBe(c.nfNew);
    expect(tollValue(BigInt(c.tokens), BigInt(c.vBefore), BigInt(c.nf), nfNew).toString()).toBe(c.tollValue);
  }
});

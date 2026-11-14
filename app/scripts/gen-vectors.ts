// Writes contracts/test/vectors/{index-vectors.json,norm-vectors.json} from the TypeScript pricing twin, for the
// Solidity maths libraries to match exactly to the wei. Deterministic: running it twice gives identical bytes.
//
//   bun run scripts/gen-vectors.ts          write both files
//   bun run scripts/gen-vectors.ts --check  exit 1 if either file differs from what the twin produces now
//
// Every number is a decimal string (signed where the Solidity type is int256).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Gear, Rounding, WAD, value } from "../src/pricing/index";
import { normStep, tollValue } from "../src/pricing/norm";
import { perSecond, tollPerYear, usage } from "../src/pricing/toll";

export const VECTOR_SEED = 0x4f565244; // "OVRD"
export const VECTOR_COUNT = 500;
const INDEX_PATH = fileURLToPath(new URL("../../contracts/test/vectors/index-vectors.json", import.meta.url));
const NORM_PATH = fileURLToPath(new URL("../../contracts/test/vectors/norm-vectors.json", import.meta.url));

/** mulberry32: small, fixed, platform-independent 32-bit PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A positive bigint log-uniform between 10^loExp and 10^hiExp, with 15 random significant digits plus noise. */
function logUniform(rand: () => number, loExp: number, hiExp: number): bigint {
  const e = loExp + rand() * (hiExp - loExp);
  const whole = Math.floor(e);
  const mant = BigInt(Math.floor(10 ** (e - whole) * 1e14)); // [1e14, 1e15)
  const shift = whole - 14;
  let x = shift >= 0 ? mant * 10n ** BigInt(shift) : mant / 10n ** BigInt(-shift);
  if (shift > 6) x += BigInt(Math.floor(rand() * 1e6)); // low digits that are not all zero
  return x > 0n ? x : 1n;
}

const ONE = WAD;
const HOUR = 3_600n;
const DAY = 86_400n;

export interface IndexVector {
  gear: number;
  inDomain: boolean;
  nf: string;
  p: string;
  p0: string;
  rnd: number;
  unit: string;
  value: string;
}

function indexVector(gear: Gear, p: bigint, p0: bigint, nf: bigint, unit: bigint, rnd: Rounding): IndexVector {
  const v = value(gear, p, p0, nf, unit, rnd);
  return {
    gear,
    inDomain: v.inDomain,
    nf: nf.toString(),
    p: p.toString(),
    p0: p0.toString(),
    rnd,
    unit: unit.toString(),
    value: v.valueWad.toString(),
  };
}

export function buildIndexVectors(seed = VECTOR_SEED, count = VECTOR_COUNT): IndexVector[] {
  const out: IndexVector[] = [];
  const gears = [Gear.CRUISE, Gear.SPORT, Gear.RACE, Gear.ECO, Gear.REVERSE];
  // Fixed cases: the overview table points (r = 0.9, 1, 1.1) and both domain edges, both roundings.
  for (const g of gears) {
    for (const rnd of [Rounding.Floor, Rounding.Ceil]) {
      for (const p of [90n, 100n, 110n, 2n, 1n, 5000n, 5001n]) out.push(indexVector(g, p * ONE, 100n * ONE, ONE, ONE, rnd));
    }
  }
  const rand = mulberry32(seed);
  while (out.length < count) {
    const g = gears[Math.floor(rand() * 5)] ?? Gear.SPORT;
    const rnd = rand() < 0.5 ? Rounding.Floor : Rounding.Ceil;
    const p0 = logUniform(rand, 15, 24); // 0.001 .. 1e6 USD
    // ratio log-uniform in [0.01, 100]: mostly in the domain, some clamped on each side
    const scaled = (p0 * logUniform(rand, 16, 20)) / ONE; // p0 * [0.01, 100]
    const nf = logUniform(rand, 9, 24);
    const unit = logUniform(rand, 15, 20);
    out.push(indexVector(g, scaled > 0n ? scaled : 1n, p0, nf, unit, rnd));
  }
  return out.slice(0, count);
}

export interface NormVector {
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

function normVector(
  gear: Gear,
  sigmaBps: bigint,
  open: bigint,
  cap: bigint,
  usageMax: bigint,
  nf: bigint,
  dt: bigint,
  tokens: bigint,
  vBefore: bigint,
): NormVector {
  const u = usage(open, cap, usageMax);
  const y = tollPerYear(gear, sigmaBps, u);
  const s = perSecond(y);
  const nfNew = normStep(nf, s, dt);
  return {
    cap: cap.toString(),
    dt: dt.toString(),
    gear,
    nf: nf.toString(),
    nfNew: nfNew.toString(),
    open: open.toString(),
    perSec: s.toString(),
    sigmaBps: sigmaBps.toString(),
    tokens: tokens.toString(),
    tollPerYear: y.toString(),
    tollValue: tollValue(tokens, vBefore, nf, nfNew).toString(),
    usageMax: usageMax.toString(),
    usageWad: u.toString(),
    vBefore: vBefore.toString(),
  };
}

export function buildNormVectors(seed = VECTOR_SEED + 1, count = VECTOR_COUNT): NormVector[] {
  const cap = 1_000_000n * ONE;
  const out: NormVector[] = [
    normVector(Gear.SPORT, 6000n, 0n, cap, 0n, ONE, DAY, ONE, 100n * ONE), // TSLA Sport at 60%: one day
    normVector(Gear.SPORT, 1800n, 0n, cap, 0n, ONE, DAY, ONE, 100n * ONE), // SPY Sport at 18%
    normVector(Gear.CRUISE, 5000n, 0n, cap, 0n, ONE, DAY, ONE, 100n * ONE), // NVDA Cruise at 50%
    normVector(Gear.ECO, 6000n, 0n, cap, 0n, ONE, DAY, ONE, 100n * ONE), // Eco: holders receive
    normVector(Gear.REVERSE, 6000n, 0n, cap, 0n, ONE, DAY, ONE, 100n * ONE),
    normVector(Gear.RACE, 20000n, cap, cap, ONE, ONE, 60n * DAY, ONE, ONE), // clamped at 400%/yr, 60 days
    normVector(Gear.SPORT, 6000n, cap / 2n, cap, ONE / 10n, ONE, HOUR, ONE, ONE), // half used: quarter of usageMax
    normVector(Gear.SPORT, 6000n, 0n, cap, 0n, ONE, 0n, ONE, ONE), // dt = 0
    normVector(Gear.SPORT, 6000n, 0n, cap, 0n, ONE, 1n, ONE, ONE), // one second
    normVector(Gear.SPORT, 6000n, 0n, cap, 0n, 10n ** 9n, DAY, ONE, ONE), // at the floor
    normVector(Gear.ECO, 20000n, 0n, cap, 0n, 10n ** 24n, DAY, ONE, ONE), // at the ceiling
    normVector(Gear.RACE, 20000n, cap, cap, ONE, ONE, 3650n * DAY, ONE, ONE), // ten years at the cap
  ];
  const rand = mulberry32(seed);
  const gears = [Gear.CRUISE, Gear.SPORT, Gear.RACE, Gear.ECO, Gear.REVERSE];
  while (out.length < count) {
    const g = gears[Math.floor(rand() * 5)] ?? Gear.SPORT;
    const sigmaBps = BigInt(500 + Math.floor(rand() * 19_501)); // [5%, 200%]
    const open = rand() < 0.2 ? 0n : logUniform(rand, 18, 25);
    const capV = logUniform(rand, 20, 25);
    const usageMax = rand() < 0.3 ? 0n : logUniform(rand, 14, 18);
    const nf = logUniform(rand, 9, 24);
    const roll = rand();
    // dt: 1 in 10 zero, 3 in 10 whole hours, the rest log-uniform in [1 s, 60 days]
    const dt =
      roll < 0.1
        ? 0n
        : roll < 0.4
          ? BigInt(1 + Math.floor(rand() * 1440)) * HOUR
          : BigInt(Math.round(Math.exp(Math.log(60 * 86_400) * rand())));
    const tokens = logUniform(rand, 15, 24);
    const vBefore = logUniform(rand, 15, 22);
    out.push(normVector(g, sigmaBps, open, capV, usageMax, nf, dt, tokens, vBefore));
  }
  return out.slice(0, count);
}

function render(description: string, seed: number, cases: object[]): string {
  return [
    "{",
    `  "description": ${JSON.stringify(description)},`,
    `  "generator": "app/scripts/gen-vectors.ts",`,
    `  "seed": ${seed},`,
    `  "count": ${cases.length},`,
    `  "cases": [`,
    cases.map((c) => `    ${JSON.stringify(c)}`).join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
}

export function renderIndexVectors(): string {
  return render(
    "ODIndex.value(gear, p, p0, nf, unit, rnd) from app/src/pricing/index.ts. gear: 0 CRUISE 1 SPORT 2 RACE 3 ECO 4 REVERSE; rnd: 0 Floor 1 Ceil. Exact to the wei.",
    VECTOR_SEED,
    buildIndexVectors(),
  );
}

export function renderNormVectors(): string {
  return render(
    "usage(open, cap, usageMax) -> tollPerYear(gear, sigmaBps, usage) -> perSecond -> ODNorm.step(nf, perSec, dt) -> tollValue(tokens, vBefore, nf, nfNew), from app/src/pricing. Exact to the wei.",
    VECTOR_SEED + 1,
    buildNormVectors(),
  );
}

if (import.meta.main) {
  const files: [string, string][] = [
    [INDEX_PATH, renderIndexVectors()],
    [NORM_PATH, renderNormVectors()],
  ];
  if (process.argv.includes("--check")) {
    let bad = 0;
    for (const [path, text] of files) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = "";
      }
      if (current !== text) {
        console.error(`stale: ${path} (run bun run scripts/gen-vectors.ts)`);
        bad++;
      } else console.log(`ok: ${path}`);
    }
    process.exit(bad === 0 ? 0 : 1);
  }
  for (const [path, text] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${path} (${text.length} bytes)`);
  }
}

// IDS-1: market ids (bytes32 ASCII), pair keys and bytes32 text are parsed in ONE place, src/indexer/units.ts.
// 1. The shared helpers pass the cast vectors in contracts/test/vectors/market-ids.json (vol-engine and risk-sim test
//    their own helpers against the same file).
// 2. A guard: any ad-hoc bytes32 encode or decode in app/src or app/scripts outside units.ts fails this test. Test files
//    may build fixtures by hand; production and fork scripts may not.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Hex } from "viem";
import { bytes32OfText, bytes32Text, marketId, marketSymbol, pairKey } from "./units";

const APP = join(import.meta.dir, "../..");
const vec = JSON.parse(readFileSync(join(APP, "../contracts/test/vectors/market-ids.json"), "utf8")) as {
  markets: { symbol: string; id: Hex }[]; pairs: { key: string; a: string; b: string; id: Hex }[];
};

describe("shared id parser on the cast vectors", () => {
  test("market id <-> symbol, both directions", () => {
    expect(vec.markets.length).toBeGreaterThan(0);
    for (const m of vec.markets) {
      expect(marketId(m.symbol)).toBe(m.id);
      expect(marketSymbol(m.id)).toBe(m.symbol);
      expect(bytes32Text(m.id)).toBe(m.symbol);
    }
  });

  test("pair key = keccak256(abi.encode(a, b)), order matters, and is never read as a symbol", () => {
    expect(vec.pairs.length).toBeGreaterThan(0);
    for (const p of vec.pairs) {
      expect(pairKey(marketId(p.a), marketId(p.b))).toBe(p.id);
      expect(pairKey(marketId(p.b), marketId(p.a))).not.toBe(p.id);
      expect(marketSymbol(p.id)).toBe(p.id);
    }
  });

  test("bad symbols are refused, not truncated", () => {
    for (const bad of ["", "A".repeat(33), "NV DA", "NVDAé", "\u0000"]) expect(() => marketId(bad)).toThrow();
    expect(marketId("A".repeat(32))).toBe(`0x${"41".repeat(32)}`);
    expect(bytes32OfText("HALTED")).toBe(marketId("HALTED"));
    expect(bytes32Text(`0x${"0".repeat(64)}`)).toBe("");
  });
});

// Each pattern is a way to turn bytes32 into text or text into bytes32 without the shared helpers.
const AD_HOC: [string, RegExp][] = [
  ["viem hexToString", /\bhexToString\s*\(/],
  ["viem toHex/stringToHex sized 32", /\b(?:toHex|stringToHex)\s*\([^)]*size:\s*32/],
  ["Buffer hex decode to text", /Buffer\.from\([^,]*,\s*["']hex["']\)\s*\.toString\(\s*(?:["'](?:utf8|utf-8|ascii|latin1)["'])?\s*\)/],
  ["strip trailing NULs", /replace\(\s*\/\\0\+\$\//],
  ["right pad to 64 hex", /padEnd\(\s*64\s*,\s*["']0["']\s*\)/],
  ["char code loop", /String\.fromCharCode\(\s*(?:parseInt|code|c)\b/],
];
const SHARED = "src/indexer/units.ts";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.test\.|test-support|\/testing\//.test(p)) out.push(p);
  }
  return out;
}

describe("IDS-1 guard: no ad-hoc bytes32 encode or decode outside units.ts", () => {
  test("app/src and app/scripts", () => {
    const hits: string[] = [];
    for (const file of [...sources(join(APP, "src")), ...sources(join(APP, "scripts"))]) {
      const rel = relative(APP, file);
      if (rel === SHARED) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        for (const [what, re] of AD_HOC) if (re.test(line)) hits.push(`${rel}:${i + 1} ${what}: use marketId/marketSymbol/pairKey/bytes32Text/bytes32OfText from ${SHARED}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test("the guard catches each pattern", () => {
    const samples = [
      "hexToString(reason, { size: 32 })",
      'toHex("TOLL", { size: 32 })',
      'Buffer.from(b.slice(2), "hex").toString("utf8")',
      'x.replace(/\\0+$/, "")',
      '`0x${Buffer.from(s).toString("hex").padEnd(64, "0")}`',
      "s += String.fromCharCode(parseInt(h, 16))",
    ];
    expect(samples.length).toBe(AD_HOC.length);
    AD_HOC.forEach(([what, re], i) => expect([what, re.test(samples[i] ?? "")]).toEqual([what, true]));
  });
});

import {describe, expect, test} from 'bun:test';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {GEARS, isGearAllowed} from '../src/lib/overdrive';

// Launch scope (D10): only Cruise and Sport exist. Race, Eco and Reverse must always
// wear a "Coming soon" marker, and "five gears" copy must not return.
const SRC = join(import.meta.dir, '../src');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?)$/.test(f) ? [p] : [];
  });
const SKIP = ['/lib/overdrive.ts', '/services/contract.ts'];
const files = walk(SRC).filter((f) => !SKIP.some((s) => f.endsWith(s)));
const SOON = /coming soon/i;
const SOON_GEAR = /\b(Race|Eco|Reverse)\b/;
const FIVE = /\bfive\b[^.\n]{0,20}\bgears?\b|\ball five\b|\bfive distinct\b|\bgears?\b[^.\n]{0,12}\bfive\b/i;

describe('launch scope: Race, Eco and Reverse are Coming soon', () => {
  test('every line naming Race, Eco or Reverse also says Coming soon', () => {
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const prose = line.replace(/===?\s*'(Race|Eco|Reverse)'/g, '');
        if (SOON_GEAR.test(prose) && !SOON.test(line)) bad.push(`${f.slice(SRC.length)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
  test('no five gears copy', () => {
    const bad = files.filter((f) => FIVE.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  test('only Cruise and Sport are selectable', () => {
    expect(GEARS.filter((g) => !g.soon).map((g) => g.id)).toEqual(['Cruise', 'Sport']);
    for (const m of ['ETH', 'BTC', 'NVDA', 'TSLA', 'SPY'])
      for (const g of ['Race', 'Eco', 'Reverse'] as const) expect(isGearAllowed(m, g)).toBe(false);
    expect(isGearAllowed('TSLA', 'Sport')).toBe(true);
  });
});

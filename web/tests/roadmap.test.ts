// /roadmap: 24 updates in release order, each Scheduled until its entry is in CHANGELOG.md, then LIVE.
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROADMAP_ITEMS, hasChangelogEntry, liveIds, statusOf} from '../src/lib/roadmap';

const item = (n: number) => ROADMAP_ITEMS.find((i) => i.number === n)!;
const LOG = (body: string) => `# Changelog\n\n## Unreleased\n\n${body}\n`;

describe('roadmap data', () => {
  test('24 updates, numbered 1 to 24, 12 on each day, unique ids', () => {
    expect(ROADMAP_ITEMS.map((i) => i.number)).toEqual(Array.from({length: 24}, (_, k) => k + 1));
    expect(ROADMAP_ITEMS.filter((i) => i.day === 1)).toHaveLength(12);
    expect(ROADMAP_ITEMS.filter((i) => i.day === 2)).toHaveLength(12);
    expect(new Set(ROADMAP_ITEMS.map((i) => i.id)).size).toBe(24);
  });
  test('public wording only: no slot times, dates or internal queue ids', () => {
    const raw = readFileSync(join(import.meta.dir, '../src/data/roadmap.json'), 'utf8');
    expect(raw).not.toMatch(/T\+\d+h|\b[AB]\d{1,2}\b|\d{4}-\d{2}-\d{2}|\{LAUNCH|\u2014/);
  });
});

describe('LIVE only when the changelog entry exists', () => {
  test('no entry: Scheduled', () => {
    const live = liveIds(LOG('- Something unrelated.'));
    expect(live).toEqual([]);
    expect(statusOf(item(1), live)).toBe('Scheduled');
  });
  test('an entry by id makes only that item LIVE', () => {
    const live = liveIds(LOG('- update-1: Overdrive now has a health route at /v1/health.'));
    expect(live).toEqual(['update-1']);
    expect(statusOf(item(1), live)).toBe('LIVE');
    expect(statusOf(item(12), live)).toBe('Scheduled');
  });
  test('an entry by number and title makes the item LIVE', () => {
    const log = LOG('### Update 2: Status page\n\nOverdrive now has a status page.');
    expect(hasChangelogEntry(item(2), log)).toBe(true);
    expect(liveIds(log)).toEqual(['update-2']);
  });
  test('a near miss does not count', () => {
    expect(hasChangelogEntry(item(1), LOG('- update-12: Glossary and liquidation FAQ'))).toBe(false);
    expect(hasChangelogEntry(item(1), LOG('- Update 11: Cache headers and a clear 429'))).toBe(false);
    expect(hasChangelogEntry(item(2), LOG('- Update 2: Status page tweaks are planned'))).toBe(true);
    expect(hasChangelogEntry(item(2), LOG('- Update 3: Status page'))).toBe(false);
  });
  test("today's CHANGELOG.md has none of the 24", () => {
    expect(liveIds(readFileSync(join(import.meta.dir, '../../CHANGELOG.md'), 'utf8'))).toEqual([]);
  });
});

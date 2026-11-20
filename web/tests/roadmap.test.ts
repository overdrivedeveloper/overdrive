// /roadmap: 24 updates in release order, then staking 2 days after launch, each Scheduled until its entry is in CHANGELOG.md, then LIVE.
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROADMAP_DAYS, ROADMAP_ITEMS, hasChangelogEntry, itemText, liveIds, statusOf} from '../src/lib/roadmap';

const item = (n: number) => ROADMAP_ITEMS.find((i) => i.number === n)!;
const LOG = (body: string) => `# Changelog\n\n## Unreleased\n\n${body}\n`;

describe('roadmap data', () => {
  test('25 updates, numbered 1 to 25, 12 on each hourly day, unique ids', () => {
    expect(ROADMAP_ITEMS.map((i) => i.number)).toEqual(Array.from({length: 25}, (_, k) => k + 1));
    expect(ROADMAP_ITEMS.filter((i) => i.day === 1)).toHaveLength(12);
    expect(ROADMAP_ITEMS.filter((i) => i.day === 2)).toHaveLength(12);
    expect(new Set(ROADMAP_ITEMS.map((i) => i.id)).size).toBe(25);
    expect(ROADMAP_DAYS.map((d) => d.label)).toEqual(['Day 1', 'Day 2', 'Launch + 2 days']);
    expect(ROADMAP_ITEMS.every((i) => ROADMAP_DAYS.some((d) => d.day === i.day))).toBe(true);
  });
  test('staking opens 2 days after launch, Scheduled until its changelog entry exists', () => {
    const staking = item(25);
    expect(staking).toMatchObject({id: 'update-25', day: 3, title: 'Staking opens', when: 'launch + 2 days'});
    expect(itemText(staking)).toBe('Staking opens: launch + 2 days');
    expect(itemText(item(1))).toBe('Health route with indexer lag');
    expect(statusOf(staking, liveIds(LOG('- Something unrelated.')))).toBe('Scheduled');
    expect(statusOf(staking, liveIds(LOG('### Update 25: Staking opens')))).toBe('LIVE');
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
  test("today's CHANGELOG.md has none of the 25", () => {
    expect(liveIds(readFileSync(join(import.meta.dir, '../../CHANGELOG.md'), 'utf8'))).toEqual([]);
  });
});

// The /roadmap page: the 24 launch updates in release order, then staking 2 days after launch (src/data/roadmap.json,
// generated from the release queue's copy files). An item is LIVE only when its
// entry is in the repo's public CHANGELOG.md, read at build time (vite.config.ts); otherwise it is Scheduled.
// State is never typed by hand and never derived from the clock.
import data from '../data/roadmap.json';

export type RoadmapItem = {id: string; number: number; day: number; title: string; when?: string};
export type RoadmapDay = {day: number; label: string};
export type RoadmapStatus = 'LIVE' | 'Scheduled';
export const ROADMAP_ITEMS: RoadmapItem[] = data.items;
export const ROADMAP_DAYS: RoadmapDay[] = data.days;
/** The line shown for an item: its title, and when it is not on the hourly days, when it comes ("Staking opens: launch + 2 days"). */
export const itemText = (item: RoadmapItem): string => (item.when ? `${item.title}: ${item.when}` : item.title);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when the changelog has a line naming the item: its id (`update-7`) or `Update 7: <title>`. */
export function hasChangelogEntry(item: RoadmapItem, changelog: string): boolean {
  const byId = new RegExp(`(^|[^\\w-])${escape(item.id)}(?![\\w-])`, 'im');
  const byTitle = new RegExp(`Update ${item.number}: ${escape(item.title)}(?![\\w-])`, 'i');
  return changelog.split('\n').some((line) => byId.test(line) || byTitle.test(line));
}

/** The ids of the items whose changelog entry exists. */
export const liveIds = (changelog: string, items: RoadmapItem[] = ROADMAP_ITEMS): string[] =>
  items.filter((item) => hasChangelogEntry(item, changelog)).map((item) => item.id);

export const statusOf = (item: RoadmapItem, live: readonly string[]): RoadmapStatus => (live.includes(item.id) ? 'LIVE' : 'Scheduled');

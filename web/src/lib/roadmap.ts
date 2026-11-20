// The /roadmap page: the 24 launch updates in release order (src/data/roadmap.json). An item is LIVE only when its
// entry is in the repo's public CHANGELOG.md, read at build time (vite.config.ts); otherwise it is Scheduled.
// State is never typed by hand and never derived from the clock.
import data from '../data/roadmap.json';

export type RoadmapItem = {id: string; number: number; day: number; title: string};
export type RoadmapStatus = 'LIVE' | 'Scheduled';
export const ROADMAP_ITEMS: RoadmapItem[] = data.items;

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

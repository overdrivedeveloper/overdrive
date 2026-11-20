// Every claim the site makes about markets and hedging must be true at launch: only markets the API lists on chain show as
// tradeable (never the static catalog, never COIN while it is unlisted), the markets counter counts listed markets, and no
// sentence or tile says the Governor hedges while the hedger runs in dry run.
import {describe, expect, test} from 'bun:test';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {MARKETS} from '../src/lib/overdrive';
import {HEDGE_OFF, governorCards, hedgerMode, hedgingLine, listedMarkets, marketCount, splitCatalog} from '../src/lib/live-view';
import type {GovernorSnapshot, MarketGear, Snapshot, SystemStatus} from '../src/services/contract';
import {createOverdriveService} from '../src/services/overdrive';
import type {LiveState} from '../src/services/poller';

const stamp = {chainId: 4663, blockNumber: '1200', observedAt: '2026-11-19T12:00:00Z'};
const ready = <T,>(data: T): LiveState<T> => ({status: 'ready', data, error: null, refreshing: false});
const token = (symbol: string) => ({address: '0x4296084332088993e280efaffd25474cd3f997f5' as const, symbol, decimals: 18});
const row = (underlying: string, gear: 'Sport' | 'Cruise', listed: boolean): MarketGear => ({
  id: `${underlying}-${gear.toUpperCase()}`, underlying, gear, power: gear === 'Sport' ? '2' : '1.5', token: listed ? token(`${underlying}-${gear.toUpperCase()}`) : null,
  poolId: null, availability: listed ? 'available' : 'not_deployed', canBuy: listed, canSell: listed, canQueueSell: listed, capUsd: '100000', openValueUsd: null, spreadBps: 60,
});
// The launch set (D10) is listed; COIN is in the API answer but not deployed (D20: off until its pool cardinality transaction).
const LAUNCH = ['ETH', 'BTC', 'NVDA', 'TSLA', 'SPY'];
const list = ready<Snapshot<MarketGear[]>>({data: [...LAUNCH.flatMap((u) => [row(u, 'Sport', true), row(u, 'Cruise', true)]), row('COIN', 'Sport', false), row('COIN', 'Cruise', false)], stamp, stale: false});
// An equity market closed for the weekend is still listed.
const closed = ready<Snapshot<MarketGear[]>>({data: [{...row('TSLA', 'Sport', true), availability: 'closed'}], stamp, stale: false});

describe('markets: only listed markets are tradeable', () => {
  test('COIN is never tradeable while the API says it is not deployed', () => {
    const view = listedMarkets(list, true);
    const {tradeable, later} = splitCatalog(MARKETS, view);
    expect(tradeable.map((m) => m.symbol).sort()).toEqual([...LAUNCH].sort());
    expect(tradeable.some((m) => m.symbol.includes('COIN'))).toBe(false);
    expect(later.map((m) => m.symbol)).toContain('COIN');
    expect(listedMarkets(closed, true).symbols).toEqual(['TSLA']);
  });
  test('the counter equals the listed markets, not the catalog', () => {
    expect(marketCount(MARKETS, listedMarkets(list, true))).toBe('5');
    expect(marketCount(MARKETS, listedMarkets(list, true))).not.toBe(String(MARKETS.length));
  });
  test('with no market answer nothing is tradeable and the counter is not a number', () => {
    const idle: LiveState<Snapshot<MarketGear[]>> = {status: 'idle', data: null, error: null, refreshing: false};
    const view = listedMarkets(idle, false);
    expect(view.ready).toBe(false);
    expect(splitCatalog(MARKETS, view)).toEqual({tradeable: [], later: []});
    expect(marketCount(MARKETS, view)).toBe('-');
    expect(view.message).toContain('No market is shown as tradeable');
  });
  test('the dashboard never lists or counts the static catalog as tradeable', () => {
    const src = readFileSync(join(import.meta.dir, '../src/sections/PeopleNine/PeopleNine.tsx'), 'utf8');
    expect(src).not.toMatch(/MARKETS\.(length|map|filter)\b/);
    expect(src).toContain('splitCatalog(MARKETS,listed)');
    expect(src).toContain('Coming later, not tradeable yet');
  });
});

const GOV: GovernorSnapshot = {equityUsd: '125000', exitReserveUsd: '40000', exitReserveFloorUsd: '25000', deltaUsd: '-8000', gammaUsd: '120', hedgeDeltaUsd: '0', riskState: 'normal'};
const gov = (g: Partial<GovernorSnapshot> = {}) => ready<Snapshot<GovernorSnapshot>>({data: {...GOV, ...g}, stamp, stale: false});
const status = (mode: 'dry_run' | 'live' | null): LiveState<SystemStatus> => ready({services: [{job: 'toll', lastRun: null, lastOk: null, lastError: null, mode: null}, {job: 'hedger', lastRun: null, lastOk: null, lastError: null, mode}]});
// A sentence that says hedging happens now.
const ACTIVE = /\bhedges\b|\bis hedged\b|\bhedged\b(?! moves)|\boffsets what remains\b/i;

describe('hedging: no active-hedging claim in dry run', () => {
  test('the hedger mode comes from /v1/status', async () => {
    const urls: string[] = [];
    const svc = createOverdriveService({apiOrigin: 'https://api.example.test', chainId: 4663}, async (u: string) => { urls.push(u); return new Response(JSON.stringify(status('dry_run').data), {status: 200}); });
    const s = await svc.systemStatus();
    expect(urls).toEqual(['https://api.example.test/v1/status']);
    expect(hedgerMode(ready(s))).toBe('dry_run');
    expect(hedgerMode(status('live'))).toBe('live');
    expect(hedgerMode(status(null))).toBe('unknown');
    expect(hedgerMode(ready<SystemStatus>({services: []}))).toBe('unknown');
  });
  test('dry run: the line describes the design without claiming it, and the tile shows no coverage number', () => {
    for (const mode of ['dry_run', 'unknown'] as const) {
      expect(hedgingLine(mode)).not.toMatch(ACTIVE);
      const card = governorCards(gov({hedgeDeltaUsd: '6000'}), true, mode)[3]!;
      expect(card.title).not.toBe('Hedge coverage');
      expect(card.value).toBe(HEDGE_OFF);
      expect(card.value + card.hint).not.toMatch(/\d%/);
    }
    expect(hedgingLine('dry_run')).toContain('off until the venues are set up');
  });
  test('live: the line says so, and a number shows only when a hedge is open', () => {
    expect(hedgingLine('live')).toMatch(ACTIVE);
    expect(governorCards(gov(), true, 'live')[3]!.value).toBe('No hedge open');
    expect(governorCards(gov({hedgeDeltaUsd: '6000'}), true, 'live')[3]!.value).toBe('75%');
  });
  test('no static page text claims hedging is active, and no COIN chip remains', () => {
    const SRC = join(import.meta.dir, '../src');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
    const bad: string[] = [];
    for (const f of walk(SRC)) readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/hedges what remains|nets and hedges|remaining exposure is hedged|Hedge coverage/i.test(line)) bad.push(`${f.slice(SRC.length)}:${i + 1}`);
    });
    expect(bad).toEqual([]);
    expect(readFileSync(join(SRC, 'sections/Mechanics.tsx'), 'utf8')).not.toContain('COIN');
  });
});

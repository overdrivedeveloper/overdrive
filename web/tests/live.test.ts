// Live dashboard reads: each compat procedure through the real service module against a mocked fetch that answers the
// api-contracts shapes, driven by the poller the hooks wrap; the view models; and the wallet add-chain path (4902).
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {addChainParams, switchOrAddChain} from '../src/lib/chains';
import {NOT_LIVE, feedLine, governorCards, marketLive, portfolioView, tollLine, vaultsView} from '../src/lib/live-view';
import type {AccountEvent, BackerVault, GearSnapshot, GovernorSnapshot, MarketGear, Position, Snapshot} from '../src/services/contract';
import {createOverdriveService} from '../src/services/overdrive';
import {MIN_POLL_MS, POLL, TERMINAL, createPoller, type LiveState} from '../src/services/poller';
import {ACCOUNT} from './fixtures';

const ORIGIN = 'https://api.example.test';
const stamp = {chainId: 4663, blockNumber: '1200', observedAt: '2026-11-16T12:00:00Z'};
const snap = <T,>(data: T | null, o: Partial<Snapshot<T>> = {}): Snapshot<T> => ({data, stamp, stale: false, ...o});
const USDG = {address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const, symbol: 'USDG', decimals: 6};
const TSLA_SPORT = {address: '0x4296084332088993e280efaffd25474cd3f997f5' as const, symbol: 'TSLA-SPORT', decimals: 18};

const GOV: GovernorSnapshot = {equityUsd: '125000.5', exitReserveUsd: '40000', exitReserveFloorUsd: '25000', deltaUsd: '-8000', gammaUsd: '120', hedgeDeltaUsd: '6000', riskState: 'normal'};
const MARKETS: MarketGear[] = [
  {id: 'TSLA-SPORT', underlying: 'TSLA', gear: 'Sport', power: '2', token: TSLA_SPORT, poolId: null, availability: 'available', canBuy: true, canSell: true, canQueueSell: true, capUsd: '250000', openValueUsd: '1000', spreadBps: 45},
  {id: 'TSLA-CRUISE', underlying: 'TSLA', gear: 'Cruise', power: '1.5', token: null, poolId: null, availability: 'not_deployed', canBuy: false, canSell: false, canQueueSell: false, capUsd: '100000', openValueUsd: null, spreadBps: 30},
];
const GEAR: GearSnapshot = {gearId: 'TSLA-SPORT', underlyingPrice: '400.1', valuePerToken: '1.02', priceCurrency: 'USDG', normalisation: '0.99', annualVolatilityPct: '60', dailyTollPct: '0.0312', usageDailyTollPct: '0.001', availability: 'available', feedUpdatedAt: '2026-11-16T11:59:00Z', raceEligible: false};
const POSITIONS: Position[] = [
  {gearId: 'TSLA-SPORT', quantity: {token: TSLA_SPORT, baseUnits: '1500000000000000000'}, valueUsd: '153.25', accruedTollUsd: '0.42'},
  {gearId: 'NVDA-SPORT', quantity: {token: {...TSLA_SPORT, symbol: 'NVDA-SPORT'}, baseUnits: '2000000000000000000'}, valueUsd: '46.75', accruedTollUsd: '0.08'},
];
const VAULT: BackerVault = {id: '7', owner: ACCOUNT, gearId: 'TSLA-SPORT', collateral: {token: USDG, baseUnits: '500000000'}, debt: {token: TSLA_SPORT, baseUnits: '100000000000000000000'}, collateralRatioPct: '210', initialRatioPct: '200', maintenanceRatioPct: '150', health: '1.4', weekendUpliftPct: '0', canMint: true, status: 'open'};
const HASH = `0x${'ab'.repeat(32)}`;
const EVENT = (status: AccountEvent['status']): AccountEvent => ({id: 'e1', chainId: 4663, account: ACCOUNT, kind: 'buy', timestamp: stamp.observedAt, transactionHash: HASH as `0x${string}`, status, blockNumber: '1201', summary: 'Bought TSLA-SPORT'});

/** A fetch that answers by procedure and records every call. */
function api(answers: Record<string, (url: URL, init?: RequestInit) => {status?: number; body: unknown}>) {
  const calls: {url: URL; init?: RequestInit}[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input); calls.push({url, init});
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
    const proc = url.pathname.replace('/v1/compat/', '');
    const a = answers[proc]?.(url, init) ?? {status: 404, body: {code: 'SERVICE_UNAVAILABLE', message: 'no route', retryable: false}};
    return new Response(JSON.stringify(a.body), {status: a.status ?? 200, headers: {'content-type': 'application/json', 'cache-control': 'public, max-age=5'}});
  };
  return {service: createOverdriveService({apiOrigin: ORIGIN, chainId: 4663}, fetchImpl), calls};
}

/** Manual timers: the test decides when the next poll runs. */
function clock() {
  const queue: {fn: () => void; ms: number; id: number}[] = []; let n = 0;
  return {queue, timers: {set: (fn: () => void, ms: number) => { queue.push({fn, ms, id: ++n}); return n; }, clear: (id: unknown) => { const i = queue.findIndex((q) => q.id === id); if (i >= 0) queue.splice(i, 1); }},
    next: () => queue.shift()!};
}
const flush = () => new Promise((r) => setTimeout(r, 0));
async function poll<T>(load: (s: AbortSignal) => Promise<T>, intervalMs: number, isDone?: (d: T) => boolean) {
  const c = clock(); const states: LiveState<T>[] = [];
  const p = createPoller<T>({load, intervalMs, onChange: (s) => states.push(s), isDone, timers: c.timers});
  p.start(); await flush(); await flush();
  return {p, c, states, last: () => states[states.length - 1]!};
}

describe('poll intervals respect the API cache', () => {
  test('every interval is at least max-age=5', () => {
    for (const ms of Object.values(POLL)) expect(ms).toBeGreaterThanOrEqual(MIN_POLL_MS);
  });
  test('a faster request is clamped to 5 s', async () => {
    const {c, p} = await poll(async () => 1, 1000);
    expect(p.interval).toBe(MIN_POLL_MS);
    expect(c.queue[0]!.ms).toBe(MIN_POLL_MS);
    p.stop();
  });
});

describe('one hook per procedure, against the contract shapes', () => {
  test('market.list: GET with the chain id, live spread and cap per market', async () => {
    const {service, calls} = api({'market.list': () => ({body: snap(MARKETS)})});
    const r = await poll((s) => service.marketList(s), POLL.marketList);
    expect(calls[0]!.url.searchParams.get('chainId')).toBe('4663');
    expect(r.last().status).toBe('ready');
    expect(marketLive(r.last(), 'TSLA')).toEqual({spreadBps: 30, capUsd: 350000, availability: 'available'});
    expect(marketLive(r.last(), 'BTC')).toBeNull();
    expect(r.c.queue[0]!.ms).toBe(60_000);
    r.p.stop();
  });
  test('gear.snapshot: daily toll and feed line', async () => {
    const {service, calls} = api({'gear.snapshot': () => ({body: snap(GEAR)})});
    const r = await poll((s) => service.gearSnapshot('TSLA-SPORT', s), POLL.gearSnapshot);
    expect(calls[0]!.url.searchParams.get('gearId')).toBe('TSLA-SPORT');
    expect(tollLine(r.last(), 'Low daily toll')).toBe('Daily toll 0.0312%');
    expect(feedLine(r.last(), true)).toBe('Live price feed');
    expect(feedLine({...r.last(), data: snap(GEAR, {stale: true})}, true)).toBe('Price feed stale');
    r.p.stop();
  });
  test('governor.snapshot: the four cards come from the API, stale shows Not live yet', async () => {
    const {service} = api({'governor.snapshot': () => ({body: snap(GOV)})});
    const r = await poll((s) => service.governorSnapshot(s), POLL.governor);
    const cards = governorCards(r.last(), true, 'live');
    expect(cards.map((c) => [c.title, c.value])).toEqual([['Governor equity', '$125,000.50'], ['Exit reserve', '$40,000.00'], ['Net exposure', '-$8,000.00'], ['Outside hedge', '75%']]);
    expect(cards.every((c) => c.live)).toBe(true);
    const stale = governorCards({...r.last(), data: snap(GOV, {stale: true})}, true);
    expect(stale.every((c) => c.value === NOT_LIVE && !c.live)).toBe(true);
    expect(stale[0]!.hint).toContain('for reference only');
    const none = governorCards({...r.last(), data: snap<GovernorSnapshot>(null, {unavailableReason: 'Governor not deployed'})}, true);
    expect(none.every((c) => c.value === NOT_LIVE && c.hint === 'Governor not deployed')).toBe(true);
    r.p.stop();
  });
  test('portfolio.positions: rows, totals and the empty wallet', async () => {
    const {service, calls} = api({'portfolio.positions': (u) => ({body: snap(u.searchParams.get('account') === ACCOUNT ? POSITIONS : [])})});
    const r = await poll((s) => service.portfolioPositions(ACCOUNT, s), POLL.positions);
    expect(calls[0]!.url.searchParams.get('account')).toBe(ACCOUNT);
    const v = portfolioView(r.last(), true, true);
    expect(v).toMatchObject({total: '200.00', unit: true, positionValue: '$200.00', accruedToll: '$0.50'});
    expect(v.rows[0]).toEqual({gearId: 'TSLA-SPORT', quantity: '1.5 TSLA-SPORT', value: '$153.25'});
    expect(portfolioView({...r.last(), data: snap<Position[]>([])}, true, true).title).toBe('No gear tokens yet.');
    expect(portfolioView({...r.last(), data: snap([{...POSITIONS[0]!, valueUsd: null}])}, true, true)).toMatchObject({total: 'Not reported', unit: false});
    r.p.stop();
  });
  test('portfolio: not connected never reads and never shows a figure', () => {
    const v = portfolioView({status: 'idle', data: null, error: null, refreshing: false}, true, false);
    expect(v).toMatchObject({total: 'Not connected', unit: false, rows: []});
  });
  test('backer.vaults: one row per vault, empty state', async () => {
    const {service} = api({'backer.vaults': () => ({body: snap([VAULT])})});
    const r = await poll((s) => service.backerVaults(ACCOUNT, s), POLL.vaults);
    const v = vaultsView(r.last(), true, true);
    expect(v.rows[0]).toMatchObject({id: '7', collateral: '500 USDG', debt: '100 TSLA-SPORT', ratio: '210% (maintenance 150%)', status: 'open'});
    expect(vaultsView({...r.last(), data: snap<BackerVault[]>([])}, true, true).title).toBe('No backer vaults yet');
    expect(vaultsView(r.last(), true, false).title).toBe('Connect to view your vaults');
    r.p.stop();
  });
  test('backer.quoteAction: POST with the open action and base units', async () => {
    let body: unknown;
    const intent = {chainId: 4663, account: ACCOUNT, contract: ACCOUNT, functionName: 'openVault', args: [], valueBaseUnits: '0', expiresAt: '2026-11-16T12:05:00Z'};
    const {service, calls} = api({'backer.quoteAction': (_u, init) => { body = JSON.parse(String(init?.body)); return {body: {id: 'open:1', stamp, expiresAt: intent.expiresAt, approvals: [], transaction: intent}}; }});
    const q = await service.backerQuoteAction({chainId: 4663, account: ACCOUNT, action: 'open', gearId: 'TSLA-SPORT', amount: '500000000'});
    expect(calls[0]!.init?.method).toBe('POST');
    expect(body).toEqual({chainId: 4663, account: ACCOUNT, action: 'open', gearId: 'TSLA-SPORT', amount: '500000000'});
    expect(q.transaction.functionName).toBe('openVault');
  });
  test('trade.status: polls until the record is final', async () => {
    const seq: AccountEvent['status'][] = ['submitted', 'confirming', 'confirmed'];
    let i = 0;
    const {service, calls} = api({'trade.status': () => ({body: snap(EVENT(seq[Math.min(i++, 2)]!))})});
    const r = await poll((s) => service.tradeStatus(HASH, s), POLL.tradeStatus, (d) => !!d.data && TERMINAL.has(d.data.status));
    expect(calls[0]!.url.searchParams.get('hash')).toBe(HASH);
    r.c.next().fn(); await flush(); await flush();
    r.c.next().fn(); await flush(); await flush();
    expect(r.last().data?.data?.status).toBe('confirmed');
    expect(r.c.queue.length).toBe(0);
    expect(calls.length).toBe(3);
  });
});

describe('poller rules', () => {
  test('stop aborts the read and a late answer never paints', async () => {
    let signal: AbortSignal | undefined; let release!: (v: number) => void;
    const c = clock(); const states: LiveState<number>[] = [];
    const p = createPoller<number>({load: (s) => { signal = s; return new Promise((r) => { release = r; }); }, intervalMs: 5000, onChange: (s) => states.push(s), timers: c.timers});
    p.start(); p.stop(); release(42); await flush();
    expect(signal?.aborted).toBe(true);
    expect(states.map((s) => s.status)).toEqual(['loading']);
    expect(c.queue.length).toBe(0);
  });
  test('a failed refresh keeps the last data and the ServiceError code; retryAfterMs is honoured', async () => {
    let n = 0;
    const {service} = api({'governor.snapshot': () => (n++ === 0 ? {body: snap(GOV)} : {status: 429, body: {code: 'SERVICE_UNAVAILABLE', message: 'Slow down.', retryable: true, retryAfterMs: 20_000}})});
    const r = await poll((s) => service.governorSnapshot(s), POLL.governor);
    r.c.next().fn(); await flush(); await flush();
    expect(r.last()).toMatchObject({status: 'error', error: {code: 'SERVICE_UNAVAILABLE', retryAfterMs: 20_000}});
    expect(r.last().data?.data).toEqual(GOV);
    expect(r.c.queue[0]!.ms).toBe(30_000);
    r.p.stop();
  });
  test('a non-retryable error stops polling and the views name it', async () => {
    const {service} = api({'portfolio.positions': () => ({status: 400, body: {code: 'WRONG_CHAIN', message: 'This API serves chain 4663.', retryable: false}})});
    const r = await poll((s) => service.portfolioPositions(ACCOUNT, s), POLL.positions);
    expect(r.last().error?.code).toBe('WRONG_CHAIN');
    expect(r.c.queue.length).toBe(0);
    expect(portfolioView(r.last(), true, true)).toMatchObject({total: 'Unavailable', message: 'This API serves chain 4663.'});
  });
  test('no API configured: every card says Not live yet', () => {
    const idle = {status: 'idle' as const, data: null, error: null, refreshing: false};
    expect(governorCards(idle, false).every((c) => c.value === NOT_LIVE)).toBe(true);
    expect(feedLine(idle, false)).toBe('Awaiting price feed');
  });
});

describe('wallet: unknown chain (4902) adds Robinhood Chain, then switches', () => {
  const wallet = (switchErrors: unknown[], addError?: unknown) => {
    const calls: {method: string; params?: unknown[]}[] = [];
    return {calls, p: {request: async (a: {method: string; params?: unknown[]}) => {
      calls.push(a);
      if (a.method === 'wallet_switchEthereumChain' && switchErrors.length) throw switchErrors.shift();
      if (a.method === 'wallet_addEthereumChain' && addError) throw addError;
      return null;
    }}};
  };
  test('4902: add with the published params, then retry the switch', async () => {
    const w = wallet([{code: 4902}]);
    await switchOrAddChain(w.p, 4663);
    expect(w.calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
    expect(w.calls[1]!.params![0]).toEqual({chainId: '0x1237', chainName: 'Robinhood Chain', rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'], nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18}});
  });
  test('testnet profile uses the testnet RPC and explorer', () => {
    expect(addChainParams(46630)).toMatchObject({chainId: '0xb626', rpcUrls: ['https://rpc.testnet.chain.robinhood.com'], blockExplorerUrls: ['https://explorer.testnet.chain.robinhood.com']});
  });
  test('a wrapped 4902 (mobile wallets) is handled the same way', async () => {
    const w = wallet([{code: -32603, data: {originalError: {code: 4902}}}]);
    await switchOrAddChain(w.p, 46630);
    expect(w.calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
  });
  test('cancel on add is passed to the caller; nothing else is tried', async () => {
    const w = wallet([{code: 4902}], {code: 4001});
    await expect(switchOrAddChain(w.p, 4663)).rejects.toMatchObject({code: 4001});
    expect(w.calls.length).toBe(2);
  });
  test('a chain without public params (local fork) never asks to add', async () => {
    const w = wallet([{code: 4902}]);
    await expect(switchOrAddChain(w.p, 31337)).rejects.toMatchObject({code: 4902});
    expect(w.calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain']);
  });
  test('the wallet hook calls the add-chain path', () => {
    const src = readFileSync(join(import.meta.dir, '../src/hooks/useOverdriveWallet.ts'), 'utf8');
    expect(src).toContain('switchOrAddChain(wallet, CHAIN_ID)');
  });
});

describe('no placeholder figure remains in the wired tabs', () => {
  const src = readFileSync(join(import.meta.dir, '../src/sections/PeopleNine/PeopleNine.tsx'), 'utf8');
  const tab = (name: string) => { const i = src.indexOf(`{active==='${name}'&&`); expect(i).toBeGreaterThan(0); return src.slice(i, src.indexOf('\n', i)); };
  for (const name of ['Portfolio', 'Backers', 'Governor', 'Token']) {
    test(`${name}: no "-" stand-in value and no "Awaiting protocol data"`, () => {
      const t = tab(name);
      expect(t).not.toMatch(/<dd>-<\/dd>|<strong[^>]*>-[ <]|Awaiting protocol data/);
    });
  }
  test('each wired tab reads its live view', () => {
    expect(tab('Governor')).toContain('governorCards(governor,configured,hedger)');
    expect(tab('Portfolio')).toContain('port.total');
    expect(tab('Backers')).toContain('vaultView.rows');
    expect(tab('Token')).toContain('NOT_LIVE');
    expect(src).toContain('feedLine(gearSnap,configured)');
  });
});

// R3 one service module (grep gate), R5 the 14 codes on the client, R8 public config only.
import {expect, test} from 'bun:test';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {encodeErrorResult, parseAbi} from 'viem';
import {SERVICE_ERROR_CODES} from '../src/services/contract';
import {ServiceFailure, classifyRevert, createOverdriveService, publicConfig, toServiceError} from '../src/services/overdrive';

const SRC = join(import.meta.dir, '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });

test('R3 grep gate: only src/services/overdrive.ts calls fetch, XMLHttpRequest or WebSocket', () => {
  const offenders = files(SRC).filter((f) => /\.(ts|tsx|js)$/.test(f) && !f.endsWith(join('services', 'overdrive.ts')))
    .filter((f) => /\bfetch\s*\(|XMLHttpRequest|new WebSocket|axios/.test(readFileSync(f, 'utf8')));
  expect(offenders).toEqual([]);
});

test('R8: VITE_ values are public config only, and no secret-shaped strings in web/', () => {
  const used = new Set(files(SRC).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/VITE_[A-Z0-9_]+/g)].map((m) => m[0])));
  expect([...used].sort()).toEqual(['VITE_API_ORIGIN', 'VITE_CHAIN_ID', 'VITE_REOWN_PROJECT_ID']);
  const root = join(import.meta.dir, '..');
  const scan = [...files(SRC), ...readdirSync(root).filter((f) => f.startsWith('.env')).map((f) => join(root, f))];
  for (const f of scan) {
    const text = readFileSync(f, 'utf8');
    expect({f, secret: /(PRIVATE_KEY|SECRET|MNEMONIC|seed phrase:|alchemy\.com\/v2\/[A-Za-z0-9]|infura\.io\/v3\/[a-f0-9]{8}|quiknode\.pro\/[a-f0-9])/i.test(text)}).toEqual({f, secret: false});
  }
  expect(publicConfig({})).toEqual({apiOrigin: '', chainId: 4663});
  expect(() => publicConfig({VITE_API_ORIGIN: 'https://api.example.com/path?key=1'})).toThrow();
});

test('R5: every answer is one of the 14 codes; anything else is SERVICE_UNAVAILABLE', () => {
  expect(SERVICE_ERROR_CODES).toHaveLength(14);
  for (const c of SERVICE_ERROR_CODES) expect(toServiceError(409, {code: c, message: 'm', retryable: false}).code).toBe(c);
  expect(toServiceError(400, {error: 'BAD_REQUEST', message: 'x'})).toMatchObject({code: 'SERVICE_UNAVAILABLE', retryable: false});
  expect(toServiceError(502, null)).toMatchObject({code: 'SERVICE_UNAVAILABLE', retryable: true});
  expect(toServiceError(409, {code: 'MADE_UP', message: 'x'}).code).toBe('SERVICE_UNAVAILABLE');
});

test('R5 client codes from reverts: SLIPPAGE_EXCEEDED, QUOTE_EXPIRED, MARKET_CLOSED, FEED_STALE, CAP_REACHED, INSUFFICIENT_COLLATERAL', () => {
  const abi = parseAbi(['error Slippage(uint256 got, uint256 limit)', 'error Expired()', 'error BuysClosed(bytes32 gearId, bytes32 reason)', 'error CapExceeded(bytes32 gearId, uint256 openWad, uint256 capWad)', 'error Undercollateralized(uint256 ratioBps, uint256 requiredBps)']);
  const b32 = (s: string) => (`0x${Buffer.from(s).toString('hex').padEnd(64, '0')}`) as `0x${string}`;
  const wrap = (data: string) => ({code: -32603, message: 'execution reverted', data: {data}});
  expect(classifyRevert(wrap(encodeErrorResult({abi, errorName: 'Slippage', args: [1n, 2n]}))).code).toBe('SLIPPAGE_EXCEEDED');
  expect(classifyRevert(wrap(encodeErrorResult({abi, errorName: 'Expired'}))).code).toBe('QUOTE_EXPIRED');
  expect(classifyRevert(wrap(encodeErrorResult({abi, errorName: 'BuysClosed', args: [b32('g'), b32('CLOSED')]}))).code).toBe('MARKET_CLOSED');
  expect(classifyRevert(wrap(encodeErrorResult({abi, errorName: 'BuysClosed', args: [b32('g'), b32('STALE')]}))).code).toBe('FEED_STALE');
  expect(classifyRevert(wrap(encodeErrorResult({abi, errorName: 'BuysClosed', args: [b32('g'), b32('MANUAL')]}))).code).toBe('FEED_PAUSED');
  expect(classifyRevert(wrap(encodeErrorResult({abi, errorName: 'CapExceeded', args: [b32('g'), 1n, 1n]}))).code).toBe('CAP_REACHED');
  expect(classifyRevert(wrap(encodeErrorResult({abi, errorName: 'Undercollateralized', args: [1n, 2n]}))).code).toBe('INSUFFICIENT_COLLATERAL');
  expect(classifyRevert({message: 'nope'}).code).toBe('SERVICE_UNAVAILABLE');
});

test('the service calls /v1/compat/<procedure> with the chain id and turns errors into ServiceFailure', async () => {
  const seen: string[] = [];
  const svc = createOverdriveService({apiOrigin: 'http://api.test', chainId: 31337}, async (url, init) => {
    seen.push(`${init?.method} ${url}`);
    if (url.includes('governor')) return new Response(JSON.stringify({code: 'WRONG_CHAIN', message: 'w', retryable: false}), {status: 400});
    return new Response(JSON.stringify({data: [], stamp: {chainId: 31337, blockNumber: '1', observedAt: 'x'}, stale: false}), {status: 200});
  });
  await svc.marketList();
  await svc.portfolioPositions('0x1111111111111111111111111111111111111111');
  await svc.tradeQuote({chainId: 31337, account: '0x1111111111111111111111111111111111111111', gearId: 'TSLA-SPORT', side: 'buy', input: {token: {address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6}, baseUnits: '1'}, slippageBps: 50});
  const e = await svc.governorSnapshot().catch((x) => x);
  expect(e).toBeInstanceOf(ServiceFailure);
  expect((e as ServiceFailure).code).toBe('WRONG_CHAIN');
  const down = createOverdriveService({apiOrigin: 'http://api.test', chainId: 31337}, async () => { throw new TypeError('network'); });
  expect(((await down.marketList().catch((x) => x)) as ServiceFailure).code).toBe('SERVICE_UNAVAILABLE');
  expect(seen).toEqual([
    'GET http://api.test/v1/compat/market.list?chainId=31337',
    'GET http://api.test/v1/compat/portfolio.positions?account=0x1111111111111111111111111111111111111111&chainId=31337',
    'POST http://api.test/v1/compat/trade.quote',
    'GET http://api.test/v1/compat/governor.snapshot?chainId=31337',
  ]);
});

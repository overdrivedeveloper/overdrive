// The buy review shows what selling the bought tokens right away would pay: buys take the higher of the two price
// sources and sells the lower, so the round trip can cost more than the two spreads (rehearsal: 2.27% vs 1.2%).
import {describe, expect, test} from 'bun:test';
import {EXIT_VALUE_LABEL, EXIT_VALUE_UNAVAILABLE, exitValueRow} from '../src/lib/live-view';
import {createOverdriveService} from '../src/services/overdrive';

const USDG = {address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const, symbol: 'USDG', decimals: 6};
const GEAR = {address: '0x00000000000000000000000000000000000000aa' as const, symbol: 'NVDA-SPORT', decimals: 18};
const buy = (paid: string, tokens: string | null) => ({
  input: {side: 'buy' as const, input: {token: USDG, baseUnits: paid}},
  output: tokens === null ? null : {token: GEAR, baseUnits: tokens},
});
const sellDoc = (usdgOut: string | null, sellMode: 'instant' | 'instant_min' | 'queued' | null = 'instant', buyable = true) => ({buyable, sellMode, usdgOut, blockNumber: '1'});

describe('exit value on the buy review', () => {
  test('the rehearsal round trip: pay 100 USDG, selling right away pays 97.73 USDG', () => {
    const row = exitValueRow(buy('100000000', '1000000000000000000'), sellDoc('97730000'))!;
    expect(row.label).toBe(EXIT_VALUE_LABEL);
    expect(row.value).toBe('97.73 USDG (round trip -2.27%)');
    expect(row.roundTripPct).toBe('-2.27%');
    expect(row.num).toBe(true);
  });

  test('rounds toward zero from integers, and a gain shows a plus sign', () => {
    expect(exitValueRow(buy('3000000', '1'), sellDoc('2999999'))!.roundTripPct).toBe('0.00%');
    expect(exitValueRow(buy('100000000', '1'), sellDoc('100500000'))!.roundTripPct).toBe('+0.50%');
  });

  test('a sell ticket has no exit value line', () => {
    expect(exitValueRow({input: {side: 'sell', input: {token: GEAR, baseUnits: '1'}}, output: null}, sellDoc('1'))).toBeNull();
  });

  test('no sell quote yet, a refused sell, or a sell that would only queue: says not available, never a number', () => {
    for (const s of [null, sellDoc(null), sellDoc('90000000', 'queued', false), sellDoc('90000000', 'instant', false)]) {
      const row = exitValueRow(buy('100000000', '1'), s)!;
      expect(row.value).toBe(EXIT_VALUE_UNAVAILABLE);
      expect(row.num).toBe(false);
      expect(row.roundTripPct).toBeNull();
    }
    expect(exitValueRow(buy('100000000', null), sellDoc('1'))!.value).toBe(EXIT_VALUE_UNAVAILABLE);
  });

  test('a closed-market sell (lower of last and reference) still counts: it executes now', () => {
    expect(exitValueRow(buy('100000000', '1'), sellDoc('95000000', 'instant_min'))!.value).toBe('95 USDG (round trip -5.00%)');
  });

  test('the service asks the existing /v1/quote for a sell of exactly the bought tokens', async () => {
    const seen: string[] = [];
    const svc = createOverdriveService({apiOrigin: 'http://api.test', chainId: 4663}, async (url, init) => {
      seen.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify(sellDoc('97730000')), {status: 200});
    });
    expect((await svc.sellValue('NVDA-SPORT', '1000000000000000000')).usdgOut).toBe('97730000');
    expect(seen).toEqual(['GET http://api.test/v1/quote?gear=NVDA-SPORT&side=sell&tokens=1000000000000000000']);
  });
});

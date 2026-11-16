// Closed-market and paused-feed sells: the review shows both documented paths (sell now at the lower of the last value
// and the pool price, or queue for the next fresh price) and a queued sell shows its pending state until it settles.
import {describe, expect, test} from 'bun:test';
import {EXIT_QUEUED_RULE, EXPECTED_LABEL, NO_ESTIMATE, QUEUE_RULE, SELL_NOW_RULE, closedSellView, queuedSellLine, quoteAmountRows} from '../src/lib/live-view';
import type {ExitQueueRow, Snapshot} from '../src/services/contract';
import {IDLE, type LiveState} from '../src/services/poller';
import {ACCOUNT} from './fixtures';

const sell = (execution: 'immediate' | 'queued', sellMode: 'instant' | 'instant_min' | 'queued' | null) => ({execution, sellMode, input: {side: 'sell' as const}});
const stamp = {chainId: 4663, blockNumber: '1200', observedAt: '2026-11-16T12:00:00Z'};
const row: ExitQueueRow = {
  ticket: '7', gearId: 'TSLA-SPORT', account: ACCOUNT,
  quantity: {token: {address: '0x00000000000000000000000000000000000000aa', symbol: 'TSLA-SPORT', decimals: 18}, baseUnits: '1500000000000000000'},
  minimumOutput: {token: {address: '0x00000000000000000000000000000000000000bb', symbol: 'USDG', decimals: 6}, baseUnits: '1000000'},
  createdAt: '2026-11-16T12:00:00Z', status: 'open', canCancel: true, settlement: 'Paid at the next fresh price, never below your minimum.',
};
const ready = (rows: ExitQueueRow[]): LiveState<Snapshot<ExitQueueRow[]>> => ({...IDLE, status: 'ready', data: {data: rows, stamp, stale: false}});

describe('closed-market sell review', () => {
  test('a buy and an open-market sell show no closed-market paths', () => {
    expect(closedSellView({execution: 'immediate', sellMode: null, input: {side: 'buy'}})).toBeNull();
    expect(closedSellView(sell('immediate', 'instant'))).toBeNull();
    expect(closedSellView(sell('immediate', undefined as never))).toBeNull();
  });

  test('market closed: both paths, sell now at the lower price is this quote', () => {
    const v = closedSellView(sell('immediate', 'instant_min'))!;
    expect(v.paths.map((p) => [p.rule, p.current])).toEqual([[SELL_NOW_RULE, true], [QUEUE_RULE, false]]);
    expect(v.action).toBe('Sell at the lower price');
    expect(v.lead).toContain('lower of the last value and the pool price');
  });

  test('no fresh price (feed paused or stale): both paths, the queue is this quote', () => {
    const v = closedSellView(sell('queued', 'queued'))!;
    expect(v.paths.map((p) => p.current)).toEqual([false, true]);
    expect(v.action).toBe('Queue the sell');
    expect(v.lead).toContain('next fresh price');
  });

  test('copy rules: no em dashes (the public guard covers the word list)', () => {
    const all = JSON.stringify([closedSellView(sell('immediate', 'instant_min')), closedSellView(sell('queued', 'queued'))]);
    expect(all).not.toContain('\u2014');
  });
});

describe('queued sell pending state', () => {
  test('before the queue record arrives it waits; on error it says the sell is on chain', () => {
    expect(queuedSellLine(IDLE, 'TSLA-SPORT', false)).toMatchObject({pending: true, seen: false, text: 'Queued sell sent. Waiting for the queue record.'});
    expect(queuedSellLine(ready([]), 'TSLA-SPORT', false)).toMatchObject({pending: true, seen: false});
    expect(queuedSellLine({...IDLE, status: 'error'}, 'TSLA-SPORT', false).text).toContain('on chain');
  });

  test('a ticket in the queue shows pending with its amount and settlement rule', () => {
    const l = queuedSellLine(ready([row]), 'TSLA-SPORT', false);
    expect(l).toMatchObject({pending: true, seen: true});
    expect(l.text).toBe('Queued sell pending: ticket 7, 1.5 TSLA-SPORT. Paid at the next fresh price, never below your minimum.');
    expect(queuedSellLine(ready([{...row, gearId: 'NVDA-SPORT'}]), 'TSLA-SPORT', false).seen).toBe(false);
  });

  test('a ticket that was seen and has left the queue is settled', () => {
    expect(queuedSellLine(ready([]), 'TSLA-SPORT', true)).toMatchObject({pending: false, seen: true, text: expect.stringContaining('Queued sell settled')});
  });
});

describe('queued sell review amounts', () => {
  const GEAR = {address: '0x00000000000000000000000000000000000000aa', symbol: 'TSLA-SPORT', decimals: 18};
  const USDG = {address: '0x00000000000000000000000000000000000000bb', symbol: 'USDG', decimals: 6};
  const quote = (execution: 'immediate' | 'queued', output: string | null, settlement: string | null = null) => ({
    execution, settlement, input: {input: {token: GEAR, baseUnits: '500000000000000000'}},
    output: output === null ? null : {token: USDG, baseUnits: output}, minimumOutput: {token: USDG, baseUnits: '49500000'},
  });
  const text = (rows: {label: string; value: string}[]) => rows.map((r) => `${r.label}: ${r.value}`).join('\n');

  test('a queued sell shows its expected proceeds, its minimum and the queue rule, never "You receive"', () => {
    const rows = quoteAmountRows(quote('queued', '49750000', 'A sell now is queued and paid at the next fresh price, never below your minimum.'));
    expect(rows.map((r) => r.label)).toEqual(['You pay', EXPECTED_LABEL, 'Minimum received', 'How it is paid']);
    expect(text(rows)).toContain(`${EXPECTED_LABEL}: 49.75 USDG`);
    expect(text(rows)).toContain('Minimum received: 49.5 USDG');
    expect(rows[3].value).toBe(EXIT_QUEUED_RULE);
    expect(text(rows)).not.toContain('You receive');
  });

  test('a queued sell never renders a 0 amount: a missing or 0 estimate is said in words', () => {
    for (const out of [null, '0']) {
      const t = text(quoteAmountRows(quote('queued', out)));
      expect(t).not.toContain('You receive 0');
      expect(t).not.toMatch(/: 0 USDG/);
      expect(t).toContain(`${EXPECTED_LABEL}: ${NO_ESTIMATE}`);
      expect(t).toContain(`How it is paid: ${EXIT_QUEUED_RULE}`);
    }
  });

  test('an immediate trade keeps "You receive"', () => {
    expect(text(quoteAmountRows(quote('immediate', '49750000')))).toContain('You receive: 49.75 USDG');
  });
});

// Closed-market and paused-feed sells: the review shows both documented paths (sell now at the lower of the last value
// and the pool price, or queue for the next fresh price) and a queued sell shows its pending state until it settles.
import {describe, expect, test} from 'bun:test';
import {QUEUE_RULE, SELL_NOW_RULE, closedSellView, queuedSellLine} from '../src/lib/live-view';
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

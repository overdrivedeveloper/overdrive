// Trade ticket fixes from the testnet click-through: the ticket follows the listed market the select shows, the
// daily toll prints with at most 3 decimals, and Done closes the review after a confirmed trade.
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {quoteRefusal, reviewButton, ticketMarket, tollPctText} from '../src/lib/live-view';

describe('ticket market follows the listed set', () => {
  test('with only ETH listed, the ticket starting on TSLA becomes ETH and a quote request is not refused', () => {
    const listed = ['ETH'];
    expect(quoteRefusal('TSLA', 'Sport', '100', listed)).toBe('This market is not listed on chain yet.');
    const market = ticketMarket('TSLA', listed);
    expect(market).toBe('ETH');
    expect(quoteRefusal(market, 'Sport', '100', listed)).toBeNull();
  });
  test('a listed market is kept, and nothing changes before the list answers', () => {
    expect(ticketMarket('TSLA', ['ETH', 'TSLA'])).toBe('TSLA');
    expect(ticketMarket('TSLA', [])).toBe('TSLA');
  });
});

describe('daily toll formatting', () => {
  test('at most 3 decimals', () => {
    expect(tollPctText('0.03356172520704')).toBe('0.034%');
    expect(tollPctText(0.1)).toBe('0.1%');
    expect(tollPctText('-0.0125')).toBe('-0.013%');
    expect(tollPctText('0.00001')).toBe('0%');
    expect(tollPctText(null)).toBe('Not reported');
    expect(tollPctText('')).toBe('Not reported');
  });
});

describe('review button', () => {
  test('after confirmation Done is enabled and closes', () => {
    expect(reviewButton({kind: 'confirmed'}, 'confirming')).toEqual({done: true, disabled: false, action: 'close'});
  });
  test('disabled only while a wallet step is open', () => {
    expect(reviewButton(null, 'signing')).toMatchObject({disabled: true, action: 'execute'});
    expect(reviewButton(null, null)).toMatchObject({disabled: false, action: 'execute'});
    expect(reviewButton({kind: 'rejected'}, 'signing')).toMatchObject({disabled: false, action: 'execute'});
  });
});

test('the dashboard wires the helpers (ticket sync, toll text, Done closes)', () => {
  const src = readFileSync(join(import.meta.dir, '../src/sections/PeopleNine/PeopleNine.tsx'), 'utf8');
  expect(src).toContain('ticketMarket(market,listed.symbols)');
  expect(src).toContain('tollPctText(q.dailyTollPct)');
  expect(src).not.toMatch(/`\$\{q\.dailyTollPct\}%`/);
  expect(src.match(/onClick=\{btn\.action==='close'\?onClose:/g)).toHaveLength(2);
});

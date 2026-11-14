// R9 wallet flows against a scripted EIP-1193 wallet (the fork version is tests/fork.test.ts): wrong chain, rejection,
// account change mid-flow, plus the client-side codes ALLOWANCE_REQUIRED, QUOTE_EXPIRED, SLIPPAGE_EXCEEDED, EXIT_QUEUED.
import {expect, test} from 'bun:test';
import {encodeErrorResult, parseAbi} from 'viem';
import {executeQuote, type Eip1193} from '../src/services/overdrive';
import {ACCOUNT, DEPLOYMENT, NOW, OTHER, quote} from './fixtures';

type Script = {chainId?: number; accounts?: string[][]; allowance?: bigint; reject?: boolean; revert?: string; receiptStatus?: string};
function wallet(s: Script = {}) {
  const calls: string[] = [];
  let accountReads = 0;
  const p: Eip1193 = {
    request: async ({method, params}) => {
      calls.push(method);
      if (method === 'eth_chainId') return `0x${(s.chainId ?? 31337).toString(16)}`;
      if (method === 'eth_accounts') { const list = s.accounts ?? [[ACCOUNT]]; return list[Math.min(accountReads++, list.length - 1)]; }
      if (method === 'eth_call') {
        const [c] = params as [{data: string}];
        if (c.data.startsWith('0xdd62ed3e')) return `0x${(s.allowance ?? 10n ** 30n).toString(16)}`; // allowance
        if (s.revert) throw {code: -32603, message: 'execution reverted', data: s.revert};
        return '0x';
      }
      if (method === 'eth_sendTransaction') { if (s.reject) throw {code: 4001, message: 'User rejected'}; return `0x${'aa'.repeat(32)}`; }
      if (method === 'eth_getTransactionReceipt') return {status: s.receiptStatus ?? '0x1', blockNumber: '0x10'};
      throw new Error(`unexpected ${method}`);
    },
  };
  return {p, calls};
}
const run = (s: Script, o: Partial<Parameters<typeof executeQuote>[0]> = {}) => executeQuote({provider: wallet(s).p, deployment: DEPLOYMENT, quote: quote(), now: () => NOW, pollMs: 1, ...o});

test('happy path: allowance ok, simulate, sign, receipt confirmed', async () => {
  const w = wallet();
  const r = await executeQuote({provider: w.p, deployment: DEPLOYMENT, quote: quote(), now: () => NOW, pollMs: 1});
  expect(r).toEqual({kind: 'confirmed', hash: `0x${'aa'.repeat(32)}`, blockNumber: 16n});
  expect(w.calls.indexOf('eth_call')).toBeLessThan(w.calls.indexOf('eth_sendTransaction'));
});
test('wrong chain: stops before anything is signed', async () => {
  const w = wallet({chainId: 4663});
  expect(await executeQuote({provider: w.p, deployment: DEPLOYMENT, quote: quote(), now: () => NOW})).toMatchObject({kind: 'error', error: {code: 'WRONG_CHAIN'}});
  expect(w.calls).not.toContain('eth_sendTransaction');
});
test('rejection in the wallet is a rejected outcome, not an error', async () => {
  expect(await run({reject: true})).toEqual({kind: 'rejected'});
});
test('account change: before the flow and between approval and signature', async () => {
  expect(await run({accounts: [[OTHER]]})).toEqual({kind: 'account_changed'});
  expect(await run({accounts: [[ACCOUNT], [ACCOUNT], [OTHER]], allowance: 0n}, {approve: true})).toEqual({kind: 'account_changed'});
  expect(await run({accounts: [[ACCOUNT], []]})).toEqual({kind: 'account_changed'});
});
test('code ALLOWANCE_REQUIRED when the allowance is short and approvals are not requested', async () => {
  expect(await run({allowance: 1n})).toMatchObject({kind: 'error', error: {code: 'ALLOWANCE_REQUIRED'}});
});
test('code QUOTE_EXPIRED: an expired quote never reaches the wallet', async () => {
  expect(await run({}, {now: () => NOW + 60_000})).toMatchObject({kind: 'error', error: {code: 'QUOTE_EXPIRED'}});
});
test('code SLIPPAGE_EXCEEDED: the simulation reverts Slippage, nothing is sent', async () => {
  const data = encodeErrorResult({abi: parseAbi(['error Slippage(uint256 got, uint256 limit)']), errorName: 'Slippage', args: [1n, 2n]});
  const w = wallet({revert: data});
  expect(await executeQuote({provider: w.p, deployment: DEPLOYMENT, quote: quote(), now: () => NOW})).toMatchObject({kind: 'error', error: {code: 'SLIPPAGE_EXCEEDED'}});
  expect(w.calls).not.toContain('eth_sendTransaction');
});
test('code EXIT_QUEUED: a queued sell needs the queue rule accepted', async () => {
  const q = quote({functionName: 'queueSell', args: [quote().transaction.args[0], '1', '1', ACCOUNT]}, {execution: 'queued', approvals: []});
  expect(await run({}, {quote: q})).toMatchObject({kind: 'error', error: {code: 'EXIT_QUEUED'}});
  expect((await run({}, {quote: q, acceptQueued: true})).kind).toBe('confirmed');
});
test('a reverted receipt is failed, never confirmed', async () => {
  expect((await run({receiptStatus: '0x0'})).kind).toBe('failed');
});
test('an intent outside the allowlist is refused before the wallet sees it', async () => {
  const w = wallet();
  const r = await executeQuote({provider: w.p, deployment: DEPLOYMENT, quote: quote({contract: OTHER as `0x${string}`}), now: () => NOW});
  expect(r).toMatchObject({kind: 'error', error: {code: 'SERVICE_UNAVAILABLE'}});
  expect(w.calls).not.toContain('eth_sendTransaction');
});

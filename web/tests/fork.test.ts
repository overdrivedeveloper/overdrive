// R6 (QUOTE-1) and R9 on the anvil fork stack, plus the fork smoke of every compat route. Runs only when the stack is up:
//   FORK_API_URL=http://127.0.0.1:3341 FORK_RPC_URL=http://127.0.0.1:8785 FORK_DEPLOYMENT=$FORK_DIR/deployment.json bun test tests/fork.test.ts
// The wallet is anvil's unlocked dev account behind a minimal EIP-1193 shim; nothing here can reach a real network
// (the RPC must be loopback and report chain 31337).
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {encodeFunctionData} from 'viem';
import {ERC20_ABI, type DeploymentFile} from '../src/services/allowlist';
import {SERVICE_ERROR_CODES, type MarketGear} from '../src/services/contract';
import {createOverdriveService, executeQuote, type Eip1193} from '../src/services/overdrive';

const API = process.env.FORK_API_URL;
const RPC = process.env.FORK_RPC_URL;
const DEP = process.env.FORK_DEPLOYMENT;
const ON = !!(API && RPC && DEP && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC));
const ACCOUNT = (process.env.FORK_ACCOUNT ?? '0xcd3B766CCDd6AE721141F452C550Ca635964ce71') as `0x${string}`; // anvil dev account 15
const OTHER = '0x2546BcD3c84621e976D8185a91A922aE77ECEc30'; // anvil dev account 16

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(RPC!, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
  const j = (await r.json()) as {result?: unknown; error?: {code: number; message: string; data?: unknown}};
  if (j.error) throw j.error;
  return j.result;
}
/** A wallet: anvil signs for the unlocked account; the shim can lie about chain or account, or reject, like a real wallet. */
function shim(o: {chainId?: number; accounts?: () => string[]; reject?: boolean} = {}): Eip1193 & {sent: number} {
  const w = {
    sent: 0,
    request: async ({method, params}: {method: string; params?: unknown[]}) => {
      if (method === 'eth_chainId' && o.chainId) return `0x${o.chainId.toString(16)}`;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return o.accounts ? o.accounts() : [ACCOUNT];
      if (method === 'eth_sendTransaction') { if (o.reject) throw {code: 4001, message: 'User rejected the request.'}; w.sent += 1; }
      return rpc(method, params ?? []);
    },
  };
  return w;
}
const balanceOf = async (token: string, who: string) => BigInt((await rpc('eth_call', [{to: token, data: encodeFunctionData({abi: ERC20_ABI, functionName: 'balanceOf', args: [who as `0x${string}`]})}, 'latest'])) as string);

const deployment = (): DeploymentFile => JSON.parse(readFileSync(DEP!, 'utf8')) as DeploymentFile;
const svc = () => createOverdriveService({apiOrigin: API!, chainId: 31337});

test.skipIf(!ON)('fork smoke: every compat route answers its shape or a ServiceError with one of the 14 codes', async () => {
  expect(Number(await rpc('eth_chainId'))).toBe(31337);
  const s = svc();
  const d = deployment();
  const gear = d.gears[0]!.symbol;
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['market.list', () => s.marketList()], ['gear.snapshot', () => s.gearSnapshot(gear)], ['trade.status', () => s.tradeStatus(`0x${'00'.repeat(32)}`)],
    ['exit.queueStatus', () => s.exitQueueStatus(ACCOUNT)], ['portfolio.positions', () => s.portfolioPositions(ACCOUNT)], ['backer.vaults', () => s.backerVaults(ACCOUNT)],
    ['governor.snapshot', () => s.governorSnapshot()], ['stake.account', () => s.stakeAccount(ACCOUNT)], ['activity.list', () => s.activityList(ACCOUNT)],
    ['trade.quote', () => s.tradeQuote({chainId: 31337, account: ACCOUNT, gearId: gear, side: 'buy', input: {token: {address: d.external.usdg as `0x${string}`, symbol: 'USDG', decimals: 6}, baseUnits: '10000000'}, slippageBps: 50})],
    ['backer.quoteAction', () => s.backerQuoteAction({chainId: 31337, account: ACCOUNT, action: 'open', gearId: gear, amount: '100000000'})],
    ['stake.quoteAction', () => s.stakeQuoteAction({chainId: 31337, account: ACCOUNT, action: 'stake', amount: '1'})],
  ];
  const seen: Record<string, string> = {};
  for (const [name, call] of calls) {
    try {
      const r = (await call()) as {stamp?: {chainId: number; blockNumber: string}; rows?: unknown[]};
      if (r.stamp) { expect(r.stamp.chainId).toBe(31337); expect(r.stamp.blockNumber).toMatch(/^\d+$/); }
      seen[name] = 'ok';
    } catch (e) {
      const code = (e as {code?: string}).code ?? 'none';
      expect({name, code, valid: (SERVICE_ERROR_CODES as readonly string[]).includes(code)}).toEqual({name, code, valid: true});
      seen[name] = code;
    }
  }
  console.log('fork smoke', JSON.stringify(seen));
  expect(Object.keys(seen)).toHaveLength(12);
}, 60_000);

test.skipIf(!ON)('R6 QUOTE-1: trade.quote equals execution at the quoted limit; one unit above the limit reverts Slippage', async () => {
  const s = svc();
  const d = deployment();
  const markets = await s.marketList();
  const g = (markets.data ?? []).find((m: MarketGear) => m.canBuy && m.token);
  expect(g, 'no buyable gear on the fork (market closed and no 24/7 gear?)').toBeTruthy();
  const usdg = {address: d.external.usdg as `0x${string}`, symbol: 'USDG', decimals: 6};
  const q = await s.tradeQuote({chainId: 31337, account: ACCOUNT, gearId: g!.id, side: 'buy', input: {token: usdg, baseUnits: '100000000'}, slippageBps: 0});
  expect(q.minimumOutput.baseUnits).toBe(q.output.baseUnits);
  // one unit above the quoted output: the contract must refuse it (the limit binds), and nothing is sent
  const tight = {...q, transaction: {...q.transaction, args: q.transaction.args.map((a, i) => (i === 2 ? (BigInt(a as string) + 1n).toString() : a))}};
  const w0 = shim();
  const refused = await executeQuote({provider: w0, deployment: d, quote: tight, approve: true, pollMs: 200});
  expect(refused).toMatchObject({kind: 'error', error: {code: 'SLIPPAGE_EXCEEDED'}});
  // the exact quote at its limit executes for exactly the quoted output
  const before = await balanceOf(g!.token!.address, ACCOUNT);
  const q2 = await s.tradeQuote({chainId: 31337, account: ACCOUNT, gearId: g!.id, side: 'buy', input: {token: usdg, baseUnits: '100000000'}, slippageBps: 0});
  const r = await executeQuote({provider: shim(), deployment: d, quote: q2, approve: true, pollMs: 200});
  expect(r.kind).toBe('confirmed');
  const got = (await balanceOf(g!.token!.address, ACCOUNT)) - before;
  console.log('QUOTE-1', g!.id, 'quoted', q2.output.baseUnits, 'received', got.toString());
  expect(got.toString()).toBe(q2.output.baseUnits);
  if (r.kind === 'confirmed') {
    const st = await s.tradeStatus(r.hash);
    expect(['confirmed', 'confirming']).toContain(st.data!.status);
  }
}, 120_000);

test.skipIf(!ON)('R9 on the fork: wrong chain, rejection and account change never move funds', async () => {
  const s = svc();
  const d = deployment();
  const g = ((await s.marketList()).data ?? []).find((m) => m.canBuy && m.token);
  expect(g).toBeTruthy();
  const usdg = {address: d.external.usdg as `0x${string}`, symbol: 'USDG', decimals: 6};
  const q = await s.tradeQuote({chainId: 31337, account: ACCOUNT, gearId: g!.id, side: 'buy', input: {token: usdg, baseUnits: '1000000'}, slippageBps: 50});
  const before = await balanceOf(usdg.address, ACCOUNT);
  const wrong = shim({chainId: 4663});
  expect(await executeQuote({provider: wrong, deployment: d, quote: q, approve: true})).toMatchObject({kind: 'error', error: {code: 'WRONG_CHAIN'}});
  const rejecting = shim({reject: true});
  expect(await executeQuote({provider: rejecting, deployment: d, quote: q, approve: true})).toEqual({kind: 'rejected'});
  let reads = 0;
  const switching = shim({accounts: () => (reads++ < 1 ? [ACCOUNT] : [OTHER])});
  expect(await executeQuote({provider: switching, deployment: d, quote: q, approve: true})).toEqual({kind: 'account_changed'});
  expect(wrong.sent + rejecting.sent + switching.sent).toBe(0);
  expect(await balanceOf(usdg.address, ACCOUNT)).toBe(before);
}, 60_000);

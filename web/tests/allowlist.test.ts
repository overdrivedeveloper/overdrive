// R7: intents are checked against the deployment file and a reviewed ABI list, and encoded by the client.
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {decodeFunctionData, toFunctionSelector, toEventSelector, type AbiFunction, type AbiError} from 'viem';
import {BACKER_ABI, ERRORS_ABI, IntentRefused, MINTER_ABI, RULES, STAKE_ABI, encodeApproval, encodeIntent} from '../src/services/allowlist';
import {ACCOUNT, DEPLOYMENT, GEAR_ID, NOW, OTHER, quote} from './fixtures';

const committed = (name: string) => { const raw = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'app', 'src', 'abi', `${name}.json`), 'utf8')); return (Array.isArray(raw) ? raw : raw.abi) as Array<{type: string; name: string}>; };
const wallet = {account: ACCOUNT, chainId: 31337};

test('every allowed function and decoded error has the selector of the committed ABI', () => {
  const pairs: Array<[readonly unknown[], string]> = [[MINTER_ABI, 'IODMinter'], [BACKER_ABI, 'IODBacker'], [STAKE_ABI, 'IODStake']];
  for (const [abi, name] of pairs) {
    const real = committed(name).filter((x) => x.type === 'function').map((f) => toFunctionSelector(f as unknown as AbiFunction));
    for (const f of abi as AbiFunction[]) expect({name, fn: f.name, known: real.includes(toFunctionSelector(f))}).toEqual({name, fn: f.name, known: true});
  }
  const errors = ['IODMinter', 'IODGovernor', 'IODBacker'].flatMap((n) => committed(n).filter((x) => x.type === 'error').map((e) => toFunctionSelector(e as unknown as AbiFunction)));
  for (const e of ERRORS_ABI as readonly AbiError[]) expect({e: e.name, known: errors.includes(toFunctionSelector(e as unknown as AbiFunction))}).toEqual({e: e.name, known: true});
  expect(Object.keys(RULES).sort()).toEqual(['buy', 'cancelQueued', 'deposit', 'mint', 'openVault', 'queueSell', 'repay', 'requestUnstake', 'sell', 'stake', 'unstake', 'withdraw']);
  void toEventSelector;
});

test('a valid buy intent encodes to the buy call the client builds itself', () => {
  const call = encodeIntent(quote().transaction, DEPLOYMENT, wallet, NOW);
  expect(call.to).toBe(DEPLOYMENT.contracts.ODMinter as `0x${string}`);
  expect(call.value).toBe('0x0');
  const d = decodeFunctionData({abi: MINTER_ABI, data: call.data});
  expect(d.functionName).toBe('buy');
  expect(d.args[1]).toBe(5_000_000n);
});

const refused = (over: Parameters<typeof quote>[0], w = wallet) => { try { encodeIntent(quote(over).transaction, DEPLOYMENT, w, NOW); return null; } catch (e) { expect(e).toBeInstanceOf(IntentRefused); return (e as Error).message; } };

test('refuses anything outside the deployment and the allowlist; never forwards calldata', () => {
  expect(refused({contract: OTHER as `0x${string}`})).toMatch(/must target ODMinter/);
  expect(refused({functionName: 'transfer'})).toMatch(/not allowed/);
  expect(refused({functionName: 'setHook', args: [OTHER]})).toMatch(/not allowed/);
  expect(refused({functionName: 'constructor'})).toMatch(/not allowed/);
  expect(refused({chainId: 4663})).toMatch(/chain/);
  expect(refused({}, {account: ACCOUNT, chainId: 1})).toMatch(/chain/);
  expect(refused({account: OTHER as `0x${string}`})).toMatch(/connected wallet/);
  expect(refused({valueBaseUnits: '1'})).toMatch(/native value/);
  expect(refused({args: [`0x${'cd'.repeat(32)}`, '5000000', '1', ACCOUNT, String(Math.floor(NOW / 1000) + 300)]})).toMatch(/unknown gear/);
  expect(refused({args: [GEAR_ID, '5000000', '1', OTHER, String(Math.floor(NOW / 1000) + 300)]})).toMatch(/recipient/);
  expect(refused({args: [GEAR_ID, '5000000', '1', ACCOUNT, String(Math.floor(NOW / 1000) - 1)]})).toMatch(/deadline/);
  expect(refused({args: [GEAR_ID, '-5', '1', ACCOUNT, String(Math.floor(NOW / 1000) + 300)]})).toMatch(/amounts/);
  // a raw data field on the intent is ignored: the call is always re-encoded from functionName and args
  const sneaky = {...quote().transaction, data: '0xdeadbeef'} as never;
  expect(encodeIntent(sneaky, DEPLOYMENT, wallet, NOW).data.startsWith('0xdeadbeef')).toBe(false);
  // a withdrawal to anyone but the wallet is refused
  expect(refused({contract: DEPLOYMENT.contracts.ODBacker as `0x${string}`, functionName: 'withdraw', args: ['1', '10', OTHER]})).toMatch(/wallet only/);
  expect(refused({contract: DEPLOYMENT.contracts.ODBacker as `0x${string}`, functionName: 'withdraw', args: ['1', '10', ACCOUNT]})).toBeNull();
});

test('approvals: only deployment tokens to deployment spenders', () => {
  const a = quote().approvals[0]!;
  expect(encodeApproval(a, DEPLOYMENT).to).toBe(DEPLOYMENT.external.usdg as `0x${string}`);
  expect(() => encodeApproval({...a, spender: OTHER as `0x${string}`}, DEPLOYMENT)).toThrow(IntentRefused);
  expect(() => encodeApproval({...a, token: {...a.token, address: OTHER as `0x${string}`}}, DEPLOYMENT)).toThrow(IntentRefused);
  expect(() => encodeApproval({...a, method: 'verified_permit'}, DEPLOYMENT)).toThrow(IntentRefused);
  expect(encodeApproval({...a, token: {address: OTHER as `0x${string}`, symbol: 'OVRD', decimals: 18}, spender: DEPLOYMENT.contracts.ODStake as `0x${string}`}, DEPLOYMENT, OTHER).to).toBe(OTHER as `0x${string}`);
});

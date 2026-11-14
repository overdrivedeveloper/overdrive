// R7: the client never forwards calldata from a server. It takes a TransactionIntent (contract, functionName, args), checks
// every field against the committed deployment file and this reviewed ABI list, and encodes the call itself.
import {encodeFunctionData, parseAbi, type Hex} from 'viem';
import type {ApprovalRequirement, TransactionIntent} from './contract';

/** The fields of app/deployments/<chain>.json the client needs. */
export type DeploymentFile = {
  chainId: number;
  external: {usdg: string};
  contracts: Record<string, string>;
  gears: Array<{id: string; symbol: string; token: string}>;
  ovrd?: string;
};

/** Reviewed fragments; tests/allowlist.test.ts checks each selector against the committed ABIs in app/src/abi. */
export const MINTER_ABI = parseAbi([
  'function buy(bytes32 gear, uint256 usdgIn, uint256 minTokensOut, address recipient, uint64 deadline) returns (uint256)',
  'function sell(bytes32 gear, uint256 tokensIn, uint256 minUsdgOut, address recipient, uint64 deadline) returns (uint256)',
  'function queueSell(bytes32 gear, uint256 tokensIn, uint256 minUsdgOut, address recipient) returns (uint256)',
  'function cancelQueued(uint256 ticket)',
]);
export const BACKER_ABI = parseAbi([
  'function openVault(bytes32 gear, uint256 collateralUsdg) returns (uint256)',
  'function deposit(uint256 vaultId, uint256 usdg)',
  'function withdraw(uint256 vaultId, uint256 usdg, address to)',
  'function mint(uint256 vaultId, uint256 tokens, bool sellToGovernor, uint256 minProceedsUsdg)',
  'function repay(uint256 vaultId, uint256 tokens)',
]);
export const STAKE_ABI = parseAbi([
  'function stake(uint256 amount)',
  'function requestUnstake(uint256 shares)',
  'function unstake()',
]);
export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
/** Reverts the client turns into service codes (names from the committed ABIs). */
export const ERRORS_ABI = parseAbi([
  'error Slippage(uint256 got, uint256 limit)', 'error Expired()', 'error BuysClosed(bytes32 gearId, bytes32 reason)', 'error CapExceeded(bytes32 gearId, uint256 openWad, uint256 capWad)',
  'error UseQueue()', 'error BelowMinimum()', 'error Undercollateralized(uint256 ratioBps, uint256 requiredBps)',
]);

type Rule = {contract: 'ODMinter' | 'ODBacker' | 'ODStake'; abi: readonly unknown[]; check: (args: readonly unknown[], ctx: Ctx) => string | null};
type Ctx = {d: DeploymentFile; account: string; now: number};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;
const lower = (v: unknown) => String(v).toLowerCase();
const isGear = (d: DeploymentFile, v: unknown) => typeof v === 'string' && d.gears.some((g) => g.id.toLowerCase() === v.toLowerCase());
const uint = (v: unknown) => typeof v === 'string' && UINT.test(v);
const self = (ctx: Ctx, v: unknown) => typeof v === 'string' && lower(v) === lower(ctx.account);
const deadlineOk = (ctx: Ctx, v: unknown) => uint(v) && Number(v) * 1000 > ctx.now && Number(v) * 1000 < ctx.now + 3_600_000;

export const RULES: Record<string, Rule> = {
  buy: {contract: 'ODMinter', abi: MINTER_ABI, check: (a, c) => !isGear(c.d, a[0]) ? 'unknown gear' : !uint(a[1]) || !uint(a[2]) ? 'amounts' : !self(c, a[3]) ? 'recipient must be the wallet' : !deadlineOk(c, a[4]) ? 'deadline' : null},
  sell: {contract: 'ODMinter', abi: MINTER_ABI, check: (a, c) => !isGear(c.d, a[0]) ? 'unknown gear' : !uint(a[1]) || !uint(a[2]) ? 'amounts' : !self(c, a[3]) ? 'recipient must be the wallet' : !deadlineOk(c, a[4]) ? 'deadline' : null},
  queueSell: {contract: 'ODMinter', abi: MINTER_ABI, check: (a, c) => !isGear(c.d, a[0]) ? 'unknown gear' : !uint(a[1]) || !uint(a[2]) ? 'amounts' : !self(c, a[3]) ? 'recipient must be the wallet' : null},
  cancelQueued: {contract: 'ODMinter', abi: MINTER_ABI, check: (a) => (uint(a[0]) ? null : 'ticket')},
  openVault: {contract: 'ODBacker', abi: BACKER_ABI, check: (a, c) => !isGear(c.d, a[0]) ? 'unknown gear' : !uint(a[1]) ? 'amount' : null},
  deposit: {contract: 'ODBacker', abi: BACKER_ABI, check: (a) => (uint(a[0]) && uint(a[1]) ? null : 'amounts')},
  withdraw: {contract: 'ODBacker', abi: BACKER_ABI, check: (a, c) => !uint(a[0]) || !uint(a[1]) ? 'amounts' : !self(c, a[2]) ? 'withdraw goes to the wallet only' : null},
  mint: {contract: 'ODBacker', abi: BACKER_ABI, check: (a) => (uint(a[0]) && uint(a[1]) && typeof a[2] === 'boolean' && uint(a[3]) ? null : 'arguments')},
  repay: {contract: 'ODBacker', abi: BACKER_ABI, check: (a) => (uint(a[0]) && uint(a[1]) ? null : 'amounts')},
  stake: {contract: 'ODStake', abi: STAKE_ABI, check: (a) => (uint(a[0]) ? null : 'amount')},
  requestUnstake: {contract: 'ODStake', abi: STAKE_ABI, check: (a) => (uint(a[0]) ? null : 'amount')},
  unstake: {contract: 'ODStake', abi: STAKE_ABI, check: (a) => (a.length === 0 ? null : 'arguments')},
};

export class IntentRefused extends Error {
  constructor(reason: string) { super(`Transaction refused: ${reason}.`); this.name = 'IntentRefused'; }
}

export type EncodedCall = {to: `0x${string}`; data: Hex; value: '0x0'};

/** Checks one intent and returns the call the wallet signs. Throws IntentRefused on anything outside the allowlist. */
export function encodeIntent(intent: TransactionIntent, d: DeploymentFile, wallet: {account: string; chainId: number}, now = Date.now()): EncodedCall {
  if (intent.chainId !== d.chainId || wallet.chainId !== d.chainId) throw new IntentRefused('chain does not match the deployment');
  if (!ADDRESS.test(intent.account) || lower(intent.account) !== lower(wallet.account)) throw new IntentRefused('account is not the connected wallet');
  if (intent.valueBaseUnits !== '0') throw new IntentRefused('native value must be 0');
  if (!Object.prototype.hasOwnProperty.call(RULES, intent.functionName)) throw new IntentRefused(`function ${intent.functionName} is not allowed`);
  const rule = RULES[intent.functionName]!;
  const target = d.contracts[rule.contract];
  if (!target || !ADDRESS.test(target) || lower(target) !== lower(intent.contract)) throw new IntentRefused(`${intent.functionName} must target ${rule.contract} from the deployment file`);
  if (!Array.isArray(intent.args)) throw new IntentRefused('args');
  const why = rule.check(intent.args, {d, account: wallet.account, now});
  if (why) throw new IntentRefused(why);
  const args = intent.args.map((a) => (typeof a === 'string' && UINT.test(a) ? BigInt(a) : a));
  const data = (encodeFunctionData as (p: {abi: readonly unknown[]; functionName: string; args: unknown[]}) => Hex)({abi: rule.abi, functionName: intent.functionName, args});
  return {to: target as `0x${string}`, data, value: '0x0'};
}

/** An approval is allowed only for a deployment token (USDG, a gear token, OVRD) to a deployment spender. */
export function encodeApproval(a: ApprovalRequirement, d: DeploymentFile, ovrd?: string): EncodedCall {
  const tokens = [d.external.usdg, ...d.gears.map((g) => g.token), ...(ovrd ? [ovrd] : []), ...(d.ovrd ? [d.ovrd] : [])].map(lower);
  const spenders = ['ODMinter', 'ODBacker', 'ODStake'].map((k) => d.contracts[k]).filter((x): x is string => !!x && ADDRESS.test(x)).map(lower);
  if (!tokens.includes(lower(a.token.address))) throw new IntentRefused('approval token is not in the deployment');
  if (!spenders.includes(lower(a.spender))) throw new IntentRefused('approval spender is not in the deployment');
  if (a.method !== 'approve' || !UINT.test(a.requiredBaseUnits)) throw new IntentRefused('approval method or amount');
  return {to: a.token.address as `0x${string}`, data: encodeFunctionData({abi: ERC20_ABI, functionName: 'approve', args: [a.spender as `0x${string}`, BigInt(a.requiredBaseUnits)]}), value: '0x0'};
}

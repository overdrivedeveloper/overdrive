import type {DeploymentFile} from '../src/services/allowlist';
import type {Quote} from '../src/services/contract';

export const ACCOUNT = '0x1111111111111111111111111111111111111111';
export const OTHER = '0x2222222222222222222222222222222222222222';
export const TSLA_SPORT_ADDR = '0x4296084332088993e280efaffd25474cd3f997f5';
export const GEAR_ID = `0x${'ab'.repeat(32)}`;
export const DEPLOYMENT: DeploymentFile = {
  chainId: 31337,
  external: {usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'},
  contracts: {ODMinter: '0xbb4422D0B20Ee5fb20D3BFBBf37BACb6fA0a9a7e', ODBacker: '0x13b69443F873A69c473ec89d75634C508483A41F', ODStake: '0xCE11A673ED91C495d9bb2002eae0BE09e2b78B45'},
  gears: [{id: GEAR_ID, symbol: 'TSLA-SPORT', token: TSLA_SPORT_ADDR}],
};
export const NOW = 1_800_000_000_000;
export function quote(over: Partial<Quote['transaction']> = {}, q: Partial<Quote> = {}): Quote {
  const token = {address: DEPLOYMENT.gears[0]!.token as `0x${string}`, symbol: 'TSLA-SPORT', decimals: 18};
  const usdg = {address: DEPLOYMENT.external.usdg as `0x${string}`, symbol: 'USDG', decimals: 6};
  const expiresAt = new Date(NOW + 30_000).toISOString();
  return {
    id: 'q1', input: {chainId: 31337, account: ACCOUNT, gearId: 'TSLA-SPORT', side: 'buy', input: {token: usdg, baseUnits: '5000000'}, slippageBps: 50},
    stamp: {chainId: 31337, blockNumber: '1000', observedAt: new Date(NOW).toISOString()}, expiresAt, execution: 'immediate',
    output: {token, baseUnits: '49800796812749003'}, minimumOutput: {token, baseUnits: '49551792828685257'}, dailyTollPct: '0.09863', spreadBps: 40, priceImpactPct: '0', gasEstimateBaseUnits: null,
    approvals: [{token: usdg, spender: DEPLOYMENT.contracts.ODMinter as `0x${string}`, requiredBaseUnits: '5000000', method: 'approve'}],
    transaction: {chainId: 31337, account: ACCOUNT, contract: DEPLOYMENT.contracts.ODMinter as `0x${string}`, functionName: 'buy', args: [GEAR_ID, '5000000', '49551792828685257', ACCOUNT, String(Math.floor(NOW / 1000) + 300)], valueBaseUnits: '0', expiresAt, ...over},
    ...q,
  };
}

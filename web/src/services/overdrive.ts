// The one typed service module (R3): every request the site makes goes through here; views never call fetch.
// Reads: the 12 procedures of contract.ts on our API (/v1/compat/<procedure>). Writes: the wallet signs a call that this
// module encodes itself from a validated intent (allowlist.ts); the API never sees a key and nothing is sent without review.
import {decodeErrorResult, encodeFunctionData, type Hex} from 'viem';
import {ERC20_ABI, ERRORS_ABI, IntentRefused, encodeApproval, encodeIntent, type DeploymentFile} from './allowlist';
import type {
  AccountEvent, ActionQuote, Address, BackerAction, BackerVault, ExitQueueRow, GearSnapshot, GovernorSnapshot, MarketGear, Paged, Position,
  Quote, QuoteInput, ServiceError, ServiceErrorCode, Snapshot, StakeAccount, StakeAction, SystemStatus,
} from './contract';
import {SERVICE_ERROR_CODES} from './contract';

export type ServiceConfig = {apiOrigin: string; chainId: number};
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ServiceFailure extends Error {
  constructor(readonly error: ServiceError) { super(error.message); this.name = 'ServiceFailure'; }
  get code(): ServiceErrorCode { return this.error.code; }
}
export const failure = (code: ServiceErrorCode, message: string, retryable = false): ServiceFailure => new ServiceFailure({code, message, retryable});

/** Any answer that is not a well-formed ServiceError becomes SERVICE_UNAVAILABLE: never a bare status, never another code. */
export function toServiceError(status: number, body: unknown): ServiceError {
  const b = body as Partial<ServiceError> | null;
  if (b && typeof b.code === 'string' && (SERVICE_ERROR_CODES as readonly string[]).includes(b.code) && typeof b.message === 'string') {
    return {code: b.code as ServiceErrorCode, message: b.message, retryable: !!b.retryable, ...(typeof b.retryAfterMs === 'number' ? {retryAfterMs: b.retryAfterMs} : {})};
  }
  return {code: 'SERVICE_UNAVAILABLE', message: `The service answered ${status}.`, retryable: status >= 500 || status === 429};
}

export function createOverdriveService(config: ServiceConfig, fetchImpl: FetchLike = (i, o) => fetch(i, o)) {
  const base = config.apiOrigin.replace(/\/$/, '');
  async function call<T>(procedure: string, query?: Record<string, string | undefined>, body?: unknown, signal?: AbortSignal, path = `/v1/compat/${procedure}`): Promise<T> {
    const qs = query ? Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`).join('&') : '';
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}${qs ? `?${qs}` : ''}`, body === undefined
        ? {method: 'GET', signal}
        : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal});
    } catch (e) {
      if ((e as {name?: string})?.name === 'AbortError') throw e;
      throw new ServiceFailure({code: 'SERVICE_UNAVAILABLE', message: 'The service could not be reached.', retryable: true});
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new ServiceFailure(toServiceError(res.status, json));
    return json as T;
  }
  const chain = String(config.chainId);
  return {
    config,
    marketList: (signal?: AbortSignal) => call<Snapshot<MarketGear[]>>('market.list', {chainId: chain}, undefined, signal),
    gearSnapshot: (gearId: string, signal?: AbortSignal) => call<Snapshot<GearSnapshot>>('gear.snapshot', {gearId, chainId: chain}, undefined, signal),
    tradeQuote: (input: QuoteInput, signal?: AbortSignal) => call<Quote>('trade.quote', undefined, input, signal),
    tradeStatus: (hash: string, signal?: AbortSignal) => call<Snapshot<AccountEvent>>('trade.status', {hash, chainId: chain}, undefined, signal),
    exitQueueStatus: (account: Address, signal?: AbortSignal) => call<Snapshot<ExitQueueRow[]>>('exit.queueStatus', {account, chainId: chain}, undefined, signal),
    portfolioPositions: (account: Address, signal?: AbortSignal) => call<Snapshot<Position[]>>('portfolio.positions', {account, chainId: chain}, undefined, signal),
    backerVaults: (account: Address, signal?: AbortSignal) => call<Snapshot<BackerVault[]>>('backer.vaults', {account, chainId: chain}, undefined, signal),
    backerQuoteAction: (input: BackerAction, signal?: AbortSignal) => call<ActionQuote>('backer.quoteAction', undefined, input, signal),
    governorSnapshot: (signal?: AbortSignal) => call<Snapshot<GovernorSnapshot>>('governor.snapshot', {chainId: chain}, undefined, signal),
    stakeAccount: (account: Address, signal?: AbortSignal) => call<Snapshot<StakeAccount>>('stake.account', {account, chainId: chain}, undefined, signal),
    stakeQuoteAction: (input: StakeAction, signal?: AbortSignal) => call<ActionQuote>('stake.quoteAction', undefined, input, signal),
    /** GET /v1/status: service heartbeats, including the hedger's mode (dry_run or live). */
    systemStatus: (signal?: AbortSignal) => call<SystemStatus>('status', undefined, undefined, signal, '/v1/status'),
    activityList: (account: Address, cursor?: string, signal?: AbortSignal) => call<Paged<AccountEvent>>('activity.list', {account, cursor, chainId: chain}, undefined, signal),
  };
}
export type OverdriveService = ReturnType<typeof createOverdriveService>;

// ------------------------------------------------------------------ wallet execution (R6, R7, R9)

export type Eip1193 = {request: (args: {method: string; params?: unknown[]}) => Promise<unknown>};
export type FlowStatus = 'checking' | 'approving' | 'signing' | 'submitted' | 'confirming' | 'confirmed';
export type FlowResult =
  | {kind: 'confirmed'; hash: Hex; blockNumber: bigint}
  | {kind: 'failed'; hash: Hex; blockNumber: bigint}
  | {kind: 'rejected'}
  | {kind: 'account_changed'}
  | {kind: 'error'; error: ServiceError};

export type ExecuteOptions = {
  provider: Eip1193; deployment: DeploymentFile; quote: Pick<Quote, 'expiresAt' | 'execution' | 'approvals' | 'transaction'>;
  /** Send the approvals the quote lists when the allowance is short. False: stop with ALLOWANCE_REQUIRED. */
  approve?: boolean;
  /** A queued sell is only sent when the person accepted the queue rule; otherwise EXIT_QUEUED. */
  acceptQueued?: boolean;
  ovrd?: string; now?: () => number; onStatus?: (s: FlowStatus) => void; pollMs?: number; timeoutMs?: number;
};

const REJECTED = 4001;
const isRejection = (e: unknown) => (e as {code?: number})?.code === REJECTED || (e as {cause?: {code?: number}})?.cause?.code === REJECTED;

/** A revert from eth_call or a wallet, as a service code when we know it. */
export function classifyRevert(e: unknown): ServiceError {
  const data = findRevertData(e);
  if (data) {
    try {
      const r = decodeErrorResult({abi: ERRORS_ABI, data});
      if (r.errorName === 'Slippage') return {code: 'SLIPPAGE_EXCEEDED', message: 'The price moved past your slippage limit. Ask for a new quote.', retryable: true};
      if (r.errorName === 'Expired') return {code: 'QUOTE_EXPIRED', message: 'This quote has expired. Ask for a new one.', retryable: true};
      if (r.errorName === 'CapExceeded') return {code: 'CAP_REACHED', message: 'This gear is at its cap for this size.', retryable: true};
      if (r.errorName === 'UseQueue') return {code: 'EXIT_QUEUED', message: 'A sell now is queued and paid at the next fresh price.', retryable: false};
      if (r.errorName === 'Undercollateralized') return {code: 'INSUFFICIENT_COLLATERAL', message: 'The vault would fall below its required ratio.', retryable: false};
      if (r.errorName === 'BuysClosed') {
        const reason = hexText(r.args[1] as Hex);
        if (reason === 'STALE' || reason === 'REF_UNAVAILABLE') return {code: 'FEED_STALE', message: 'The price is not fresh enough.', retryable: true};
        if (reason === 'CLOSED' || reason === 'HALTED') return {code: 'MARKET_CLOSED', message: 'The market is closed.', retryable: true};
        return {code: 'FEED_PAUSED', message: 'Buys are paused for this gear.', retryable: true};
      }
    } catch { /* unknown revert */ }
  }
  return {code: 'SERVICE_UNAVAILABLE', message: 'The transaction would revert. Nothing was sent.', retryable: false};
}
function findRevertData(e: unknown, depth = 0): Hex | null {
  if (!e || typeof e !== 'object' || depth > 4) return null;
  const o = e as {data?: unknown; cause?: unknown; error?: unknown};
  if (typeof o.data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(o.data)) return o.data as Hex;
  if (o.data && typeof o.data === 'object') { const d = findRevertData(o.data, depth + 1); if (d) return d; }
  return findRevertData(o.cause, depth + 1) ?? findRevertData(o.error, depth + 1);
}
const hexText = (h: Hex) => { let s = ''; for (let i = 2; i < h.length; i += 2) { const c = parseInt(h.slice(i, i + 2), 16); if (c) s += String.fromCharCode(c); } return s; };

const sameAddress = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Review happens before this call. Then: expiry, chain, account, queue rule, allowlist, allowance, simulation, signature,
 * receipt. The account is re-read before every signature so a wallet switch mid-flow stops the flow (R9).
 */
export async function executeQuote(o: ExecuteOptions): Promise<FlowResult> {
  const now = o.now ?? Date.now;
  const tx = o.quote.transaction;
  const status = (s: FlowStatus) => o.onStatus?.(s);
  const err = (code: ServiceErrorCode, message: string, retryable = false): FlowResult => ({kind: 'error', error: {code, message, retryable}});
  status('checking');
  if (Date.parse(o.quote.expiresAt) <= now()) return err('QUOTE_EXPIRED', 'This quote has expired. Ask for a new one.', true);
  const chainId = Number(await o.provider.request({method: 'eth_chainId'}));
  if (chainId !== o.deployment.chainId || tx.chainId !== o.deployment.chainId) return err('WRONG_CHAIN', 'Switch your wallet to the network this quote is for.');
  const account = async () => ((await o.provider.request({method: 'eth_accounts'})) as string[] | undefined)?.[0] ?? '';
  if (!sameAddress(await account(), tx.account)) return {kind: 'account_changed'};
  if (o.quote.execution === 'queued' && !o.acceptQueued) return err('EXIT_QUEUED', 'This sell is queued and paid at the next fresh price. Accept the queue rule to continue.');
  // The contract checks the deadline against block.timestamp, so the allowlist window counts from the later of the wall clock
  // and the chain head (a chain ahead of the wall, like a warped fork, would otherwise refuse every intent).
  const head = await o.provider.request({method: 'eth_getBlockByNumber', params: ['latest', false]}).catch(() => null) as {timestamp?: string} | null;
  const headMs = head?.timestamp ? Number(BigInt(head.timestamp)) * 1000 : 0;
  let call;
  try { call = encodeIntent(tx, o.deployment, {account: tx.account, chainId}, Math.max(now(), headMs)); } catch (e) {
    if (e instanceof IntentRefused) return err('SERVICE_UNAVAILABLE', e.message);
    throw e;
  }
  const send = async (c: {to: string; data: Hex; value: string}): Promise<{hash: Hex} | FlowResult> => {
    if (!sameAddress(await account(), tx.account)) return {kind: 'account_changed'};
    try {
      return {hash: (await o.provider.request({method: 'eth_sendTransaction', params: [{from: tx.account, to: c.to, data: c.data, value: c.value}]})) as Hex};
    } catch (e) {
      if (isRejection(e)) return {kind: 'rejected'};
      return {kind: 'error', error: classifyRevert(e)};
    }
  };
  for (const a of o.quote.approvals) {
    const encoded = (() => { try { return encodeApproval(a, o.deployment, o.ovrd); } catch (e) { return e as Error; } })();
    if (encoded instanceof Error) return err('SERVICE_UNAVAILABLE', encoded.message);
    const allowanceData = encodeFunctionData({abi: ERC20_ABI, functionName: 'allowance', args: [tx.account as `0x${string}`, a.spender as `0x${string}`]});
    const allowance = BigInt((await o.provider.request({method: 'eth_call', params: [{to: a.token.address, data: allowanceData}, 'latest']})) as string);
    if (allowance >= BigInt(a.requiredBaseUnits)) continue;
    if (!o.approve) return err('ALLOWANCE_REQUIRED', `Approve ${a.token.symbol} first.`);
    status('approving');
    const sent = await send(encoded);
    if (!('hash' in sent)) return sent;
    const r = await waitReceipt(o, sent.hash);
    if (r.kind !== 'confirmed') return r;
  }
  try {
    await o.provider.request({method: 'eth_call', params: [{from: tx.account, to: call.to, data: call.data}, 'latest']});
  } catch (e) {
    return {kind: 'error', error: classifyRevert(e)};
  }
  status('signing');
  const sent = await send(call);
  if (!('hash' in sent)) return sent;
  status('submitted');
  return waitReceipt(o, sent.hash);
}

async function waitReceipt(o: ExecuteOptions, hash: Hex): Promise<FlowResult> {
  const deadline = Date.now() + (o.timeoutMs ?? 120_000);
  o.onStatus?.('confirming');
  for (;;) {
    const r = (await o.provider.request({method: 'eth_getTransactionReceipt', params: [hash]})) as {status?: string; blockNumber?: string} | null;
    if (r && r.blockNumber) {
      const blockNumber = BigInt(r.blockNumber);
      if (r.status === '0x1') { o.onStatus?.('confirmed'); return {kind: 'confirmed', hash, blockNumber}; }
      return {kind: 'failed', hash, blockNumber};
    }
    if (Date.now() > deadline) return {kind: 'error', error: {code: 'SERVICE_UNAVAILABLE', message: 'No receipt yet. Check the activity view.', retryable: true}};
    await new Promise((res) => setTimeout(res, o.pollMs ?? 1000));
  }
}

/** Public config only (R8): the API origin and the chain id. Every VITE_ value is public. */
export function publicConfig(env: Record<string, string | undefined>): ServiceConfig {
  const chainId = Number(env.VITE_CHAIN_ID ?? '4663');
  const apiOrigin = env.VITE_API_ORIGIN ?? '';
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('VITE_CHAIN_ID must be a positive integer');
  if (apiOrigin && !/^https?:\/\/[^\s/]+$/.test(apiOrigin)) throw new Error('VITE_API_ORIGIN must be an origin like https://api.example.com');
  return {apiOrigin, chainId};
}

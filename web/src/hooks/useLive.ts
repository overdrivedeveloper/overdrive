// Live reads for the dashboard, one hook per /v1/compat procedure. Every hook: aborts on unmount or when its key
// changes, keeps loading / error / empty apart, carries the compat ServiceError codes, and polls no faster than the API
// cache (MIN_POLL_MS). With no API origin configured the state is 'idle' and views show an honest "not connected" line.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {parseUnits} from 'viem';
import type {ActionQuote, AccountEvent, BackerVault, ExitQueueRow, GearSnapshot, GovernorSnapshot, MarketGear, Position, ServiceError, Snapshot, SystemStatus} from '../services/contract';
import {deploymentFor} from '../services/deployments';
import {executeQuote, type Eip1193, type FlowResult, type FlowStatus} from '../services/overdrive';
import {IDLE, POLL, TERMINAL, asServiceError, createPoller, type LiveState} from '../services/poller';
import {service} from './useTradeQuote';


function useLive<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, intervalMs: number, isDone?: (d: T) => boolean): LiveState<T> & {retry: () => void} {
  const [state, setState] = useState<LiveState<T>>(IDLE);
  const poller = useRef<ReturnType<typeof createPoller<T>> | null>(null);
  const loader = useRef(load); loader.current = load;
  const done = useRef(isDone); done.current = isDone;
  useEffect(() => {
    setState(IDLE);
    if (key === null || !service.config.apiOrigin) return;
    const p = createPoller<T>({load: (s) => loader.current(s), intervalMs, onChange: setState, isDone: (d) => done.current?.(d) ?? false});
    poller.current = p; p.start();
    return () => { p.stop(); if (poller.current === p) poller.current = null; };
  }, [key, intervalMs]);
  const retry = useCallback(() => poller.current?.refresh(), []);
  return {...state, retry};
}

type Account = string | null | undefined;
const acct = (a: Account) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null);

export const useMarketList = () => useLive<Snapshot<MarketGear[]>>('markets', (s) => service.marketList(s), POLL.marketList);
export const useGearSnapshot = (gearId: string | null) => useLive<Snapshot<GearSnapshot>>(gearId, (s) => service.gearSnapshot(gearId!, s), POLL.gearSnapshot);
/** GET /v1/status, read for the hedger's mode so the Governor tab never says hedging is on while it runs dry. */
export const useSystemStatus = () => useLive<SystemStatus>('status', (s) => service.systemStatus(s), POLL.status);
export const useGovernorSnapshot = () => useLive<Snapshot<GovernorSnapshot>>('governor', (s) => service.governorSnapshot(s), POLL.governor);
export const usePortfolioPositions = (account: Account) => { const a = acct(account); return useLive<Snapshot<Position[]>>(a, (s) => service.portfolioPositions(a!, s), POLL.positions); };
export const useBackerVaults = (account: Account) => { const a = acct(account); return useLive<Snapshot<BackerVault[]>>(a, (s) => service.backerVaults(a!, s), POLL.vaults); };
/** A wallet's queued sells, read only while a queued sell from this session waits to settle. */
export const useExitQueue = (account: Account, enabled: boolean) => { const a = enabled ? acct(account) : null; return useLive<Snapshot<ExitQueueRow[]>>(a, (s) => service.exitQueueStatus(a!, s), POLL.exitQueue); };
/** Polls a submitted transaction until it is confirmed, failed or replaced. */
export const useTradeStatus = (hash: string | null) => useLive<Snapshot<AccountEvent>>(hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : null, (s) => service.tradeStatus(hash!, s), POLL.tradeStatus, (d) => !!d.data && TERMINAL.has(d.data.status));

type Wallet = {provider?: Eip1193; address: string; chainId: number | null};

/** backer.quoteAction for opening a vault, then the same reviewed wallet flow as a trade. Nothing is signed without review. */
export function useBackerAction(wallet: Wallet) {
  const [quote, setQuote] = useState<ActionQuote | null>(null);
  const [error, setError] = useState<ServiceError | null>(null);
  const [loading, setLoading] = useState(false);
  const [flow, setFlow] = useState<FlowStatus | null>(null);
  const [result, setResult] = useState<FlowResult | null>(null);
  const version = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const deployment = useMemo(() => deploymentFor(service.config.chainId), []);
  const reset = useCallback(() => {
    version.current += 1; abort.current?.abort(); abort.current = null;
    setQuote(null); setError(null); setLoading(false); setFlow(null); setResult(null);
  }, []);
  useEffect(() => { reset(); return () => { version.current += 1; abort.current?.abort(); }; }, [wallet.address, wallet.chainId, reset]);

  const requestOpen = useCallback(async (gearId: string, collateralUsdg: string) => {
    reset();
    if (!service.config.apiOrigin) { setError({code: 'SERVICE_UNAVAILABLE', message: 'No vault service is configured for this site.', retryable: false}); return; }
    if (!deployment?.gears.some((g) => g.symbol === gearId)) { setError({code: 'NOT_DEPLOYED', message: `${gearId} is not deployed on this network yet.`, retryable: false}); return; }
    let amount: bigint;
    try { amount = parseUnits(collateralUsdg.trim(), 6); } catch { setError({code: 'SERVICE_UNAVAILABLE', message: 'Enter a valid amount.', retryable: false}); return; }
    const mine = ++version.current;
    const c = new AbortController(); abort.current = c;
    setLoading(true);
    try {
      const q = await service.backerQuoteAction({chainId: service.config.chainId, account: wallet.address as `0x${string}`, action: 'open', gearId, amount: amount.toString()}, c.signal);
      if (mine === version.current) setQuote(q);
    } catch (e) {
      if (mine !== version.current || (e as {name?: string})?.name === 'AbortError') return;
      setError(asServiceError(e));
    } finally {
      if (mine === version.current) setLoading(false);
    }
  }, [reset, wallet.address, deployment]);

  const execute = useCallback(async () => {
    if (!quote || !wallet.provider || !deployment) return;
    const mine = version.current;
    const r = await executeQuote({provider: wallet.provider, deployment, quote: {...quote, execution: 'immediate'}, approve: true, onStatus: (s) => { if (mine === version.current) setFlow(s); }});
    if (mine === version.current) setResult(r);
  }, [quote, wallet.provider, deployment]);

  return {quote, error, loading, flow, result, requestOpen, execute, reset};
}

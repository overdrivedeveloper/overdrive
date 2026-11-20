import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {formatUnits, parseUnits} from 'viem';
import type {Quote, ServiceError} from '../services/contract';
import {deploymentFor} from '../services/deployments';
import {ServiceFailure, createOverdriveService, executeQuote, publicConfig, type Eip1193, type FlowResult, type FlowStatus, type SellValueDoc} from '../services/overdrive';

export const service = createOverdriveService(publicConfig(import.meta.env as Record<string, string | undefined>));

type Wallet = {provider?: Eip1193; address: string; chainId: number | null};
type Request = {gearId: string; side: 'buy' | 'sell'; baseUnits: string; slippageBps: number; inputToken: {address: `0x${string}`; symbol: string; decimals: number}};

/**
 * A quote for the connected wallet and the trade ticket, then review, then the wallet flow. Any change of wallet, chain or
 * ticket clears the quote, and a late answer for an older request never paints (R9, handoff section 7).
 */
export function useTradeQuote(wallet: Wallet) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<ServiceError | null>(null);
  const [loading, setLoading] = useState(false);
  const [flow, setFlow] = useState<FlowStatus | null>(null);
  const [result, setResult] = useState<FlowResult | null>(null);
  /** Buys only: the sell quote for the tokens this buy receives (the exit value line); null until it answers or on failure. */
  const [exit, setExit] = useState<SellValueDoc | null>(null);
  const version = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const deployment = useMemo(() => deploymentFor(service.config.chainId), []);

  const reset = useCallback(() => {
    version.current += 1; abort.current?.abort(); abort.current = null;
    setQuote(null); setError(null); setLoading(false); setFlow(null); setResult(null); setExit(null);
  }, []);
  useEffect(() => { reset(); }, [wallet.address, wallet.chainId, reset]);

  const request = useCallback(async (r: Request) => {
    reset();
    if (!service.config.apiOrigin) { setError({code: 'SERVICE_UNAVAILABLE', message: 'No quote service is configured for this site.', retryable: false}); return; }
    const mine = ++version.current;
    const controller = new AbortController(); abort.current = controller;
    setLoading(true);
    try {
      const q = await service.tradeQuote({chainId: service.config.chainId, account: wallet.address as `0x${string}`, gearId: r.gearId, side: r.side, input: {token: r.inputToken, baseUnits: r.baseUnits}, slippageBps: r.slippageBps}, controller.signal);
      if (mine === version.current) setQuote(q);
      if (mine === version.current && r.side === 'buy' && q.execution === 'immediate' && q.output && BigInt(q.output.baseUnits) > 0n) {
        // best effort: a failed sell quote leaves the line at "not available", never blocks the buy
        service.sellValue(r.gearId, q.output.baseUnits, controller.signal)
          .then((doc) => { if (mine === version.current) setExit(doc); })
          .catch(() => undefined);
      }
    } catch (e) {
      if (mine !== version.current || (e as {name?: string})?.name === 'AbortError') return;
      setError(e instanceof ServiceFailure ? e.error : {code: 'SERVICE_UNAVAILABLE', message: 'The quote could not be fetched.', retryable: true});
    } finally {
      if (mine === version.current) setLoading(false);
    }
  }, [reset, wallet.address]);

  const execute = useCallback(async (acceptQueued = false) => {
    if (!quote || !wallet.provider) return;
    if (!deployment) { setError({code: 'NOT_DEPLOYED', message: 'This network has no reviewed deployment file, so nothing can be signed.', retryable: false}); return; }
    const mine = version.current;
    const r = await executeQuote({provider: wallet.provider, deployment, quote, approve: true, acceptQueued, onStatus: (s) => { if (mine === version.current) setFlow(s); }});
    if (mine === version.current) setResult(r);
  }, [quote, wallet.provider, deployment]);

  /** The ticket as the contract wants it: gear symbol, exact base units (no float), slippage in bps. */
  const requestTicket = useCallback((t: {market: string; gear: string; side: 'Buy' | 'Sell'; amount: string; slippagePct: string}) => {
    const gearId = `${t.market}-${t.gear.toUpperCase()}`;
    const side = t.side === 'Buy' ? 'buy' as const : 'sell' as const;
    const g = deployment?.gears.find((x) => x.symbol === gearId);
    const token = side === 'buy' ? (deployment ? {address: deployment.external.usdg as `0x${string}`, symbol: 'USDG', decimals: 6} : null) : g ? {address: g.token as `0x${string}`, symbol: g.symbol, decimals: 18} : null;
    if (!token) { reset(); setError({code: 'NOT_DEPLOYED', message: `${gearId} is not deployed on this network yet.`, retryable: false}); return; }
    let baseUnits: bigint;
    try { baseUnits = parseUnits(t.amount.trim(), token.decimals); } catch { reset(); setError({code: 'SERVICE_UNAVAILABLE', message: 'Enter a valid amount.', retryable: false}); return; }
    const slippageBps = Math.round(Number(t.slippagePct) * 100);
    void request({gearId, side, baseUnits: baseUnits.toString(), slippageBps: Number.isFinite(slippageBps) ? slippageBps : 50, inputToken: token});
  }, [deployment, request, reset]);

  return {quote, exit, error, loading, flow, result, request, requestTicket, execute, reset, configured: Boolean(service.config.apiOrigin)};
}

/** An Amount for display: exact decimal text from base units. */
export const amountText = (a: {token: {symbol: string; decimals: number}; baseUnits: string}, digits = 6) => {
  const [w, f = ''] = formatUnits(BigInt(a.baseUnits), a.token.decimals).split('.');
  return `${w}${f ? `.${f.slice(0, digits)}` : ''} ${a.token.symbol}`;
}

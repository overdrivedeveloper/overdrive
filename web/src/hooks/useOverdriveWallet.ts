import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAIN_HEX, CHAIN_ID } from '../lib/overdrive';

type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};
const injected = (): Provider | undefined => (window as Window & { ethereum?: Provider }).ethereum;
const accountFrom = (value: unknown): string => Array.isArray(value) && typeof value[0] === 'string' && /^0x[0-9a-f]{40}$/i.test(value[0]) ? value[0] : '';
const chainFrom = (value: unknown): number | null => {
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};
const messageFor = (error: unknown): string => {
  const value = error as { code?: number; message?: string };
  if (value?.code === 4001) return 'Connection cancelled. You can try again when you are ready.';
  if (value?.code === -32002) return 'A wallet request is already open. Check your wallet to continue.';
  if (value?.code === 4902) return 'Add Robinhood Chain to your wallet, then try switching again.';
  return 'Your wallet could not complete the request. Check your wallet and try again.';
};

export function useOverdriveWallet() {
  const [provider, setProvider] = useState<Provider | undefined>(injected);
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const requestVersion = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const detect = () => setProvider(injected());
    window.addEventListener('ethereum#initialized', detect);
    return () => { mounted.current = false; window.removeEventListener('ethereum#initialized', detect); };
  }, []);

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    const accounts = (value: unknown) => { if (!cancelled && active.current) setAddress(accountFrom(value)); };
    const chain = (value: unknown) => { if (!cancelled && active.current) setChainId(chainFrom(value)); };
    const disconnected = () => { setAddress(''); setChainId(null); };
    // These reads never open a permission prompt.
    provider.request({ method: 'eth_accounts' }).then(accounts).catch(() => {});
    provider.request({ method: 'eth_chainId' }).then(chain).catch(() => {});
    provider.on?.('accountsChanged', accounts);
    provider.on?.('chainChanged', chain);
    provider.on?.('disconnect', disconnected);
    return () => {
      cancelled = true;
      provider.removeListener?.('accountsChanged', accounts);
      provider.removeListener?.('chainChanged', chain);
      provider.removeListener?.('disconnect', disconnected);
    };
  }, [provider]);

  const connect = useCallback(async () => {
    if (connecting) return false;
    const wallet = injected();
    if (!wallet) { setError('Open Overdrive in an EVM wallet browser, or install a browser wallet to connect.'); return false; }
    active.current = true;
    setProvider(wallet);
    setError('');
    setConnecting(true);
    const version = ++requestVersion.current;
    try {
      const result = await wallet.request({ method: 'eth_requestAccounts' });
      const account = accountFrom(result);
      const chain = chainFrom(await wallet.request({ method: 'eth_chainId' }));
      if (!mounted.current || version !== requestVersion.current) return false;
      setAddress(account);
      setChainId(chain);
      if (!account) setError('No account was selected. Choose an account in your wallet to connect.');
      return Boolean(account);
    } catch (cause) {
      if (mounted.current && version === requestVersion.current) setError(messageFor(cause));
      return false;
    } finally {
      if (mounted.current && version === requestVersion.current) setConnecting(false);
    }
  }, [connecting]);

  const switchNetwork = useCallback(async () => {
    const wallet = injected();
    if (!wallet) { setError('Connect an EVM wallet to switch networks.'); return false; }
    setError('');
    try {
      await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
      if (mounted.current) setChainId(chainFrom(await wallet.request({ method: 'eth_chainId' })));
      return true;
    } catch (cause) {
      if (mounted.current) setError(messageFor(cause));
      return false;
    }
  }, []);

  const disconnect = useCallback(() => {
    active.current = false;
    requestVersion.current += 1;
    setAddress('');
    setChainId(null);
    setConnecting(false);
    setError('');
  }, []);

  return {
    provider,
    address,
    chainId,
    connected: Boolean(address),
    correctChain: chainId === CHAIN_ID,
    available: Boolean(provider),
    connecting,
    error,
    shortAddress: address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Connect wallet',
    connect,
    switchNetwork,
    disconnect,
    clearError: () => setError(''),
  };
}

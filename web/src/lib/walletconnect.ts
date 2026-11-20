// WalletConnect (Reown) for mobile wallets: an EIP-1193 provider that plugs into the same viem path as an injected
// wallet. The project id is public config (VITE_REOWN_PROJECT_ID); with no id the option is hidden (fail closed).
// The provider package is loaded with a dynamic import on first use, so it never lands in the main bundle.
import {addChainParams} from './chains';

type Env = Record<string, string | undefined>;
/** The Reown project id, or '' when unset. Only a 32-character hex id counts as set. */
export function reownProjectId(env: Env): string {
  const id = (env.VITE_REOWN_PROJECT_ID ?? '').trim();
  return /^[0-9a-f]{32}$/i.test(id) ? id : '';
}
export const walletConnectEnabled = (env: Env): boolean => reownProjectId(env) !== '';

export type WalletConnectProvider = {
  request: (args: {method: string; params?: unknown[]}) => Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
  disconnect?: () => Promise<void>;
};

let pending: Promise<WalletConnectProvider> | null = null;
/** Create (once) the WalletConnect provider for the chain. Opens nothing until `enable` is called. */
export function walletConnectProvider(projectId: string, chainId: number): Promise<WalletConnectProvider> {
  if (!projectId) return Promise.reject(new Error('WalletConnect is not configured'));
  pending ??= import('@walletconnect/ethereum-provider').then(({EthereumProvider}) => {
    const rpc = addChainParams(chainId)?.rpcUrls[0];
    return EthereumProvider.init({
      projectId,
      chains: [chainId],
      rpcMap: rpc ? {[chainId]: rpc} : undefined,
      // Only the QR / deep-link connect view. Email and social login stay off (the package sets them off), and the
      // account view (where any other extras would live) is never opened by this site.
      showQrModal: true,
      metadata: {
        name: 'Overdrive',
        description: 'Geared tokens on Robinhood Chain',
        url: typeof window === 'undefined' ? 'https://get-overdrive.com' : window.location.origin,
        icons: ['https://get-overdrive.com/overdrive-logo.png'],
      },
    }) as unknown as Promise<WalletConnectProvider>;
  }).catch((cause) => { pending = null; throw cause; });
  return pending;
}

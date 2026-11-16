// EIP-3085 parameters for wallet_addEthereumChain. Values checked live 2026-11-16 (docs/research/chain-facts.md):
// eth_chainId on each public RPC (0x1237 = 4663, 0xb626 = 46630) and both explorers answer 200.
// The chain id comes from the public config, which is the chain of the deployment record the site signs against.
export type AddChainParams = {
  chainId: string; chainName: string; rpcUrls: string[]; blockExplorerUrls: string[];
  nativeCurrency: {name: string; symbol: string; decimals: number};
};

const ETH = {name: 'Ether', symbol: 'ETH', decimals: 18};
const KNOWN: Record<number, Omit<AddChainParams, 'chainId'>> = {
  4663: {chainName: 'Robinhood Chain', rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'], nativeCurrency: ETH},
  46630: {chainName: 'Robinhood Chain Testnet', rpcUrls: ['https://rpc.testnet.chain.robinhood.com'], blockExplorerUrls: ['https://explorer.testnet.chain.robinhood.com'], nativeCurrency: ETH},
};

/** Null for a chain we have no public parameters for (a local fork): the wallet is then asked to switch only. */
export function addChainParams(chainId: number): AddChainParams | null {
  const k = KNOWN[chainId];
  return k ? {chainId: `0x${chainId.toString(16)}`, ...k} : null;
}

type Provider = {request: (args: {method: string; params?: unknown[]}) => Promise<unknown>};
const UNKNOWN_CHAIN = 4902;
/** Some mobile wallets wrap the 4902 inside data.originalError. */
export const isUnknownChain = (e: unknown): boolean => {
  const v = e as {code?: number; data?: {originalError?: {code?: number}}};
  return v?.code === UNKNOWN_CHAIN || v?.data?.originalError?.code === UNKNOWN_CHAIN;
};

/**
 * Switch the wallet to the chain. When the wallet does not know the chain (4902), offer to add it with the published
 * parameters, then switch again. Errors from the wallet (4001 cancel, -32002 pending) are thrown to the caller.
 */
export async function switchOrAddChain(wallet: Provider, chainId: number): Promise<void> {
  const hex = `0x${chainId.toString(16)}`;
  try {
    await wallet.request({method: 'wallet_switchEthereumChain', params: [{chainId: hex}]});
  } catch (cause) {
    const params = addChainParams(chainId);
    if (!isUnknownChain(cause) || !params) throw cause;
    await wallet.request({method: 'wallet_addEthereumChain', params: [params]});
    await wallet.request({method: 'wallet_switchEthereumChain', params: [{chainId: hex}]});
  }
}

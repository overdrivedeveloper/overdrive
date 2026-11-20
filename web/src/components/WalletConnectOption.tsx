// The "WalletConnect" option for mobile wallets. Rendered only when a Reown project id is configured.
export function WalletConnectOption({enabled, disabled, onClick}: {enabled: boolean; disabled?: boolean; onClick: () => void}) {
  if (!enabled) return null;
  return <button type="button" className="od-text-button" disabled={disabled} onClick={onClick}>Connect with WalletConnect (mobile wallets)</button>;
}

// The website/backend contract, from the team handoff (handoff/api-contracts.ts), now implemented by our API under
// /v1/compat/<procedure>. Changes from the proposal: a figure the service does not have is null (never 0), and the
// snapshot fields that can be missing are typed nullable.
export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type IntegerString = string;
export type DecimalString = string;
export type Gear = 'Cruise' | 'Sport' | 'Race' | 'Eco' | 'Reverse';
export type Availability = 'available' | 'not_deployed' | 'closed' | 'paused' | 'stale' | 'capacity_limited';
export type Stamp = { chainId: number; blockNumber: IntegerString; observedAt: string };
export type Token = { address: Address; symbol: string; decimals: number };
export type Amount = { token: Token; baseUnits: IntegerString };
export type Snapshot<T> = { data: T | null; stamp: Stamp; stale: boolean; unavailableReason?: string };
export type MarketGear = {
  id: string; underlying: string; gear: Gear; power: DecimalString;
  token: Token | null; poolId: Hex | null; availability: Availability;
  reason?: string; canBuy: boolean; canSell: boolean; canQueueSell: boolean;
  capUsd: DecimalString; openValueUsd: DecimalString | null; spreadBps: number;
};
export type GearSnapshot = {
  gearId: string; underlyingPrice: DecimalString | null; valuePerToken: DecimalString | null;
  priceCurrency: 'USDG'; normalisation: DecimalString | null;
  annualVolatilityPct: DecimalString | null; dailyTollPct: DecimalString | null;
  usageDailyTollPct: DecimalString | null; availability: Availability;
  feedUpdatedAt: string; raceEligible: boolean;
};
export type QuoteInput = {
  chainId: number; account: Address; gearId: string; side: 'buy' | 'sell';
  input: Amount; slippageBps: number;
};
export type TransactionIntent = {
  chainId: number; account: Address; contract: Address;
  functionName: string; args: unknown[]; valueBaseUnits: IntegerString;
  // Encode/validate against a reviewed ABI and deployment allowlist client-side.
  expiresAt: string;
};
export type ApprovalRequirement = {
  token: Token; spender: Address; requiredBaseUnits: IntegerString;
  method: 'approve' | 'verified_permit';
};
export type Quote = {
  id: string; input: QuoteInput; stamp: Stamp; expiresAt: string;
  execution: 'immediate' | 'queued'; output: Amount; minimumOutput: Amount;
  dailyTollPct: DecimalString | null; spreadBps: number; priceImpactPct: DecimalString;
  gasEstimateBaseUnits: IntegerString | null;
  approvals: ApprovalRequirement[]; transaction: TransactionIntent;
  /** Sells only: instant (market open), instant_min (closed: lower of last and pool value), queued (next fresh price). */
  sellMode?: 'instant' | 'instant_min' | 'queued' | null;
};
export type Position = {
  gearId: string; quantity: Amount; valueUsd: DecimalString | null;
  accruedTollUsd: DecimalString | null;
  // Include cost basis / P&L only when provenance and methodology are available.
};
export type BackerVault = {
  id: string; owner: Address; gearId: string; collateral: Amount; debt: Amount;
  collateralRatioPct: DecimalString | null; initialRatioPct: DecimalString;
  maintenanceRatioPct: DecimalString; health: DecimalString | null;
  weekendUpliftPct: DecimalString; canMint: boolean; status: string;
};
export type GovernorSnapshot = {
  equityUsd: DecimalString; exitReserveUsd: DecimalString; exitReserveFloorUsd: DecimalString;
  deltaUsd: DecimalString; gammaUsd: DecimalString; hedgeDeltaUsd: DecimalString;
  riskState: 'normal' | 'reduced' | 'paused';
};
export type StakeAccount = {
  available: Amount; staked: Amount; slashable: Amount;
  feeDiscountBps: number; termsVersion: string; unstakeAvailableAt: string | null;
};
export type TransactionStatus = 'submitted' | 'confirming' | 'confirmed' | 'failed' | 'replaced';
export type AccountEvent = {
  id: string; chainId: number; account: Address; kind: string; timestamp: string;
  transactionHash: Hex; status: TransactionStatus; replacementHash?: Hex;
  blockNumber: IntegerString | null; summary: string;
};
export type Paged<T> = { rows: T[]; nextCursor: string | null };
export type ServiceErrorCode =
  | 'WRONG_CHAIN' | 'NOT_DEPLOYED' | 'MARKET_CLOSED' | 'FEED_STALE' | 'FEED_PAUSED'
  | 'CAP_REACHED' | 'RACE_VOL_LIMIT' | 'INSUFFICIENT_BALANCE' | 'ALLOWANCE_REQUIRED'
  | 'QUOTE_EXPIRED' | 'SLIPPAGE_EXCEEDED' | 'INSUFFICIENT_COLLATERAL'
  | 'EXIT_QUEUED' | 'SERVICE_UNAVAILABLE';
export type ServiceError = { code: ServiceErrorCode; message: string; retryable: boolean; retryAfterMs?: number };

/** The 14 codes, as a value (the type above is the source). */
export const SERVICE_ERROR_CODES: readonly ServiceErrorCode[] = [
  'WRONG_CHAIN', 'NOT_DEPLOYED', 'MARKET_CLOSED', 'FEED_STALE', 'FEED_PAUSED', 'CAP_REACHED', 'RACE_VOL_LIMIT', 'INSUFFICIENT_BALANCE',
  'ALLOWANCE_REQUIRED', 'QUOTE_EXPIRED', 'SLIPPAGE_EXCEEDED', 'INSUFFICIENT_COLLATERAL', 'EXIT_QUEUED', 'SERVICE_UNAVAILABLE',
];
export type ExitQueueRow = {
  ticket: string; gearId: string; account: Address; quantity: Amount; minimumOutput: Amount;
  createdAt: string; status: string; canCancel: boolean; settlement: string;
};
export type ActionQuote = { id: string; stamp: Stamp; expiresAt: string; approvals: ApprovalRequirement[]; transaction: TransactionIntent };
export type BackerAction = { chainId: number; account: Address; action: 'open' | 'deposit' | 'withdraw' | 'mint' | 'repay'; gearId?: string; vaultId?: string; amount: IntegerString };
export type StakeAction = { chainId: number; account: Address; action: 'stake' | 'requestUnstake' | 'unstake'; amount?: IntegerString };

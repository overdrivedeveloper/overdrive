/** Product rules from Overdrive_Overview.md and Overdrive_Backend.md.
 * Catalog parameters describe the product, not live availability or account data.
 */
export type Gear = 'Cruise' | 'Sport' | 'Race' | 'Eco' | 'Reverse';
export type MarketGroup = 'Mega-caps' | 'Retail favourites' | 'Index ETFs' | 'Crypto' | 'Pairs';
export type GearDefinition = {
  id: Gear;
  title: string;
  power: number;
  description: string;
  tollLabel: string;
};
export type Market = {
  symbol: string;
  name: string;
  group: MarketGroup;
  spreadBps: number;
  capUsd: number;
  session: '24/7' | 'US market hours';
  gears: readonly Gear[];
};

// Public config (VITE_CHAIN_ID, default Robinhood Chain 4663); the fork stack sets 31337.
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 4663);
export const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}`;
export const CHAIN_NAME = 'Robinhood Chain';
export const SETTLEMENT = 'USDG';
export const GEARS: readonly GearDefinition[] = [
  { id: 'Cruise', title: 'Cruise', power: 1.5, description: 'A measured step up from the underlying market.', tollLabel: 'Low daily toll' },
  { id: 'Sport', title: 'Sport', power: 2, description: 'More response to every move, in both directions.', tollLabel: 'Medium daily toll' },
  { id: 'Race', title: 'Race', power: 3, description: 'The strongest response, for eligible markets only.', tollLabel: 'Higher daily toll' },
  { id: 'Eco', title: 'Eco', power: 0.5, description: 'A gentler response; the toll usually pays the holder.', tollLabel: 'Usually received' },
  { id: 'Reverse', title: 'Reverse', power: -1, description: 'Rises when the underlying falls, without holder liquidation.', tollLabel: 'Medium daily toll' },
];
export const POWERS: Record<Gear, number> = { Cruise: 1.5, Sport: 2, Race: 3, Eco: 0.5, Reverse: -1 };
const ALL_GEARS: readonly Gear[] = ['Cruise', 'Sport', 'Race', 'Eco', 'Reverse'];
const STOCK_GEARS: readonly Gear[] = ['Cruise', 'Sport', 'Eco', 'Reverse'];
const RETAIL_GEARS: readonly Gear[] = ['Cruise', 'Sport', 'Reverse'];
const PAIR_GEARS: readonly Gear[] = ['Sport'];
const groupRules: Record<MarketGroup, Pick<Market, 'spreadBps' | 'capUsd' | 'session' | 'gears'>> = {
  'Mega-caps': { spreadBps: 60, capUsd: 1_000_000, session: 'US market hours', gears: STOCK_GEARS },
  'Retail favourites': { spreadBps: 100, capUsd: 300_000, session: 'US market hours', gears: RETAIL_GEARS },
  'Index ETFs': { spreadBps: 50, capUsd: 2_000_000, session: 'US market hours', gears: ALL_GEARS },
  Crypto: { spreadBps: 40, capUsd: 5_000_000, session: '24/7', gears: ALL_GEARS },
  Pairs: { spreadBps: 80, capUsd: 500_000, session: 'US market hours', gears: PAIR_GEARS },
};
const market = (symbol: string, name: string, group: MarketGroup): Market => ({ symbol, name, group, ...groupRules[group] });
export const MARKETS: readonly Market[] = [
  market('TSLA', 'Tesla', 'Mega-caps'),
  market('NVDA', 'NVIDIA', 'Mega-caps'),
  market('AAPL', 'Apple', 'Mega-caps'),
  market('MSFT', 'Microsoft', 'Mega-caps'),
  market('META', 'Meta', 'Mega-caps'),
  market('AMZN', 'Amazon', 'Mega-caps'),
  market('HOOD', 'Robinhood', 'Retail favourites'),
  market('COIN', 'Coinbase', 'Retail favourites'),
  market('MSTR', 'Strategy', 'Retail favourites'),
  market('PLTR', 'Palantir', 'Retail favourites'),
  market('SPY', 'SPDR S&P 500 ETF', 'Index ETFs'),
  market('QQQ', 'Invesco QQQ', 'Index ETFs'),
  market('ETH', 'Ethereum', 'Crypto'),
  market('BTC', 'Bitcoin', 'Crypto'),
  market('NVDA/AMD', 'NVIDIA / AMD', 'Pairs'),
  market('HOOD/COIN', 'Robinhood / Coinbase', 'Pairs'),
  market('QQQ/SPY', 'QQQ / SPY', 'Pairs'),
];
export const MARKET_GROUPS: readonly MarketGroup[] = ['Mega-caps', 'Retail favourites', 'Index ETFs', 'Crypto', 'Pairs'];
export const FEE_ALLOCATION = [
  { label: 'Governor & reserves', percent: 80 },
  { label: 'Treasury', percent: 10 },
  { label: 'Stakers', percent: 5 },
  { label: 'Burned', percent: 5 },
] as const;

export function getMarket(symbol: string): Market | undefined {
  return MARKETS.find(item => item.symbol === symbol);
}

/** ETF Race eligibility also requires a fresh volatility input at or below 40%.
 * Omitting volatility only answers whether the gear is in the market catalog.
 */
export function isGearAllowed(symbol: string, gear: Gear, annualVolatilityPct?: number): boolean {
  const item = getMarket(symbol);
  if (!item?.gears.includes(gear)) return false;
  if (gear === 'Race' && item.group === 'Index ETFs' && annualVolatilityPct !== undefined) {
    return Number.isFinite(annualVolatilityPct) && annualVolatilityPct >= 0 && annualVolatilityPct <= 40;
  }
  return true;
}

export function tokenSymbol(symbol: string, gear: Gear): string {
  return `${symbol}-${gear === 'Reverse' ? 'REV' : gear.toUpperCase()}`;
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number.`);
}

/** Return in percentage points before toll and spread; e.g. 10, Sport → 21. */
export function priceResponse(movePct: number, gear: Gear): number {
  finite(movePct, 'Market move');
  if (movePct <= -100) throw new RangeError('Market move must be greater than −100%.');
  return (Math.pow(1 + movePct / 100, POWERS[gear]) - 1) * 100;
}

/** Annual volatility and usage are percentage inputs. Output is percent/day.
 * The default usage term is zero, so this is a formula calculation, not a quote.
 */
export function dailyTollPercent(gear: Gear, annualVolatilityPct: number, usageDailyPct = 0): number {
  finite(annualVolatilityPct, 'Annual volatility');
  finite(usageDailyPct, 'Usage toll');
  if (annualVolatilityPct < 0) throw new RangeError('Annual volatility cannot be negative.');
  const power = POWERS[gear];
  return 0.5 * power * (power - 1) * Math.pow(annualVolatilityPct / 100, 2) / 365 * 100 + usageDailyPct;
}

/** Constant-input calculation using daily normalisation; excludes execution spread. */
export function valueAfterToll(principal: number, movePct: number, gear: Gear, days: number, annualVolatilityPct: number, usageDailyPct = 0): number {
  finite(principal, 'Amount');
  finite(days, 'Holding days');
  if (principal < 0 || days < 0) throw new RangeError('Amount and holding days cannot be negative.');
  const dailyToll = dailyTollPercent(gear, annualVolatilityPct, usageDailyPct) / 100;
  if (dailyToll >= 1) throw new RangeError('Daily toll must be below 100%.');
  return principal * (1 + priceResponse(movePct, gear) / 100) * Math.pow(1 - dailyToll, days);
}

export function backerRequirements(collateralUsd: number, gear: Gear) {
  finite(collateralUsd, 'Collateral');
  if (collateralUsd < 0) throw new RangeError('Collateral cannot be negative.');
  const initialRatio = gear === 'Race' ? 2.5 : 2;
  const maintenanceRatio = gear === 'Race' ? 2 : 1.5;
  const maxDebtUsd = collateralUsd / initialRatio;
  return {
    minimumCollateralUsd: 50,
    meetsMinimum: collateralUsd >= 50,
    initialRatio,
    maintenanceRatio,
    initialPercent: initialRatio * 100,
    maintenancePercent: maintenanceRatio * 100,
    maxDebtUsd,
    maintenanceCollateralUsd: maxDebtUsd * maintenanceRatio,
    liquidationBonusPercent: 5,
  };
}

export const formatPercent = (value: number, digits = 1): string => `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
export const formatUsd = (value: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);

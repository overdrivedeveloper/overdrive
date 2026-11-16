// What the dashboard paints from a live read. Pure, so tests can prove no figure is ever invented: every number here
// comes from an API answer, and every gap is a named state (not configured, loading, unavailable, not live yet).
import {formatUnits} from 'viem';
import type {Amount, Availability, BackerVault, GearSnapshot, GovernorSnapshot, MarketGear, Position, Snapshot} from '../services/contract';
import type {LiveState} from '../services/poller';

export const NOT_LIVE = 'Not live yet';
export const NOT_REPORTED = 'Not reported';
export const LOADING = 'Loading';
export const UNAVAILABLE = 'Unavailable';

const usdFmt = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 2});
/** A DecimalString in USD for display; null stays null (the caller names the gap). */
export const usd = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? usdFmt.format(n) : null;
};
const plainFmt = new Intl.NumberFormat('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
/** A figure without the currency sign, for the balance line that already names USDG. */
export const plain = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? plainFmt.format(n) : null;
};
export const tokens = (a: Amount, digits = 4): string => {
  const [w, f = ''] = formatUnits(BigInt(a.baseUnits), a.token.decimals).split('.');
  return `${w}${f ? `.${f.slice(0, digits)}` : ''} ${a.token.symbol}`;
};

export type Gap = {value: string; hint: string};
/** The shared gap states. Null when there is a snapshot with data to show. */
export function gapOf<T>(s: LiveState<Snapshot<T>>, configured: boolean, what: string): Gap | null {
  if (!configured) return {value: NOT_LIVE, hint: `The ${what} service is not connected to this site yet.`};
  if (s.status === 'idle' || (s.status === 'loading' && !s.data)) return {value: LOADING, hint: `Reading ${what} data.`};
  if (!s.data) return {value: UNAVAILABLE, hint: s.error?.message ?? `The ${what} service did not answer.`};
  if (s.data.data === null) return {value: NOT_LIVE, hint: s.data.unavailableReason ?? `The ${what} service has not reported yet.`};
  return null;
}

export type StatCard = {title: string; value: string; hint: string; live: boolean};
const GOVERNOR_TITLES = ['Governor equity', 'Exit reserve', 'Net exposure', 'Hedge coverage'] as const;

/** The four Governor cards. A stale book (the API marks it not live) shows "Not live yet" and the reading only as reference. */
export function governorCards(s: LiveState<Snapshot<GovernorSnapshot>>, configured: boolean): StatCard[] {
  const gap = gapOf(s, configured, 'Governor');
  if (gap) return GOVERNOR_TITLES.map((title) => ({title, ...gap, live: false}));
  const snap = s.data!; const g = snap.data!;
  const delta = Number(g.deltaUsd), hedge = Number(g.hedgeDeltaUsd);
  const coverage = !Number.isFinite(delta) || !Number.isFinite(hedge) ? NOT_REPORTED : delta === 0 ? 'No net exposure' : `${Math.round(Math.abs(hedge) / Math.abs(delta) * 100)}%`;
  const values = [usd(g.equityUsd) ?? NOT_REPORTED, usd(g.exitReserveUsd) ?? NOT_REPORTED, usd(g.deltaUsd) ?? NOT_REPORTED, coverage];
  const hints = [`Risk state: ${g.riskState}`, `Floor ${usd(g.exitReserveFloorUsd) ?? NOT_REPORTED}`, `Gamma ${usd(g.gammaUsd) ?? NOT_REPORTED}`, `Hedged ${usd(g.hedgeDeltaUsd) ?? NOT_REPORTED}`];
  return GOVERNOR_TITLES.map((title, i) => snap.stale
    ? {title, value: NOT_LIVE, hint: `Last reading ${values[i]} at block ${snap.stamp.blockNumber}, for reference only.`, live: false}
    : {title, value: values[i]!, hint: `${hints[i]} · block ${snap.stamp.blockNumber}`, live: true});
}

export type PortfolioView = {total: string; unit: boolean; positionValue: string; accruedToll: string; rows: {gearId: string; quantity: string; value: string}[]; title: string; message: string};
const sumUsd = (xs: (string | null)[]): string | null => (xs.some((x) => x === null) ? null : usd(String(xs.reduce((a, x) => a + Number(x), 0))));

export function portfolioView(s: LiveState<Snapshot<Position[]>>, configured: boolean, connected: boolean): PortfolioView {
  if (!connected) return {total: 'Not connected', unit: false, positionValue: 'Not connected', accruedToll: 'Not connected', rows: [], title: 'Bring your gears with you.', message: 'Connect your EVM wallet to access your Overdrive positions on Robinhood Chain.'};
  const gap = gapOf(s, configured, 'position');
  if (gap) return {total: gap.value, unit: false, positionValue: gap.value, accruedToll: gap.value, rows: [], title: 'Your wallet is connected.', message: gap.hint};
  const rows = s.data!.data!;
  if (!rows.length) return {total: plain('0')!, unit: true, positionValue: usd('0')!, accruedToll: usd('0')!, rows: [], title: 'No gear tokens yet.', message: 'This wallet holds no Overdrive gear tokens on this network.'};
  const value = sumUsd(rows.map((r) => r.valueUsd)) ?? NOT_REPORTED;
  const total = rows.some((r) => r.valueUsd === null) ? null : plain(String(rows.reduce((a, r) => a + Number(r.valueUsd), 0)));
  return {
    total: total ?? NOT_REPORTED, unit: total !== null, positionValue: value, accruedToll: sumUsd(rows.map((r) => r.accruedTollUsd)) ?? NOT_REPORTED,
    rows: rows.map((r) => ({gearId: r.gearId, quantity: tokens(r.quantity), value: usd(r.valueUsd) ?? NOT_REPORTED})),
    title: s.data!.stale ? 'Positions, last reading.' : 'Your wallet is connected.',
    message: s.data!.stale ? `Stale reading at block ${s.data!.stamp.blockNumber}. Values may have moved.` : `As of block ${s.data!.stamp.blockNumber}.`,
  };
}

export type VaultsView = {title: string; message: string; rows: {id: string; gearId: string; collateral: string; debt: string; ratio: string; health: string; status: string}[]};
export function vaultsView(s: LiveState<Snapshot<BackerVault[]>>, configured: boolean, connected: boolean): VaultsView {
  if (!connected) return {title: 'Connect to view your vaults', message: 'Collateral, token debt and health belong here. Backer positions are separate from holder tokens.', rows: []};
  const gap = gapOf(s, configured, 'vault');
  if (gap) return {title: gap.value === LOADING ? 'Loading your vaults' : 'Vault data unavailable', message: gap.hint, rows: []};
  const rows = s.data!.data!;
  if (!rows.length) return {title: 'No backer vaults yet', message: 'This wallet has no backer vaults on this network. Backer positions are separate from holder tokens.', rows: []};
  return {
    title: s.data!.stale ? 'Your vaults, last reading' : 'Your vaults',
    message: s.data!.stale ? `Stale reading at block ${s.data!.stamp.blockNumber}.` : `As of block ${s.data!.stamp.blockNumber}. Maintenance ratio applies.`,
    rows: rows.map((v) => ({id: v.id, gearId: v.gearId, collateral: tokens(v.collateral, 2), debt: tokens(v.debt), ratio: v.collateralRatioPct === null ? 'No debt' : `${v.collateralRatioPct}% (maintenance ${v.maintenanceRatioPct}%)`, health: v.health ?? 'No debt', status: v.status})),
  };
}

/** Live spread and cap for one market from market.list; null when the API has no row for it (the catalog stays, labelled). */
export function marketLive(s: LiveState<Snapshot<MarketGear[]>>, symbol: string): {spreadBps: number; capUsd: number; availability: Availability} | null {
  const rows = s.data?.data?.filter((r) => r.underlying === symbol);
  if (!rows?.length || s.data?.stale) return null;
  const caps = rows.map((r) => Number(r.capUsd));
  if (caps.some((c) => !Number.isFinite(c))) return null;
  const open = rows.find((r) => r.availability === 'available') ?? rows[0]!;
  return {spreadBps: Math.min(...rows.map((r) => r.spreadBps)), capUsd: caps.reduce((a, c) => a + c, 0), availability: open.availability};
}

const AVAILABILITY: Record<Availability, string> = {
  available: 'Live price feed', not_deployed: 'Not deployed yet', closed: 'Market closed', paused: 'Buys paused', stale: 'Price feed stale', capacity_limited: 'At its cap',
};
/** The "Executable quote" line on the ticket: the feed state from gear.snapshot, never a price we do not have. */
export function feedLine(s: LiveState<Snapshot<GearSnapshot>>, configured: boolean): string {
  const gap = gapOf(s, configured, 'price');
  if (gap) return gap.value === LOADING ? 'Checking price feed' : gap.value === NOT_LIVE ? 'Awaiting price feed' : 'Price feed unavailable';
  return s.data!.stale ? 'Price feed stale' : AVAILABILITY[s.data!.data!.availability];
}
/** The toll line on a gear card: the live daily toll when gear.snapshot reports one, else the catalog label. */
export function tollLine(s: LiveState<Snapshot<GearSnapshot>>, fallback: string): string {
  const t = s.data && !s.data.stale ? s.data.data?.dailyTollPct : null;
  return t === null || t === undefined ? fallback : `Daily toll ${t}%`;
}

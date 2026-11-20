// What the dashboard paints from a live read. Pure, so tests can prove no figure is ever invented: every number here
// comes from an API answer, and every gap is a named state (not configured, loading, unavailable, not live yet).
import {formatUnits} from 'viem';
import type {Amount, Availability, BackerVault, ExitQueueRow, Quote, GearSnapshot, GovernorSnapshot, MarketGear, Position, Snapshot, SystemStatus} from '../services/contract';
import type {LiveState} from '../services/poller';
import {isGearAllowed, type Gear} from './overdrive';

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
const GOVERNOR_TITLES = ['Governor equity', 'Exit reserve', 'Net exposure', 'Outside hedge'] as const;

/** The hedger's run mode from GET /v1/status. 'live' only when the hedger reports dryRun false; no report is 'unknown'. */
export type HedgerMode = 'live' | 'dry_run' | 'unknown';
export function hedgerMode(s: LiveState<SystemStatus>): HedgerMode {
  const mode = s.data?.services?.find((x) => x.job === 'hedger')?.mode;
  return mode === 'live' ? 'live' : mode === 'dry_run' ? 'dry_run' : 'unknown';
}
export const HEDGE_OFF = 'Off';
/** One sentence about outside hedging that is true in every mode: it says hedging is on only when the hedger is live. */
export function hedgingLine(mode: HedgerMode): string {
  if (mode === 'live') return 'Gears net against each other inside one book, and the Governor offsets what remains on an outside venue.';
  if (mode === 'dry_run') return 'Gears net against each other inside one book. The Governor can offset what remains on an outside venue; that is off until the venues are set up.';
  return 'Gears net against each other inside one book. The hedger has not reported, so no outside hedge is claimed.';
}

/** The four Governor cards. A stale book (the API marks it not live) shows "Not live yet" and the reading only as reference.
 * The outside hedge card shows a coverage figure only when the hedger is live and a hedge is open; otherwise it says so. */
export function governorCards(s: LiveState<Snapshot<GovernorSnapshot>>, configured: boolean, hedger: HedgerMode = 'unknown'): StatCard[] {
  const gap = gapOf(s, configured, 'Governor');
  if (gap) return GOVERNOR_TITLES.map((title) => ({title, ...gap, live: false}));
  const snap = s.data!; const g = snap.data!;
  const delta = Number(g.deltaUsd), hedge = Number(g.hedgeDeltaUsd);
  const open = hedger === 'live' && Number.isFinite(hedge) && hedge !== 0;
  const coverage = hedger !== 'live' ? HEDGE_OFF : !open ? 'No hedge open' : !Number.isFinite(delta) || delta === 0 ? NOT_REPORTED : `${Math.round(Math.abs(hedge) / Math.abs(delta) * 100)}%`;
  const hedgeHint = hedger === 'dry_run' ? 'Off until the venues are set up (the hedger runs in dry run)' : hedger === 'unknown' ? 'The hedger has not reported' : open ? `Offset ${usd(g.hedgeDeltaUsd) ?? NOT_REPORTED} of net exposure` : 'The hedger is on; nothing is offset now';
  const values = [usd(g.equityUsd) ?? NOT_REPORTED, usd(g.exitReserveUsd) ?? NOT_REPORTED, usd(g.deltaUsd) ?? NOT_REPORTED, coverage];
  const hints = [`Risk state: ${g.riskState}`, `Floor ${usd(g.exitReserveFloorUsd) ?? NOT_REPORTED}`, `Gamma ${usd(g.gammaUsd) ?? NOT_REPORTED}`, hedgeHint];
  return GOVERNOR_TITLES.map((title, i) => snap.stale
    ? {title, value: NOT_LIVE, hint: `Last reading ${values[i]} at block ${snap.stamp.blockNumber}, for reference only.`, live: false}
    : {title, value: values[i]!, hint: `${hints[i]} · block ${snap.stamp.blockNumber}`, live: true});
}

/** Which markets the site may show as tradeable: only underlyings the API lists with a deployed gear token, never the catalog.
 * Until the market list answers, no market is shown as tradeable and `ready` is false. */
export type ListedView = {ready: boolean; symbols: string[]; message: string};
export function listedMarkets(s: LiveState<Snapshot<MarketGear[]>>, configured: boolean): ListedView {
  const gap = gapOf(s, configured, 'market');
  if (gap) return {ready: false, symbols: [], message: `${gap.hint} No market is shown as tradeable until it answers.`};
  const symbols = [...new Set(s.data!.data!.filter((r) => r.token !== null && r.availability !== 'not_deployed').map((r) => r.underlying))];
  return {ready: true, symbols, message: symbols.length ? `${symbols.length} listed on chain, as of block ${s.data!.stamp.blockNumber}.` : 'No market is listed on chain yet.'};
}
/** Split a catalog into the listed (tradeable) part and the part that is coming later. Not ready: nothing is tradeable or listed as later. */
export function splitCatalog<M extends {symbol: string}>(catalog: readonly M[], view: ListedView): {tradeable: M[]; later: M[]} {
  if (!view.ready) return {tradeable: [], later: []};
  return {tradeable: catalog.filter((m) => view.symbols.includes(m.symbol)), later: catalog.filter((m) => !view.symbols.includes(m.symbol))};
}
/** The markets counter: the number of listed markets, or a dash while the list is not read. */
export const marketCount = (catalog: readonly {symbol: string}[], view: ListedView): string => (view.ready ? String(splitCatalog(catalog, view).tradeable.length) : '-');

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

/** The two documented ways a sell is paid while the market is closed or the feed is paused (API sellMode). */
export const SELL_NOW_RULE = 'Sell now at the lower of the last value and the pool price.';
export const QUEUE_RULE = 'Queue for the next fresh price, never below your minimum.';

/** Review copy for a sell quote: null for a buy or an open-market sell; otherwise both paths and the one this quote takes. */
export function closedSellView(q: Pick<Quote, 'execution' | 'sellMode'> & {input: {side: 'buy' | 'sell'}}) {
  if (q.input.side !== 'sell') return null;
  const queued = q.execution === 'queued';
  if (!queued && q.sellMode !== 'instant_min') return null;
  return {
    lead: queued
      ? 'This sell cannot be paid now, so it is queued: it is paid at the next fresh price, never below your minimum.'
      : 'The market is closed. This sell is paid now at the lower of the last value and the pool price.',
    paths: [
      {label: 'Sell now', rule: SELL_NOW_RULE, current: !queued},
      {label: 'Queue', rule: QUEUE_RULE, current: queued},
    ],
    action: queued ? 'Queue the sell' : 'Sell at the lower price',
  };
}

/** The queue rule a queued quote shows (the API's EXIT_QUEUED words), used when the quote carries no settlement line. */
export const EXIT_QUEUED_RULE = 'A sell now is queued and paid at the next fresh price, never below your minimum.';
export const EXPECTED_LABEL = 'Expected at the next fresh price';
export const NO_ESTIMATE = 'No estimate: there is no price to estimate from right now. Your minimum still holds.';

const amountLine = (a: Amount, digits = 6) => {
  const [w, f = ''] = formatUnits(BigInt(a.baseUnits), a.token.decimals).split('.');
  return `${w}${f ? `.${f.slice(0, digits)}` : ''} ${a.token.symbol}`;
};

/** The amount rows of a quote review. A queued sell shows its estimate under its own label and never a 0 amount: an
 * estimate that is missing or 0 is said in words. The minimum is the floor the queue honours. */
export function quoteAmountRows(q: Pick<Quote, 'execution' | 'output' | 'minimumOutput' | 'settlement'> & {input: {input: Amount}}): {label: string; value: string; num: boolean}[] {
  const pay = {label: 'You pay', value: amountLine(q.input.input), num: true};
  const min = {label: 'Minimum received', value: amountLine(q.minimumOutput), num: true};
  if (q.execution !== 'queued') {
    return [pay, q.output ? {label: 'You receive', value: amountLine(q.output), num: true} : {label: 'You receive', value: NOT_REPORTED, num: false}, min];
  }
  const est = q.output && BigInt(q.output.baseUnits) > 0n ? {label: EXPECTED_LABEL, value: amountLine(q.output), num: true} : {label: EXPECTED_LABEL, value: NO_ESTIMATE, num: false};
  return [pay, est, min, {label: 'How it is paid', value: q.settlement || EXIT_QUEUED_RULE, num: false}];
}

export const EXIT_VALUE_LABEL = 'Exit value now';
export const EXIT_VALUE_UNAVAILABLE = 'Not available right now';
export const EXIT_VALUE_NOTE = 'What selling these tokens right after buying would pay at this block. A buy uses the higher of the two price sources and a sell the lower, so a round trip can cost more than the two spreads.';

/**
 * The buy review's exit value: the sell quote for exactly the tokens this buy receives, and the round trip against what
 * the buy pays. Null for a sell ticket. A sell that would only queue, or no sell quote, says so instead of a number.
 */
export function exitValueRow(
  q: Pick<Quote, 'output'> & {input: {side: 'buy' | 'sell'; input: Amount}},
  sell: {buyable: boolean; sellMode: string | null; usdgOut: string | null} | null,
): {label: string; value: string; num: boolean; roundTripPct: string | null} | null {
  if (q.input.side !== 'buy') return null;
  const none = {label: EXIT_VALUE_LABEL, value: EXIT_VALUE_UNAVAILABLE, num: false, roundTripPct: null};
  if (!q.output || !sell || !sell.buyable || sell.sellMode === 'queued' || sell.usdgOut === null || !/^\d+$/.test(sell.usdgOut)) return none;
  const paid = BigInt(q.input.input.baseUnits);
  if (paid <= 0n) return none;
  const out = BigInt(sell.usdgOut);
  // signed percent with two decimals, rounded toward zero, from integers only
  const bp = ((out - paid) * 10_000n) / paid;
  const abs = bp < 0n ? -bp : bp;
  const pctText = `${bp < 0n ? '-' : bp > 0n ? '+' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}%`;
  const usdg = {token: q.input.input.token, baseUnits: sell.usdgOut};
  return {label: EXIT_VALUE_LABEL, value: `${amountLine(usdg, 2)} (round trip ${pctText})`, num: true, roundTripPct: pctText};
}

/**
 * The pending line for a queued sell sent from this session. `seen` is true once the ticket has appeared in the queue;
 * a ticket that was seen and is gone has settled (filled or cancelled), so the line says only that it left the queue.
 */
export function queuedSellLine(state: LiveState<Snapshot<ExitQueueRow[]>>, gearId: string, seen: boolean): {text: string; pending: boolean; seen: boolean} {
  const rows = state.data?.data?.filter((r) => r.gearId === gearId) ?? null;
  if (rows && rows.length > 0) {
    const r = rows[rows.length - 1];
    return {text: `Queued sell pending: ticket ${r.ticket}, ${tokens(r.quantity)}. ${r.settlement}`, pending: true, seen: true};
  }
  if (rows && seen) return {text: 'Queued sell settled: it is no longer in the queue. Check your activity for the fill.', pending: false, seen: true};
  if (state.status === 'error') return {text: 'The queue status is unavailable right now. Your queued sell is on chain.', pending: true, seen};
  return {text: 'Queued sell sent. Waiting for the queue record.', pending: true, seen};
}


/** A daily toll percent with at most 3 decimals ("0.03356172520704" -> "0.034%"); null when the service reports none. */
export function tollPctText(v: string | number | null | undefined): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 'Not reported';
  const r = Number(n.toFixed(3));
  return `${Object.is(r, -0) ? 0 : r}%`;
}

/** The trade ticket's market: the current one while it is listed, else the first listed one (the one the select shows). */
export const ticketMarket = (current: string, listed: readonly string[]): string =>
  listed.length === 0 || listed.includes(current) ? current : listed[0];

/** Why a quote request is refused before it reaches the service, or null when it may go ahead. */
export function quoteRefusal(market: string, gear: Gear, amount: string, listed: readonly string[]): string | null {
  if (!listed.includes(market)) return 'This market is not listed on chain yet.';
  if (!isGearAllowed(market, gear)) return 'Choose an available gear for this market.';
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return 'Enter an amount greater than zero.';
  return null;
}

/** The review dialog's main button: Done closes once confirmed; it is disabled only while a wallet step is open. */
export function reviewButton(r: {kind: string} | null | undefined, flow: string | null | undefined): {done: boolean; disabled: boolean; action: 'close' | 'execute'} {
  const done = r?.kind === 'confirmed';
  return {done, disabled: !done && !!flow && !r, action: done ? 'close' : 'execute'};
}

// I5-2: nothing on chain 4663 pushes Pyth, and the guard needs a Pyth price younger than the market's refMaxAge. This job fetches
// signed updates from Hermes and calls Pyth.updatePriceFeeds with exactly getUpdateFee. It sends only when a feed is older than
// PYTH_PUSH_FRESH_PERCENT of its refMaxAge AND Hermes holds a newer print, never past the per-day budget, and stays idle
// (with a warning, never a crash) when no Hermes key is configured. After each pass it records, per market, whether the guard
// reads a reference (fresh Pyth, or a TWAP pool), for /v1/status and for a critical alert.
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { IODOracleGuardAbi } from "../../abi";
import { raiseAlert } from "../alerts";
import { readJobMeta, saveJobMeta, type CrankContext } from "../context";
import { contractAddress } from "../gears";
import { fetchLatestUpdates, isNotEntitled, type HermesUpdate } from "../hermes";

export const PYTH_PUSH_JOB = "pyth-push";
/** Failed Hermes passes in a row after which the alert is critical instead of a warning. */
export const HERMES_CRITICAL_AFTER = 3;
/**
 * A feed Hermes refused as "not entitled" (the key has no grant for it) is left out of later requests and probed again after
 * this long. Its warning is logged at most once per window. The guard falls back to the market's TWAP pool for such a feed.
 */
export const NOT_ENTITLED_RETRY_MS = 3_600_000;

export const PythAbi = parseAbi([
  "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))",
  "function getUpdateFee(bytes[] updateData) view returns (uint256)",
  "function updatePriceFeeds(bytes[] updateData) payable",
]);

const ZERO_ID = `0x${"0".repeat(64)}`;

export interface MarketReference {
  symbol: string;
  ok: boolean;
  source: "pyth" | "twap" | "none";
  /** Seconds since the Pyth print, null when the feed has none on chain. */
  pythAgeSeconds: number | null;
  refMaxAge: number | null;
  reason?: string;
}

export interface PythDeps {
  fetchUpdates?: (ids: readonly string[]) => Promise<HermesUpdate>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

export interface PythMarket { id: Hex; symbol: string; pythId: Hex; /** A gear on this market is in the deployment record. */ listed: boolean }

/**
 * Every market the job keeps fresh: each market of the deployment record (the deploy config's full market list) that has a Pyth
 * id, whether a gear on it is listed yet or still waits for the list-gears batch. A market without a TWAP pool (ETH, BTC) can
 * list only while Pyth is under its refMaxAge (else listGear reverts MarketNotReady), so a pending market must be pushed too.
 */
export const pythPushMarkets = (deployment: Pick<CrankContext, "deployment">["deployment"]): PythMarket[] =>
  deployment.markets.filter((m) => m.pythId && m.pythId.toLowerCase() !== ZERO_ID).map((m) => ({
    id: m.id, symbol: m.symbol, pythId: m.pythId as Hex,
    listed: deployment.gears.some((g) => g.marketA === m.symbol || g.marketB === m.symbol),
  }));

/** Per market: does the guard read a reference right now? Pure reads, used by the job and available to any health caller. */
export async function checkReferences(context: Pick<CrankContext, "clients" | "deployment" | "now" | "metadata">): Promise<MarketReference[]> {
  const guard = contractAddress(context, "ODOracleGuard");
  const pyth = context.deployment.external.pythCore as Address;
  const markets = context.deployment.markets;
  const state = context.clients.stateClient;
  const nowSeconds = Math.floor(context.now(await context.metadata()).getTime() / 1000);
  const rows = await state.multicall({
    allowFailure: true,
    contracts: markets.flatMap((m) => [
      { address: guard, abi: IODOracleGuardAbi, functionName: "refPrice", args: [m.id] },
      { address: guard, abi: IODOracleGuardAbi, functionName: "config", args: [m.id] },
      ...(m.pythId && m.pythId.toLowerCase() !== ZERO_ID ? [{ address: pyth, abi: PythAbi, functionName: "getPriceUnsafe", args: [m.pythId] }] : []),
    ]) as never,
  }) as { status: string; result?: unknown }[];
  const out: MarketReference[] = [];
  let at = 0;
  for (const m of markets) {
    const ref = rows[at++]!;
    const config = rows[at++]!;
    const hasPyth = !!m.pythId && m.pythId.toLowerCase() !== ZERO_ID;
    const price = hasPyth ? rows[at++]! : undefined;
    const refP = ref.status === "success" ? ((ref.result as readonly [bigint, boolean])[0] ?? 0n) : 0n;
    const fromPyth = ref.status === "success" ? Boolean((ref.result as readonly [bigint, boolean])[1]) : false;
    const refMaxAge = config.status === "success" ? Number((config.result as { refMaxAge: number | bigint }).refMaxAge) : null;
    const published = price?.status === "success" ? Number((price.result as { publishTime: bigint }).publishTime) : null;
    const pythAge = published && published > 0 ? Math.max(0, nowSeconds - published) : null;
    const ok = refP > 0n;
    const source: MarketReference["source"] = !ok ? "none" : fromPyth ? "pyth" : "twap";
    out.push({
      symbol: m.symbol, ok, source, pythAgeSeconds: pythAge, refMaxAge,
      ...(ok ? {} : { reason: hasPyth ? (price?.status !== "success" ? "pyth_feed_not_found" : "pyth_stale_and_no_twap") : "no_reference_configured" }),
    });
  }
  return out;
}

export function createPythPushJob(context: CrankContext, deps: PythDeps = {}) {
  const { config, logger } = context;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = deps.nowMs ?? Date.now;
  const fetchUpdates = deps.fetchUpdates ?? ((ids: readonly string[]) => fetchLatestUpdates(ids, {
    baseUrl: config.PYTH_HERMES_URL, apiKey: config.PYTH_HERMES_API_KEY, apiKeyHeader: config.PYTH_HERMES_AUTH_HEADER,
  }));
  const budgetWei = BigInt(Math.round(config.PYTH_PUSH_DAILY_BUDGET_ETH * 1e18));
  let day = "";
  let spentWei = 0n;
  let restored = false;
  let warnedAt = 0;
  let intervalChecked = false;
  let hermesFailures = 0; // passes in a row that could not get an update from Hermes
  const refusedAt = new Map<string, number>(); // lowercase Pyth id -> when Hermes last refused it as not entitled
  let refusedWarnedAt = -Infinity;

  // I6-3: the health read and its critical alert. Runs on every pass, also when the push could not run (no key) or
  // failed (Hermes refused the key, the fee read or the send failed): that is when a reference is about to go stale.
  const health = async (): Promise<MarketReference[]> => {
    const references = await checkReferences(context);
    for (const ref of references.filter((r) => !r.ok)) {
      await raiseAlert(context, {
        key: `pyth-ref:${ref.symbol}`, level: "critical",
        text: `Market ${ref.symbol} has no usable reference price (${ref.reason}). Buys, sells, fills and seals that need it are refused until it is fixed.`,
        meta: { ...ref },
      });
    }
    await saveJobMeta(context, PYTH_PUSH_JOB, {
      reference: { checkedAt: new Date(nowMs()).toISOString(), ok: references.every((r) => r.ok), markets: references },
      budget: { day, spentWei: spentWei.toString(), limitWei: budgetWei.toString() },
    });
    return references;
  };

  const retry = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await work(); } catch (error) {
        // a refused grant does not heal by retrying; the caller splits the request instead
        if (attempt >= config.PYTH_PUSH_MAX_RETRIES || isNotEntitled(error)) throw error;
        const wait = config.PYTH_PUSH_BACKOFF_MS * 2 ** attempt;
        logger.warn({ job: PYTH_PUSH_JOB, label, attempt: attempt + 1, waitMs: wait, err: error instanceof Error ? error.message : String(error) }, "Pyth push step failed; retrying");
        await sleep(wait);
      }
    }
  };

  const mergeUpdates = (parts: HermesUpdate[]): HermesUpdate => ({
    updateData: parts.flatMap((p) => p.updateData),
    publishTimes: new Map(parts.flatMap((p) => [...p.publishTimes])),
  });

  /**
   * One Hermes request for every id the key may read. When Hermes refuses it as not entitled (one refused feed fails the whole
   * request), each id is fetched alone: the refused ones are recorded and skipped, the others still come back and are pushed in
   * one update tx. Throws only when nothing could be fetched for a reason other than a refused grant (an outage, a refused key).
   */
  const fetchEntitled = async (ids: readonly Hex[]): Promise<{ update?: HermesUpdate; refused: string[] }> => {
    const now = nowMs();
    const tryIds = ids.filter((id) => now - (refusedAt.get(id.toLowerCase()) ?? -Infinity) >= NOT_ENTITLED_RETRY_MS);
    const refused = ids.filter((id) => !tryIds.includes(id)).map((id) => id.toLowerCase());
    if (!tryIds.length) return { refused };
    const refuse = (id: Hex) => { refusedAt.set(id.toLowerCase(), now); refused.push(id.toLowerCase()); };
    try {
      const update = await retry("hermes", () => fetchUpdates(tryIds));
      for (const id of tryIds) refusedAt.delete(id.toLowerCase());
      return { update, refused };
    } catch (error) {
      if (!isNotEntitled(error)) throw error;
      if (tryIds.length === 1) { refuse(tryIds[0]!); return { refused }; }
    }
    const parts: HermesUpdate[] = [];
    let failure: unknown;
    for (const id of tryIds) {
      try {
        parts.push(await retry("hermes", () => fetchUpdates([id])));
        refusedAt.delete(id.toLowerCase());
      } catch (error) {
        if (isNotEntitled(error)) refuse(id); else failure ??= error;
      }
    }
    if (!parts.length && failure) throw failure;
    if (failure) logger.warn({ job: PYTH_PUSH_JOB, err: failure instanceof Error ? failure.message : String(failure) }, "Hermes failed for some feeds; pushing the others");
    return parts.length ? { update: mergeUpdates(parts), refused } : { refused };
  };

  return async (): Promise<Record<string, unknown>> => {
    const markets = pythPushMarkets(context.deployment);
    if (!markets.length) return { idle: true, reason: "no_pyth_markets" };
    let pushed: Record<string, unknown> = { idle: true, reason: "fresh" };
    const skipped: string[] = [];
    let references: MarketReference[] = [];
    try {
      pushed = await pushPass(markets, skipped);
    } finally {
      // a failed push still rethrows after this (the run is reported failed); the alert below does not wait for it
      references = await health();
    }
    return { ...pushed, skipped, references: references.map((r) => `${r.symbol}:${r.ok ? r.source : "none"}`) };
  };

  async function pushPass(markets: PythMarket[], skipped: string[]): Promise<Record<string, unknown>> {
    if (!config.PYTH_HERMES_API_KEY) {
      if (nowMs() - warnedAt > 3_600_000) {
        warnedAt = nowMs();
        logger.warn({ job: PYTH_PUSH_JOB }, "PYTH_HERMES_API_KEY is not set: the Pyth push job pushes nothing and Pyth-referenced markets will go stale on chain");
      }
      return { idle: true, reason: "no_hermes_key" };
    }
    const guard = contractAddress(context, "ODOracleGuard");
    const pyth = context.deployment.external.pythCore as Address;
    const state = context.clients.stateClient;
    const nowSeconds = Math.floor(context.now(await context.metadata()).getTime() / 1000);
    const today = new Date(nowMs()).toISOString().slice(0, 10);
    if (!restored) {
      restored = true;
      const saved = (await readJobMeta(context, PYTH_PUSH_JOB)).budget as { day?: string; spentWei?: string } | undefined;
      if (saved?.day === today && saved.spentWei) spentWei = BigInt(saved.spentWei);
      day = today;
    }
    if (day !== today) { day = today; spentWei = 0n; }

    // 1. what is on chain, per market: refMaxAge from the guard, publishTime from Pyth
    const rows = await state.multicall({
      allowFailure: true,
      contracts: markets.flatMap((m) => [
        { address: guard, abi: IODOracleGuardAbi, functionName: "config", args: [m.id] },
        { address: pyth, abi: PythAbi, functionName: "getPriceUnsafe", args: [m.pythId] },
      ]) as never,
    }) as { status: string; result?: unknown }[];
    const stale: { market: PythMarket; published: number }[] = [];
    markets.forEach((market, i) => {
      const cfg = rows[i * 2]!;
      const price = rows[i * 2 + 1]!;
      if (cfg.status !== "success") { skipped.push(`${market.symbol}:no_config`); return; }
      const refMaxAge = Number((cfg.result as { refMaxAge: number | bigint }).refMaxAge);
      // a market the guard has no config for cannot list or trade; pushing it would only spend the budget every pass
      if (!(refMaxAge > 0)) { skipped.push(`${market.symbol}:not_on_guard`); return; }
      const published = price.status === "success" ? Number((price.result as { publishTime: bigint }).publishTime) : 0;
      if (!intervalChecked && config.PYTH_PUSH_INTERVAL_SECONDS >= refMaxAge) {
        logger.warn({ job: PYTH_PUSH_JOB, symbol: market.symbol, refMaxAge, interval: config.PYTH_PUSH_INTERVAL_SECONDS }, "PYTH_PUSH_INTERVAL_SECONDS is not below this market's refMaxAge; its price can expire between pushes");
      }
      const age = nowSeconds - published;
      if (published > 0 && age * 100 <= refMaxAge * config.PYTH_PUSH_FRESH_PERCENT) return;
      stale.push({ market, published });
    });
    intervalChecked = true;

    return stale.length ? pushOnce(stale) : { idle: true, reason: "fresh" };

    async function pushOnce(wanted: { market: PythMarket; published: number }[]): Promise<Record<string, unknown>> {
      const ids = wanted.map((w) => w.market.pythId);
      const fetched = await fetchEntitled(ids).catch(async (error) => {
        // one failed pass is a warning; HERMES_CRITICAL_AFTER in a row (a refused key does not heal) is critical
        hermesFailures++;
        const level = hermesFailures >= HERMES_CRITICAL_AFTER ? "critical" : "warn";
        await raiseAlert(context, { key: `pyth-push:hermes:${level}`, level, text: `The Pyth push job cannot get prices from Hermes (${hermesFailures} passes in a row): ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      });
      hermesFailures = 0;
      const refusedSymbols = wanted.filter((w) => fetched.refused.includes(w.market.pythId.toLowerCase())).map((w) => w.market.symbol);
      for (const symbol of refusedSymbols) skipped.push(`${symbol}:not_entitled`);
      if (refusedSymbols.length && nowMs() - refusedWarnedAt >= NOT_ENTITLED_RETRY_MS) {
        refusedWarnedAt = nowMs();
        logger.warn({ job: PYTH_PUSH_JOB, symbols: refusedSymbols }, "Hermes refuses these feeds for this key (not entitled); skipping them, the guard uses the TWAP pool reference where one is set");
      }
      if (!fetched.update) return { idle: true, reason: "not_entitled", notEntitled: refusedSymbols };
      const update = fetched.update;
      wanted = wanted.filter((w) => !fetched.refused.includes(w.market.pythId.toLowerCase()));
      const unknown = wanted.filter((w) => !update.publishTimes.has(w.market.pythId.toLowerCase())).map((w) => w.market.symbol);
      if (unknown.length) {
        logger.warn({ job: PYTH_PUSH_JOB, symbols: unknown }, "Hermes does not know these Pyth ids; check the id in the deployment config");
        await raiseAlert(context, { key: `pyth-push:unknown:${unknown.join(",")}`, level: "warn", text: `Hermes does not know the Pyth id of ${unknown.join(", ")}.` });
      }
      const newer = wanted.filter((w) => (update.publishTimes.get(w.market.pythId.toLowerCase()) ?? 0) > w.published);
      if (!newer.length) return { idle: true, reason: "no_newer_print", unknown, notEntitled: refusedSymbols };
      const fee = await retry("fee", () => state.readContract({ address: pyth, abi: PythAbi, functionName: "getUpdateFee", args: [update.updateData] }) as Promise<bigint>);
      if (spentWei + fee > budgetWei) {
        await raiseAlert(context, {
          key: "pyth-push:budget", level: "critical",
          text: `The Pyth push job reached its daily budget (${spentWei} of ${budgetWei} wei spent). Prices will go stale until tomorrow or PYTH_PUSH_DAILY_BUDGET_ETH is raised.`,
        });
        return { idle: true, reason: "budget_exhausted", spentWei: spentWei.toString() };
      }
      const result = await context.tx.submit({
        label: `${PYTH_PUSH_JOB}:${newer.map((n) => n.market.symbol).join("+")}`, to: pyth, value: fee,
        data: encodeFunctionData({ abi: PythAbi, functionName: "updatePriceFeeds", args: [update.updateData] }),
      });
      if (!result.simulated) {
        const receipt = result.receipt as { effectiveGasPrice?: bigint } | undefined;
        spentWei += fee + (result.gasUsed ?? 0n) * (receipt?.effectiveGasPrice ?? 0n);
      }
      logger.info({ job: PYTH_PUSH_JOB, symbols: newer.map((n) => n.market.symbol), feeWei: fee.toString(), spentTodayWei: spentWei.toString(), dryRun: result.simulated }, "Pyth prices pushed");
      const pending = newer.filter((n) => !n.market.listed).map((n) => n.market.symbol);
      return { idle: false, pushed: newer.map((n) => n.market.symbol), pending, feeWei: fee.toString(), dryRun: result.simulated, unknown, notEntitled: refusedSymbols };
    }
  }
}

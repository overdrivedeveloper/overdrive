// One read, polled. Framework-free so the hooks stay thin and the rules are unit tested (tests/poller.test.ts):
// abort on stop, a late answer never paints, the last good data stays on a failed refresh, a non-retryable error stops
// polling, retryAfterMs is honoured, and nothing polls faster than the API cache (GET /v1/compat/* is max-age=5).
import type {ServiceError} from './contract';
import {ServiceFailure} from './overdrive';

/** The compat GETs answer `Cache-Control: public, max-age=5`, so a faster poll only re-reads the cache. */
export const MIN_POLL_MS = 5_000;
/** Poll intervals: prices and accounts move per block, the catalog and the Governor book move slowly. */
export const POLL = {marketList: 60_000, gearSnapshot: 15_000, governor: 30_000, positions: 15_000, vaults: 15_000, tradeStatus: 5_000} as const;
/** A transaction status that will not change again: polling stops. */
export const TERMINAL: ReadonlySet<string> = new Set(['confirmed', 'failed', 'replaced']);

export type LiveState<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: T | null;
  error: ServiceError | null;
  /** True while a refresh is in flight and earlier data is still shown. */
  refreshing: boolean;
};
export const IDLE: LiveState<never> = {status: 'idle', data: null, error: null, refreshing: false};

type Timers = {set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void};
const realTimers: Timers = {set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)};

export type PollerOptions<T> = {
  load: (signal: AbortSignal) => Promise<T>;
  intervalMs: number;
  onChange: (s: LiveState<T>) => void;
  /** Stop polling once the answer is final (a confirmed or failed transaction). */
  isDone?: (data: T) => boolean;
  timers?: Timers;
};

export const asServiceError = (e: unknown): ServiceError =>
  e instanceof ServiceFailure ? e.error : {code: 'SERVICE_UNAVAILABLE', message: 'The service could not be reached.', retryable: true};

export function createPoller<T>(o: PollerOptions<T>) {
  const timers = o.timers ?? realTimers;
  const interval = Math.max(MIN_POLL_MS, o.intervalMs);
  let state: LiveState<T> = {status: 'idle', data: null, error: null, refreshing: false};
  let version = 0;
  let controller: AbortController | null = null;
  let timer: unknown = null;
  let running = false;
  const emit = (next: LiveState<T>) => { state = next; o.onChange(next); };
  const schedule = (ms: number) => { if (running) timer = timers.set(tick, Math.max(interval, ms)); };

  async function tick() {
    timer = null;
    const mine = ++version;
    controller?.abort();
    const c = new AbortController(); controller = c;
    emit(state.data === null ? {...state, status: 'loading', refreshing: false} : {...state, refreshing: true});
    try {
      const data = await o.load(c.signal);
      if (!running || mine !== version) return;
      emit({status: 'ready', data, error: null, refreshing: false});
      if (!o.isDone?.(data)) schedule(interval);
    } catch (e) {
      if (!running || mine !== version || (e as {name?: string})?.name === 'AbortError') return;
      const error = asServiceError(e);
      emit({status: 'error', data: state.data, error, refreshing: false});
      if (error.retryable) schedule(error.retryAfterMs ?? interval);
    }
  }

  return {
    start() { if (running) return; running = true; void tick(); },
    stop() { running = false; version += 1; controller?.abort(); controller = null; if (timer !== null) timers.clear(timer); timer = null; },
    /** A manual retry: runs now and resets the schedule. */
    refresh() { if (!running) return; if (timer !== null) timers.clear(timer); timer = null; void tick(); },
    get state() { return state; },
    interval,
  };
}

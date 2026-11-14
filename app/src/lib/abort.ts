/**
 * Run `fn` once when `signal` aborts, INCLUDING when it has already aborted. A bare
 * `signal.addEventListener("abort", fn)` never fires for a signal that aborted before the call, which made the
 * hedger sleep a full cycle after SIGTERM (2026-11-14). Use this for every stop path.
 */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): void {
  if (!signal) return;
  if (signal.aborted) { fn(); return; }
  signal.addEventListener("abort", fn, { once: true });
}

/** Sleep `ms`, waking early (never late) on abort, including an abort that already happened. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    onAbort(signal, () => { clearTimeout(t); resolve(); });
  });
}

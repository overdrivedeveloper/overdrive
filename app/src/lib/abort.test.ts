import { describe, expect, test } from "bun:test";
import { onAbort, sleepUnlessAborted } from "./abort";

describe("abort helpers", () => {
  test("onAbort_fires_for_a_signal_that_already_aborted", () => {
    const c = new AbortController(); c.abort(); let n = 0;
    onAbort(c.signal, () => { n++; });
    expect(n).toBe(1);
  });
  test("onAbort_fires_once_on_a_later_abort", () => {
    const c = new AbortController(); let n = 0;
    onAbort(c.signal, () => { n++; }); c.abort(); c.abort();
    expect(n).toBe(1);
  });
  test("sleep_returns_at_once_when_already_aborted", async () => {
    const c = new AbortController(); c.abort(); const t0 = Date.now();
    await sleepUnlessAborted(60_000, c.signal);
    expect(Date.now() - t0).toBeLessThan(100);
  });
  test("sleep_wakes_early_on_abort", async () => {
    const c = new AbortController(); const t0 = Date.now();
    setTimeout(() => c.abort(), 20);
    await sleepUnlessAborted(60_000, c.signal);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

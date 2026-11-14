interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheOptions {
  /** Most entries kept at once (least recently used goes first). Default 10,000. */
  maxEntries?: number;
  now?: () => number;
}

export interface LoadOptions<T> {
  /** Cache the loaded value only when this says so (routes keyed by a client-chosen address or hash pass one that refuses
   * empty and not-found answers, so a stranger cannot fill the cache with misses). Default: always cache. */
  keep?: (value: T) => boolean;
}

/**
 * Small in-process cache with single-flight loading. Bounded (security review M2): routes now key it by client-chosen
 * addresses and hashes, so it evicts the least recently used entry past `maxEntries` and sweeps expired entries as it
 * goes; a flood of distinct keys can never hold more than `maxEntries` values.
 */
export class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(options: CacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 10_000));
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>, options: LoadOptions<T> = {}): Promise<T> {
    const now = this.now();
    const cached = this.entries.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > now) {
      // Least recently used order: a hit moves the entry to the end.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value;
    }
    if (cached) this.entries.delete(key);

    const running = this.inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;

    const pending = load()
      .then((value) => {
        if (!options.keep || options.keep(value)) this.store(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private store(key: string, value: unknown, ttlMs: number): void {
    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + Math.max(0, ttlMs) });
    // Amortised sweep of expired entries (at most once a second), then evict the least recently used past the cap.
    if (now - this.lastSweep >= 1_000 || this.entries.size > this.maxEntries) this.sweep(now);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drops every expired entry. */
  sweep(now = this.now()): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    this.lastSweep = now;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}

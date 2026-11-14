import { expect, test } from "bun:test";
import { TtlCache } from "./cache";

test("M2: 1e6 distinct keys never hold more than maxEntries", async () => {
  let clock = 0;
  const cache = new TtlCache({ maxEntries: 1_000, now: () => clock });
  for (let i = 0; i < 1_000_000; i++) {
    await cache.getOrLoad(`k${i}`, 60_000, async () => i);
    if (i % 1_000 === 0) clock += 1;
    if (cache.size > 1_000) throw new Error(`size ${cache.size} at ${i}`);
  }
  expect(cache.size).toBeLessThanOrEqual(1_000);
}, 120_000);

test("M2: after the TTL a sweep leaves no expired entry", async () => {
  let clock = 0;
  const cache = new TtlCache({ maxEntries: 10_000, now: () => clock });
  for (let i = 0; i < 5_000; i++) await cache.getOrLoad(`k${i}`, 100, async () => i);
  clock += 101;
  cache.sweep();
  expect(cache.size).toBe(0);
});

test("least recently used goes first; a hit keeps an entry", async () => {
  const cache = new TtlCache({ maxEntries: 2 });
  await cache.getOrLoad("a", 60_000, async () => 1);
  await cache.getOrLoad("b", 60_000, async () => 2);
  expect(await cache.getOrLoad("a", 60_000, async () => 99)).toBe(1); // hit: a is now the newest
  await cache.getOrLoad("c", 60_000, async () => 3); // evicts b
  expect(await cache.getOrLoad("b", 60_000, async () => 20)).toBe(20);
  expect(cache.size).toBe(2);
});

test("keep() refuses to cache empty or not-found answers; loads stay single-flight", async () => {
  const cache = new TtlCache();
  let loads = 0;
  const load = async () => { loads++; return [] as number[]; };
  const keep = (value: number[]) => value.length > 0;
  await Promise.all([cache.getOrLoad("x", 60_000, load, { keep }), cache.getOrLoad("x", 60_000, load, { keep })]);
  expect(loads).toBe(1);
  await cache.getOrLoad("x", 60_000, load, { keep });
  expect(loads).toBe(2);
  expect(cache.size).toBe(0);
});

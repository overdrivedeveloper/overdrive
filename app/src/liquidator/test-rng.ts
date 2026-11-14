// Seeded random numbers for the liquidator tests and fuzz (mulberry32), so a failing case can be replayed from its seed.
export function rng(seed: number): { int(max: number): number; big(max: bigint): bigint; pick<T>(xs: readonly T[]): T } {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (max) => Math.floor(next() * max),
    big: (max) => {
      let v = 0n;
      for (let i = 0; i < 4; i++) v = (v << 32n) + BigInt(Math.floor(next() * 4294967296));
      return max <= 0n ? 0n : v % max;
    },
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
  };
}

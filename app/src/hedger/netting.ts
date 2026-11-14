// Pure netting maths in human units. A gear of power p on underlying S holds value V = V0 (S/S0)^p, so
//   delta = dV/dlnS = p V                  gamma = S^2 d2V/dS2 = p (p - 1) V
// A pair gear (A/B)^p adds delta +pV on A and -pV on B, diagonal gamma p(p-1)V on A and p(p+1)V on B, and a cross term
// A B d2V/dAdB = -p^2 V that is reported per pair but never netted across underlyings.
// One risk book per underlying nets every gear before anything trades; only the delta residual is hedged.
import type { GearBook, UnderlyingExposure } from "./types";

/** Index value of a gear after the underlyings moved by `ratioA` (and `ratioB` for a pair), from value V0. */
export function gearValueAfterMove(valueUsd: number, power: number, ratioA: number, ratioB = 1): number {
  return valueUsd * Math.pow(ratioA, power) * Math.pow(ratioB, -power);
}

function entry(map: Map<string, UnderlyingExposure>, underlying: string): UnderlyingExposure {
  let e = map.get(underlying);
  if (!e) {
    e = { underlying, deltaUsd: 0, gammaUsd: 0, cross: {}, byGear: {} };
    map.set(underlying, e);
  }
  return e;
}

function add(e: UnderlyingExposure, gear: string, delta: number, gamma: number): void {
  e.deltaUsd += delta;
  e.gammaUsd += gamma;
  const g = (e.byGear[gear] ??= { delta: 0, gamma: 0 });
  g.delta += delta;
  g.gamma += gamma;
}

/**
 * Exposure per underlying. `marks` holds, per underlying, the price now over the price the book's values were taken at
 * (missing = 1), so a stale book can be moved to the current mark without re-reading it.
 */
export function exposureFromGears(gears: readonly GearBook[], marks: ReadonlyMap<string, number>): Map<string, UnderlyingExposure> {
  const out = new Map<string, UnderlyingExposure>();
  for (const g of gears) {
    const p = g.power;
    const v = gearValueAfterMove(g.valueUsd, p, marks.get(g.marketA) ?? 1, g.marketB ? (marks.get(g.marketB) ?? 1) : 1);
    add(entry(out, g.marketA), g.gear, p * v, p * (p - 1) * v);
    if (g.marketB) {
      add(entry(out, g.marketB), g.gear, -p * v, p * (p + 1) * v);
      const cross = -p * p * v;
      const a = entry(out, g.marketA);
      const b = entry(out, g.marketB);
      a.cross[g.marketB] = (a.cross[g.marketB] ?? 0) + cross;
      b.cross[g.marketA] = (b.cross[g.marketA] ?? 0) + cross;
    }
  }
  return out;
}

/** Nets gears that all sit on one underlying (single-name gears only; pairs go through exposureFromGears). */
export function netAcrossGears(g: readonly GearBook[]): { deltaUsd: number; gammaUsd: number; byGear: Record<string, { delta: number; gamma: number }> } {
  const byGear: Record<string, { delta: number; gamma: number }> = {};
  let deltaUsd = 0;
  let gammaUsd = 0;
  for (const gear of g) {
    if (gear.marketB) throw new Error(`netAcrossGears: ${gear.gear} is a pair; use exposureFromGears`);
    const delta = gear.power * gear.valueUsd;
    const gamma = gear.power * (gear.power - 1) * gear.valueUsd;
    const row = (byGear[gear.gear] ??= { delta: 0, gamma: 0 });
    row.delta += delta;
    row.gamma += gamma;
    deltaUsd += delta;
    gammaUsd += gamma;
  }
  return { deltaUsd, gammaUsd, byGear };
}

/** The hedge target is the delta only: convexity cannot be hedged with a linear venue (it is budgeted, R5). */
export const hedgeTargetUsd = (e: Pick<UnderlyingExposure, "deltaUsd">): number => e.deltaUsd;

/** R5: P&L of the gamma book for a 1% move, 0.5 G (0.01)^2, in the gamma's units. */
export const gammaPnl1pct = (gammaUsd: number): number => 0.5 * gammaUsd * 0.01 * 0.01;

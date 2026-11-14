// The venue port and the factory for the venues named in HEDGER_VENUES. Real adapters (Arcus, Hyperliquid) plug in here;
// until they exist only `mock` builds, and a requested venue that cannot be built refuses to start.
import type { IHedgeVenue, VenueName } from "../types";
import { MockVenue } from "./mock-venue";

export type { IHedgeVenue, VenueFill, VenueName } from "../types";

export const VENUE_NAMES = ["arcus", "hyperliquid", "mock"] as const satisfies readonly VenueName[];

export type VenueBuilder = (name: VenueName) => IHedgeVenue;

/** The boot-time mock: lists every underlying at a flat mark of 100 USD, trades 24/7. */
export const defaultMockVenue = (underlyings: readonly string[]): MockVenue =>
  new MockVenue({ name: "mock", marks: Object.fromEntries(underlyings.map((u) => [u, 100n * 10n ** 18n])), alwaysOpen: true });

export function buildVenues(names: readonly VenueName[], builders: Partial<Record<VenueName, () => IHedgeVenue>>): IHedgeVenue[] {
  return names.map((name) => {
    const build = builders[name];
    if (!build) throw new Error(`Venue ${name} is not available in this build`);
    return build();
  });
}

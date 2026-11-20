import { describe, expect, test } from "bun:test";
import { modeOf } from "./status";

// The site says hedging is active only when the hedger reports live mode; this is the field it reads.
describe("/v1/status service mode", () => {
  test("the hedger's stored dryRun flag becomes the mode", () => {
    expect(modeOf({ dryRun: true, venues: ["venue-a"] })).toBe("dry_run");
    expect(modeOf({ dryRun: false })).toBe("live");
  });
  test("a job without the flag, or with a malformed one, has no mode", () => {
    expect(modeOf({})).toBeNull();
    expect(modeOf(null)).toBeNull();
    expect(modeOf({ dryRun: "false" })).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { runHedgeCycle } from "../service";
import { makeDeps, market, USD } from "../test-support";
import { ArcusVenue, createLiveArcusPort, MockArcusPort } from "./arcus";

const PX = (n: number) => BigInt(n) * 10n ** 18n;

describe("arcus venue", () => {
  test("trades_via_port_and_reads_chain_equity", async () => {
    const port = new MockArcusPort({ TSLA: PX(400) }, USD(500_000));
    const venue = new ArcusVenue(port);
    expect(venue.postsEquity).toBe(false);
    const { deps, gov } = makeDeps({ markets: [market("TSLA")], venues: [venue], settings: { maxVenueMarginUsd: USD(1_000_000) } });
    deps.requestMargin = async (_v, usd) => venue.deposit(usd);
    gov.delta.set("TSLA", USD(-200_000)); // holders net short (Reverse): the Governor holds a short
    const r = await runHedgeCycle(deps);
    expect(r.names.TSLA!.action).toBe("traded");
    expect(port.orders).toHaveLength(1);
    expect(port.orders[0]!.filledUsd).toBe(USD(-200_000));
    expect(port.orders[0]!.limitPx).toBe((PX(400) * 9_900n) / 10_000n); // sell limit at the slippage bound
    expect(await venue.netPositionUsd("TSLA")).toBe(USD(-200_000));
    expect(await venue.marginEquityUsd()).toBe(USD(500_000));
    expect(port.reads.position).toBeGreaterThan(0);
    expect(port.reads.equity).toBeGreaterThan(0);
    // a closed session: Arcus never trades, the name holds with no venue
    port.open = false;
    gov.delta.set("TSLA", USD(-400_000));
    deps.state.lastTradeMs.clear();
    const closed = await runHedgeCycle(deps);
    expect(closed.names.TSLA!.reason).toBe("no_venue");
    expect(port.orders).toHaveLength(1);
  });

  test("live_port_refuses_without_credentials", () => {
    expect(() => createLiveArcusPort({ network: "mainnet", account: "", accountIndex: 0, dryRun: true })).toThrow("Arcus credentials missing");
    expect(() => createLiveArcusPort({ network: "mainnet", account: "0x00000000000000000000000000000000000a4c05", accountIndex: 0, dryRun: false })).toThrow("Arcus credentials missing");
  });
});

// ORACLE-SRC: the Hermes client against LIVE Hermes answers recorded for TSLA with the market open and closed
// (contracts/test/fixtures/oracle-sources/TSLA.json, .github/scripts/record-oracle-fixtures.sh). The stub replays the recorded
// status and body for the URL it was recorded under and answers 404 for any other id, like Hermes; it never returns the
// open item for any URL.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchLatestUpdates, HermesError } from "./hermes";

interface Recorded { status: number; body: unknown }
const fx = JSON.parse(readFileSync(join(import.meta.dir, "../../../contracts/test/fixtures/oracle-sources/TSLA.json"), "utf8")) as {
  pythId: string; open: { hermes: Recorded }; closed: { hermes: Recorded }; hermesUnknownId: { id: string } & Recorded;
};

/** Hermes as recorded: `latest` answers the open recording for the TSLA id, the recorded 404 for any unknown id. */
function liveLikeHermes(latest: Recorded): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const ids = url.searchParams.getAll("ids[]");
    const answer = url.pathname === "/v2/updates/price/latest" && ids.length === 1 && ids[0] === fx.pythId.toLowerCase() ? latest : fx.hermesUnknownId;
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status });
  }) as typeof fetch;
}

const opts = (latest: Recorded) => ({ baseUrl: "https://hermes.example", apiKey: "", apiKeyHeader: "x-api-key", fetch: liveLikeHermes(latest) });

describe("hermes client on recorded live answers", () => {
  test("market open: the recorded update is parsed with its publish time", async () => {
    expect(fx.open.hermes.status).toBe(200);
    const u = await fetchLatestUpdates([fx.pythId], opts(fx.open.hermes));
    expect(u.updateData).toHaveLength(1);
    expect(u.updateData[0]).toMatch(/^0x504e4155/); // "PNAU", the Pyth accumulator update magic
    const parsed = (fx.open.hermes.body as { parsed: { price: { publish_time: number } }[] }).parsed[0];
    expect(u.publishTimes.get(fx.pythId.toLowerCase())).toBe(parsed?.price.publish_time);
    expect(parsed?.price.publish_time).toBeGreaterThan(0);
  });

  test("market closed: Hermes had no update (recorded 404), the client throws with the status, never a price", async () => {
    expect(fx.closed.hermes.status).toBe(404);
    const err = await fetchLatestUpdates([fx.pythId], opts(fx.closed.hermes)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HermesError);
    expect((err as HermesError).status).toBe(404);
  });

  test("an unknown id gets Hermes' recorded 404, not the open item", async () => {
    expect(fx.hermesUnknownId.status).toBe(404);
    const err = await fetchLatestUpdates([fx.hermesUnknownId.id], opts(fx.open.hermes)).catch((e: unknown) => e);
    expect((err as HermesError).status).toBe(404);
  });
});

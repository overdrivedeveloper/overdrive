import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { parseDeployment } from "./deployments";
import { watchedAddresses } from "../indexer/events";
import { createApiChain } from "../api/chain-reads";

const FIXTURE = join(import.meta.dir, "..", "testing", "fixtures", "deployment.fork.json");

/** A phase 1 record (system deployed before the $OVRD token): every contract set except ODStake, which is "". */
function phaseOne(network = "fork"): any {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.network = network;
  raw.contracts.ODStake = "";
  return raw;
}

describe("deployment record without ODStake (two-phase deploy)", () => {
  test("parses on a fork and on mainnet", () => {
    expect(parseDeployment(phaseOne()).contracts.ODStake).toBe("");
    const m = phaseOne("mainnet");
    m.chainId = 4663;
    expect(parseDeployment(m).contracts.ODStake).toBe("");
  });
  test("any other empty contract is still refused off anvil", () => {
    const raw = phaseOne();
    raw.contracts.ODMinter = "";
    expect(() => parseDeployment(raw)).toThrow("contracts.ODMinter is empty");
  });
  test("the indexer watches no empty address", () => {
    const d = parseDeployment(phaseOne());
    const { own } = watchedAddresses(d);
    expect(own).not.toContain("");
    expect(own.length).toBeGreaterThan(5);
  });
  test("stake reads fail cleanly without touching the RPC", async () => {
    let calls = 0;
    const client = new Proxy({}, { get: () => () => { calls++; throw new Error("rpc"); } }) as unknown as PublicClient;
    const chain = createApiChain(client, parseDeployment(phaseOne()));
    await expect(chain.stakeAccount!("0x0000000000000000000000000000000000000001")).rejects.toThrow("ODStake is not deployed yet");
    expect(calls).toBe(0);
  });
});

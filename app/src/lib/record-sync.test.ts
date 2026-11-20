import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { parseDeployment, type Deployment } from "./deployments";
import { recordDrift, symbolOfMarket, syncRecord, type RecordChain } from "./record-sync";

const ETH = `0x${Buffer.from("ETH").toString("hex").padEnd(64, "0")}` as Hex;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const ZERO20 = `0x${"0".repeat(40)}`;
const WAD = 10n ** 18n;
const ids = [1, 2].map((n) => `0x${n.toString(16).padStart(64, "0")}` as Hex);
const tokens = ["0x71fDdca41E6943bD28bdd94f05C9f3f506EA31b2", "0x62D20B0b2d411B359F2511542D297aAa3Cc9269B"];

/** The shape of testnet 46630 after batch 1: a record with every contract and no markets or gears. */
function emptyRecord(): Deployment {
  const anvil = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "deployments", "anvil.json"), "utf8")) as Deployment;
  const contracts = Object.fromEntries(Object.keys(anvil.contracts).map((k, i) => [k, getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`)]));
  return parseDeployment({ ...anvil, chainId: 46630, network: "testnet", contracts, markets: [], gears: [] });
}

const chain: RecordChain = {
  gearCount: async () => 2n,
  gearIdAt: async (i) => ids[Number(i)]!,
  gear: async (id) => ({ marketA: ETH, marketB: ZERO32, gear: id === ids[0] ? 1 : 4, token: tokens[ids.indexOf(id)]!, unitWad: WAD, capUsdWad: 100_000n * WAD, spreadBps: 40 }),
  tokenSymbol: async (t) => (t === tokens[0] ? "ETH-SPORT" : "ETH-REV"),
  poolIdOf: async (id) => `0x${"ab".repeat(31)}${id.slice(-2)}` as Hex,
  marketConfig: async () => ({ feed: "0x280401FCa51CeE1B5B64611A397375E3Ab0cAc20", stockToken: ZERO20, multiplierEmbedded: true, alwaysOpen: true, pythId: `0x${"ff".repeat(32)}` as Hex, twapPool: ZERO20 }),
};

test("a record without the listed gears fails the check, names each one, and the synced record passes it", async () => {
  const record = emptyRecord();
  const synced = await syncRecord(record, chain);
  const drift = recordDrift(record, synced);
  expect(drift).toEqual([
    `gear ETH-SPORT (${ids[0]}) is on chain but missing from the record`,
    `gear ETH-REV (${ids[1]}) is on chain but missing from the record`,
    `market ETH (${ETH}) is on chain but missing from the record`,
  ]);
  expect(recordDrift(synced, await syncRecord(synced, chain))).toEqual([]);
  expect(synced.markets).toEqual([{ id: ETH, symbol: "ETH", kind: "crypto", feed: "0x280401FCa51CeE1B5B64611A397375E3Ab0cAc20", stockToken: null, multiplierEmbedded: true, pythId: `0x${"ff".repeat(32)}`, twapPool: null, alwaysOpen: true }]);
  expect(synced.gears[1]).toEqual({ id: ids[1]!, symbol: "ETH-REV", gear: "REVERSE", power: "-1", marketA: "ETH", marketB: null, token: tokens[1] as Hex, poolId: `0x${"ab".repeat(31)}02` as Hex, capUsd: "100000", spreadBps: 40, unitUsd: "1" });
});

test("a changed cap and a gear the chain does not list are drift too", async () => {
  const synced = await syncRecord(emptyRecord(), chain);
  const edited: Deployment = { ...synced, gears: [{ ...synced.gears[0]!, capUsd: "5" }, synced.gears[1]!, { ...synced.gears[1]!, id: `0x${"09".repeat(32)}` as Hex, symbol: "ETH-RACE" }] };
  expect(recordDrift(edited, synced)).toEqual([`gear ETH-SPORT (${ids[0]}) differs from the chain`, `gear ETH-RACE (0x${"09".repeat(32)}) is in the record but not listed on chain`]);
});

test("a market a listed gear uses but the oracle has no config for refuses; ids must be ASCII symbols", async () => {
  await expect(syncRecord(emptyRecord(), { ...chain, marketConfig: async () => ({ feed: ZERO20, stockToken: ZERO20, multiplierEmbedded: false, alwaysOpen: false, pythId: ZERO32, twapPool: ZERO20 }) })).rejects.toThrow("no oracle config");
  expect(symbolOfMarket(ETH)).toBe("ETH");
  expect(() => symbolOfMarket(`0x${"ff".repeat(32)}`)).toThrow("not an ASCII symbol");
});

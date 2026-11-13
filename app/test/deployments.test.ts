import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployment, parseDeployment } from "../src/lib/deployments";

const anvil = () => JSON.parse(readFileSync(join(import.meta.dir, "..", "deployments", "anvil.json"), "utf8"));

// Expected mainnet externals, copied once from docs/research/chain-facts.md (VERIFIED rows, 2026-11-13).
const CHAIN_FACTS = {
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
  v4Quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
  pythCore: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
};

describe("deployments", () => {
  test("validAnvilFileLoads", () => {
    const d = loadDeployment(31337);
    expect(d.network).toBe("anvil");
    expect(d.admin.minDelaySec).toBe(172800);
  });

  test("rejectsUnknownKey", () => {
    const a = anvil();
    a.surprise = 1;
    expect(() => parseDeployment(a)).toThrow(/schema violation/);
    const b = anvil();
    b.external.extra = "0x0000000000000000000000000000000000000000";
    expect(() => parseDeployment(b)).toThrow(/schema violation/);
  });

  test("rejectsBadChecksum", () => {
    const a = anvil();
    a.external.usdg = a.external.usdg.toLowerCase();
    expect(() => parseDeployment(a)).toThrow(/checksummed/);
  });

  test("rejectsEmptyContractOutsideAnvil", () => {
    const a = anvil();
    a.network = "mainnet";
    a.chainId = 4663;
    expect(() => parseDeployment(a)).toThrow(/is empty on network mainnet/);
    a.network = "anvil";
    expect(() => parseDeployment(a)).not.toThrow();
  });

  test("mainnetExternalMatchesChainFacts", () => {
    const a = anvil();
    a.network = "mainnet";
    a.chainId = 4663;
    for (const k of Object.keys(a.contracts)) a.contracts[k] = "0x0000000000000000000000000000000000000001";
    const dir = mkdtempSync(join(tmpdir(), "od-dep-"));
    writeFileSync(join(dir, "mainnet.json"), JSON.stringify(a));
    const d = loadDeployment(4663, dir);
    for (const [k, v] of Object.entries(CHAIN_FACTS)) {
      expect(d.external[k as keyof typeof CHAIN_FACTS] as string).toBe(v);
    }
  });

  test("rejectsWrongChainFile", () => {
    const a = anvil();
    const dir = mkdtempSync(join(tmpdir(), "od-dep-"));
    writeFileSync(join(dir, "mainnet.json"), JSON.stringify(a)); // chainId 31337 inside a mainnet file
    expect(() => loadDeployment(4663, dir)).toThrow(/not 4663/);
  });
});

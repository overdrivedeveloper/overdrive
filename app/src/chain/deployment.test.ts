import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../config";
import { assertDeploymentNetwork, assertNodeIdentity, DeploymentError, loadDeploymentFile } from "./deployment";

const FIXTURE = join(import.meta.dir, "..", "testing", "fixtures", "deployment.fork.json");
const env = { DATABASE_URL: "postgres://localhost/x", DEPLOYMENT_FILE: FIXTURE };

describe("deployment wrapper", () => {
  test("loads the fork fixture through the shared parser", () => {
    const d = loadDeploymentFile(loadConfig(env));
    expect(d.chainId).toBe(31337);
    expect(d.gears.length).toBe(0); // 64-hex gear ids would trip the key guard in a committed file; tests build them in code
  });
  test("refuses a deployment for another network or chain", () => {
    expect(() => loadDeploymentFile(loadConfig({ ...env, NETWORK: "mainnet" }))).toThrow(DeploymentError);
    expect(() => assertDeploymentNetwork({ chainId: 4663, network: "mainnet" }, { NETWORK: "fork", CHAIN_ID: 31337 })).toThrow("is for chain");
    expect(() => assertDeploymentNetwork({ chainId: 31337, network: "mainnet" }, { NETWORK: "fork", CHAIN_ID: 31337 })).toThrow("cannot run");
    expect(() => loadDeploymentFile({ NETWORK: "fork", CHAIN_ID: 31337, DEPLOYMENT_FILE: "/nonexistent.json" })).toThrow("cannot read");
  });
  test("node identity: chain id must match and a fork must be anvil", async () => {
    const config = { NETWORK: "fork", CHAIN_ID: 31337 } as const;
    await assertNodeIdentity({ chainId: async () => 31337, clientVersion: async () => "anvil/v1.0" }, config);
    await expect(assertNodeIdentity({ chainId: async () => 4663, clientVersion: async () => "anvil" }, config)).rejects.toThrow("expected CHAIN_ID");
    await expect(assertNodeIdentity({ chainId: async () => 31337, clientVersion: async () => "nitro/v3" }, config)).rejects.toThrow("anvil");
    await assertNodeIdentity({ chainId: async () => 4663, clientVersion: async () => "nitro" }, { NETWORK: "mainnet", CHAIN_ID: 4663 });
  });
});

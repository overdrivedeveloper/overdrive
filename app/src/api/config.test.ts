import { afterAll, expect, test } from "bun:test";
import { assertDeploymentNetwork, DeploymentError } from "../chain/deployment";
import { loadDeployment } from "../lib/deployments";
import { harness } from "./test-support";

const h = await harness("config");
afterAll(async () => { await h?.close(); });

test("addresses_equal_deployment_file", async () => {
  if (!h) return;
  const body = (await (await h.app.request("/v1/config")).json()) as any;
  const d = h.deployment;
  expect(body.contracts).toEqual(d.contracts);
  expect(body.external).toEqual(d.external);
  expect(body.admin).toEqual(d.admin);
  expect(body.chainId).toBe(d.chainId);
  expect(body.gears.map((g: any) => [g.id, g.symbol, g.token])).toEqual(d.gears.map((g) => [g.id, g.symbol, g.token]));
  // the committed file is the one source: it parses and serves as it is
  const committed = loadDeployment(31337);
  const { createApiApp } = await import("./app");
  const app = createApiApp({ ...h.deps, deployment: committed });
  const served = (await (await app.request("/v1/config")).json()) as any;
  expect(served.contracts).toEqual(committed.contracts);
  // a file for another chain than CHAIN_ID is refused
  expect(() => assertDeploymentNetwork({ chainId: 4663, network: "mainnet" }, { NETWORK: "fork", CHAIN_ID: 31337 })).toThrow(DeploymentError);
  expect(() => assertDeploymentNetwork({ chainId: 31337, network: "anvil" }, { NETWORK: "fork", CHAIN_ID: 31337 })).not.toThrow();
});

import { expect, test } from "bun:test";
import { loadDeployment } from "../src/lib/deployments";

test("bootsWithoutEnv", () => {
  // No environment variable is required to import the library and read the anvil deployment.
  expect(loadDeployment(31337).chainId).toBe(31337);
});

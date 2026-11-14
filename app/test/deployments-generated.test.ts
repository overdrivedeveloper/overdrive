// Todo 11 rules R7 and R12: the deployments json DeploySystem writes passes the 01 schema, its addresses have code on
// the node it was deployed to, and every committed copy of the addresses is generated from app/deployments/<chain>.json.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeployment } from "../src/lib/deployments";
import { EMPTY_PIN, pinFromDeployment } from "../src/mcp/pinned";
import { render as renderSdk } from "../../sdk/scripts/gen-deployments";
import { render as renderPin } from "../scripts/gen-mcp-pin";

const APP = join(import.meta.dir, "..");
const LOCAL_FORK = join(APP, "deployments", "local", "fork.json");
// A copy of a real DeploySystem fork run (app/scripts/deploy.test.sh), so the schema check runs without a node. Its
// markets list is emptied (their 32-byte ids would trip the public guard's key check); the local file keeps them.
const FIXTURE = join(import.meta.dir, "fixtures", "deployment-fork.json");

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("deployments-generated", () => {
  test("forkFileValid", () => {
    const files = [FIXTURE, ...(existsSync(LOCAL_FORK) ? [LOCAL_FORK] : [])];
    for (const f of files) {
      const d = parseDeployment(read(f));
      expect(d.network).toBe("fork");
      expect(d.admin.minDelaySec).toBe(172800);
      expect(Object.values(d.contracts).every((a) => a !== "")).toBe(true);
      expect(new Set(Object.values(d.contracts)).size).toBe(Object.keys(d.contracts).length);
    }
  });

  test.skipIf(!process.env.ANVIL_URL || !existsSync(LOCAL_FORK))("addressesHaveCode", async () => {
    const d = parseDeployment(read(LOCAL_FORK));
    for (const [name, addr] of Object.entries({ ...d.contracts, timelock: d.admin.timelock })) {
      const res = await fetch(process.env.ANVIL_URL!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [addr, "latest"] }),
      });
      const code = ((await res.json()) as { result: string }).result;
      expect(code.length > 2 ? name : `${name} has no code`).toBe(name);
    }
  });

  test("copiesMatchSource", () => {
    const sdk = readFileSync(join(APP, "..", "sdk", "src", "deployments.generated.ts"), "utf8");
    expect(sdk).toBe(renderSdk());
    const mainnet = join(APP, "deployments", "mainnet.json");
    const pin = existsSync(mainnet) ? pinFromDeployment(parseDeployment(read(mainnet))) : EMPTY_PIN(4663);
    expect(readFileSync(join(APP, "src", "mcp", "pinned.generated.ts"), "utf8")).toBe(renderPin(pin));
  });
});

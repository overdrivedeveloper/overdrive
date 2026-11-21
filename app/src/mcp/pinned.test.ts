import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeployment } from "../lib/deployments";
import { assertPinned, EMPTY_PIN, MAINNET_DEPLOYMENT, pinFor, pinFromDeployment } from "./pinned";
import { buildMcp } from "./index";
import { loadMcpSettings } from "./config";
import { addr, fakeApi, fakeConfig } from "./test-support";
import { render } from "../../scripts/gen-mcp-pin";

const fixture = parseDeployment(JSON.parse(readFileSync(join(import.meta.dir, "..", "testing", "fixtures", "deployment.fork.json"), "utf8")));

describe("R8 pinned deployment", () => {
  test("pin_equals_deployment_file", () => {
    // the shipped pin is what the generator makes from deployments/mainnet.json (empty until that file exists)
    const mainnet = join(import.meta.dir, "..", "..", "deployments", "mainnet.json");
    let expected = EMPTY_PIN(4663);
    try { expected = pinFromDeployment(parseDeployment(JSON.parse(readFileSync(mainnet, "utf8")))); } catch { /* not released yet */ }
    expect(MAINNET_DEPLOYMENT).toEqual(expected);
    expect(readFileSync(join(import.meta.dir, "pinned.generated.ts"), "utf8")).toBe(render(expected));
    // and for any deployment file every pinned value is read from that file
    const pin = pinFromDeployment({ ...fixture, gears: [{ ...fakeGear("TSLA-SPORT") }] });
    expect(pin.router).toBe(fixture.contracts.ODAgentRouter as `0x${string}`);
    expect(pin.minter).toBe(fixture.contracts.ODMinter as `0x${string}`);
    expect(pin.registry).toBe(fixture.contracts.ODGearRegistry as `0x${string}`);
    expect(pin.quoter).toBe(fixture.external.v4Quoter);
    expect(pin.usdg).toBe(fixture.external.usdg);
    expect(pin.gears["TSLA-SPORT"]).toBe(addr("tok-TSLA-SPORT"));
    expect(pinFor(EMPTY_PIN(4663), 4663)).toBeUndefined(); // an empty pin pins nothing
    // the shipped pin pins mainnet once deployments/mainnet.json is released (2026-11-21), nothing before
    expect(pinFor(MAINNET_DEPLOYMENT, 4663)).toEqual(MAINNET_DEPLOYMENT.router === EMPTY_PIN(4663).router ? undefined : MAINNET_DEPLOYMENT);
    expect(pinFor(pin, 4663)).toBeUndefined(); // wrong chain
    expect(pinFor(pin, fixture.chainId)).toBe(pin);
  });

  test("mismatching_api_refused", async () => {
    const cfg = fakeConfig();
    const pin = { chainId: 31337, router: cfg.contracts.ODAgentRouter, quoter: cfg.external.v4Quoter, minter: cfg.contracts.ODMinter, usdg: cfg.external.usdg, registry: cfg.contracts.ODGearRegistry, gears: Object.fromEntries(cfg.gears.map((g) => [g.symbol, g.token])) } as any;
    expect(() => assertPinned(pin, cfg)).not.toThrow();
    const refuse = (served: object, what: RegExp) => { try { assertPinned(pin, served as any); throw new Error("not refused"); } catch (e: any) { expect(e.code).toBe("DEPLOYMENT_MISMATCH"); expect(e.message).toMatch(what); } };
    refuse({ ...cfg, contracts: { ...cfg.contracts, ODAgentRouter: addr("other") } }, /router/);
    refuse({ ...cfg, contracts: { ...cfg.contracts, ODMinter: addr("other") } }, /minter/);
    refuse({ ...cfg, external: { ...cfg.external, usdg: addr("other") } }, /USDG/);
    refuse({ ...cfg, external: { ...cfg.external, v4Quoter: addr("other") } }, /quoter/);
    refuse({ ...cfg, gears: [{ ...cfg.gears[0]!, token: addr("other") }] }, /gear TSLA-SPORT/);
    refuse({ ...cfg, gears: [...cfg.gears, { id: "0x1", symbol: "NEW-RACE", token: addr("n"), marketA: "X", marketB: null }] }, /gear NEW-RACE/); // a name added later
    // at start: a pinned server refuses to come up against a mismatching API, and runs against a matching one
    const bad = fakeApi({ routes: { "/v1/config": { ...cfg, contracts: { ...cfg.contracts, ODAgentRouter: addr("other") } } } });
    await expect(buildMcp(loadMcpSettings({ AGENT_CHAIN_ID: "31337" }), { api: bad, pin })).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" });
    await expect(buildMcp(loadMcpSettings({ AGENT_CHAIN_ID: "31337" }), { api: fakeApi(), pin })).resolves.toBeTruthy();
    // an AGENT_ROUTER that is not the pinned one
    await expect(buildMcp(loadMcpSettings({ AGENT_CHAIN_ID: "31337", AGENT_ROUTER: addr("x") }), { api: fakeApi(), pin })).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" });
  });
});

function fakeGear(symbol: string) {
  return { id: "0x" + "11".repeat(32) as `0x${string}`, symbol, gear: "SPORT" as const, power: "2", marketA: "TSLA", marketB: null, token: addr(`tok-${symbol}`), poolId: "0x" + "22".repeat(32) as `0x${string}`, capUsd: "1", spreadBps: 40, unitUsd: "100" };
}

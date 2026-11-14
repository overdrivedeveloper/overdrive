import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeKeystorePair } from "../testing/keystore";
import { loadMcpSettings } from "./config";

describe("R11 keys", () => {
  test("production_requires_keystore", () => {
    const key = generatePrivateKey();
    // a raw key is development only, under either name
    expect(() => loadMcpSettings({ NODE_ENV: "production", AGENT_KEY: key })).toThrow(/only accepts a keystore/);
    expect(() => loadMcpSettings({ NODE_ENV: "production", AGENT_PRIVATE_KEY: key })).toThrow(/only accepts a keystore/);
    expect(loadMcpSettings({ NODE_ENV: "development", AGENT_KEY: key }).agentKey).toBe(key);
    // the error never carries the key
    try { loadMcpSettings({ NODE_ENV: "production", AGENT_KEY: key }); } catch (e) { expect(String((e as Error).message)).not.toContain(key.slice(2)); }
    // a keystore with its password file works in production
    const { env, dir } = writeKeystorePair("AGENT", key);
    try {
      const s = loadMcpSettings({ NODE_ENV: "production", ...env });
      expect(privateKeyToAccount(s.agentKey!).address).toBe(privateKeyToAccount(key).address);
      expect(s.requestedMode).toBe("send");
      expect(() => loadMcpSettings({ NODE_ENV: "production", AGENT_KEYSTORE: env.AGENT_KEYSTORE })).toThrow(/needs AGENT_KEYSTORE_PASSWORD_FILE/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("no key means read_only whatever MCP_MODE says", () => {
    expect(loadMcpSettings({ MCP_MODE: "send" }).requestedMode).toBe("read_only");
  });
});

// Anvil's well-known dev keys are encrypted at test time into a temp dir; no key file is committed.
import { afterAll, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, concat, keccak256, type Hex } from "viem";
import { assertDistinctKeys, decryptKeystore, KEY_ROLES, KeyConfigError, resolveKey } from "./keys";

const KEY_A: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // test-key
const KEY_B: Hex = `0x${"22".repeat(32)}`; // test-key
const PASSWORD = "correct horse battery staple"; // test-password
const dir = mkdtempSync(join(tmpdir(), "od-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function encrypt(key: Hex, password: string): string {
  const salt = randomBytes(32), iv = randomBytes(16);
  const dk = scryptSync(Buffer.from(password.normalize("NFKD")), salt, 32, { N: 16, r: 8, p: 1 });
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(Buffer.from(key.slice(2), "hex")), c.final()]);
  const mac = keccak256(concat([bytesToHex(new Uint8Array(dk.subarray(16, 32))), bytesToHex(new Uint8Array(ct))])).slice(2);
  return JSON.stringify({ version: 3, crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ct.toString("hex"), kdf: "scrypt", kdfparams: { dklen: 32, n: 16, r: 8, p: 1, salt: salt.toString("hex") }, mac } });
}

let n = 0;
function pair(spec: { keystore: string; passwordFile: string }, key: Hex, mode = 0o440) {
  const id = n++;
  const ks = join(dir, `ks-${id}.json`), pw = join(dir, `ks-${id}.password`);
  writeFileSync(ks, encrypt(key, PASSWORD));
  writeFileSync(pw, `${PASSWORD}\n`);
  chmodSync(ks, mode);
  chmodSync(pw, mode);
  return { [spec.keystore]: ks, [spec.passwordFile]: pw };
}

describe("keys", () => {
  test("production_requires_keystore_and_never_prints_secret", () => {
    const p = pair(KEY_ROLES.crank, KEY_A);
    expect(resolveKey(KEY_ROLES.crank, { ...p, NODE_ENV: "production" })).toBe(KEY_A);
    expect(resolveKey(KEY_ROLES.crank, { CRANK_PRIVATE_KEY: KEY_A })).toBe(KEY_A);
    let text = "";
    try { resolveKey(KEY_ROLES.crank, { NODE_ENV: "production", CRANK_PRIVATE_KEY: KEY_A }); } catch (e) { text = String(e); }
    expect(text).toContain("only accepts a keystore");
    expect(text).not.toContain(KEY_A.slice(2));
    const bad = join(dir, "bad.password");
    writeFileSync(bad, "not the password\n");
    try { resolveKey(KEY_ROLES.crank, { ...p, CRANK_KEYSTORE_PASSWORD_FILE: bad }); throw new Error("should fail"); } catch (e) {
      expect(String(e)).toContain("wrong password");
      expect(String(e)).not.toContain("not the password");
    }
    const open = pair(KEY_ROLES.hedger, KEY_B, 0o644);
    expect(() => resolveKey(KEY_ROLES.hedger, { ...open, NODE_ENV: "production" })).toThrow("readable by other users");
    expect(() => decryptKeystore("{not json", PASSWORD)).toThrow(KeyConfigError);
  });
  test("roles_must_differ", () => {
    expect(() => assertDistinctKeys({ CRANK_PRIVATE_KEY: KEY_A, HEDGER_PRIVATE_KEY: KEY_A })).toThrow("crank and hedger keys must be different");
    expect(() => assertDistinctKeys({ HEDGER_PRIVATE_KEY: KEY_A, LIQUIDATOR_PRIVATE_KEY: KEY_A })).toThrow("hedger and liquidator");
    expect(() => assertDistinctKeys({ CRANK_PRIVATE_KEY: KEY_A, ...pair(KEY_ROLES.volSigner, KEY_A) })).toThrow("crank and vol signer");
    expect(() => assertDistinctKeys({ CRANK_PRIVATE_KEY: KEY_A, HEDGER_PRIVATE_KEY: KEY_B })).not.toThrow();
  });
});

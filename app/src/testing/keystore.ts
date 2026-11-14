// Test-only: encrypts a throwaway key into a web3 secret storage v3 file plus a password file, in a temp folder, at run time.
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, concat, keccak256, type Hex } from "viem";

export function encryptKeystore(key: Hex, password: string): string {
  const salt = randomBytes(32), iv = randomBytes(16);
  const dk = scryptSync(Buffer.from(password.normalize("NFKD")), salt, 32, { N: 16, r: 8, p: 1 });
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(Buffer.from(key.slice(2), "hex")), c.final()]);
  const mac = keccak256(concat([bytesToHex(new Uint8Array(dk.subarray(16, 32))), bytesToHex(new Uint8Array(ct))])).slice(2);
  return JSON.stringify({ version: 3, crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ct.toString("hex"), kdf: "scrypt", kdfparams: { dklen: 32, n: 16, r: 8, p: 1, salt: salt.toString("hex") }, mac } });
}

/** Writes keystore + password files (mode 0440) for `key` in a new temp folder; returns the env entries and the folder. */
export function writeKeystorePair(prefix: string, key: Hex): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "od-crank-"));
  const password = randomBytes(12).toString("hex");
  const ks = join(dir, "keystore.json"), pw = join(dir, "password");
  writeFileSync(ks, encryptKeystore(key, password));
  writeFileSync(pw, `${password}\n`);
  chmodSync(ks, 0o440);
  chmodSync(pw, 0o440);
  return { env: { [`${prefix}_KEYSTORE`]: ks, [`${prefix}_KEYSTORE_PASSWORD_FILE`]: pw }, dir };
}

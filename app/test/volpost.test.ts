import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, recoverTypedDataAddress, toHex } from "viem";
import {
  pairMarketKey,
  VOL_DOMAIN_NAME,
  VOL_DOMAIN_VERSION,
  VOL_POST_TYPES,
  volPostDigest,
  volPostTypedData,
  type Address,
  type Hex,
  type VolPostMessage,
} from "../src/lib/volpost";

const vector = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "contracts", "test", "vectors", "volpost-eip712.json"), "utf8"),
);

const message = (): VolPostMessage => {
  const m = vector.typedData.message;
  return {
    market: m.market as Hex,
    sigmaBps: BigInt(m.sigmaBps),
    buyBlockFrom: BigInt(m.buyBlockFrom),
    buyBlockTo: BigInt(m.buyBlockTo),
    validUntil: BigInt(m.validUntil),
    nonce: BigInt(m.nonce),
  };
};
const chainId: number = vector.typedData.domain.chainId;
const verifyingContract = vector.typedData.domain.verifyingContract as Address;

describe("volpost", () => {
  test("typesMatchVector", () => {
    expect(VOL_DOMAIN_NAME).toBe(vector.typedData.domain.name);
    expect(VOL_DOMAIN_VERSION).toBe(vector.typedData.domain.version);
    expect(VOL_POST_TYPES.VolPost.map((f) => ({ ...f }))).toEqual(vector.typedData.types.VolPost);
    expect(
      keccak256(
        toHex(`VolPost(${VOL_POST_TYPES.VolPost.map((f) => `${f.type} ${f.name}`).join(",")})`),
      ),
    ).toBe(vector.typeHash);
  });

  test("digestMatchesVector", () => {
    expect(volPostDigest(chainId, verifyingContract, message())).toBe(vector.digest);
  });

  test("signatureRecoversToVectorSigner", async () => {
    const addr = await recoverTypedDataAddress({
      ...volPostTypedData(chainId, verifyingContract, message()),
      signature: vector.signature as Hex,
    });
    expect(addr).toBe(vector.signer);
  });

  test("digestBindsEveryField", () => {
    const base = volPostDigest(chainId, verifyingContract, message());
    expect(volPostDigest(chainId + 1, verifyingContract, message())).not.toBe(base);
    expect(volPostDigest(chainId, "0x00000000000000000000000000000000000f0d02", message())).not.toBe(base);
    for (const k of ["sigmaBps", "buyBlockFrom", "buyBlockTo", "validUntil", "nonce"] as const) {
      const m = message();
      m[k] = m[k] + 1n;
      expect(volPostDigest(chainId, verifyingContract, m)).not.toBe(base);
    }
    const m = message();
    m.market = keccak256(toHex("market:OTHER"));
    expect(volPostDigest(chainId, verifyingContract, m)).not.toBe(base);
  });

  test("pairMarketKeyIsAbiEncodeHash", () => {
    const a = keccak256(toHex("market:A"));
    const b = keccak256(toHex("market:B"));
    expect(pairMarketKey(a, b)).toBe(
      keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [a, b])),
    );
    expect(pairMarketKey(a, b)).not.toBe(pairMarketKey(b, a));
  });
});

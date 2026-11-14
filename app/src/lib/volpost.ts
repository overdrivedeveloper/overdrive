// EIP-712 typed data for a signed sigma post to ODVolOracle. Builder only: the vol engine signs with it.
import { encodeAbiParameters, hashTypedData, keccak256 } from "viem";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export const VOL_DOMAIN_NAME = "Overdrive Vol";
export const VOL_DOMAIN_VERSION = "1";

export const VOL_POST_TYPES = {
  VolPost: [
    { name: "market", type: "bytes32" },
    { name: "sigmaBps", type: "uint64" },
    { name: "buyBlockFrom", type: "uint64" },
    { name: "buyBlockTo", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export interface VolPostMessage {
  market: Hex;
  sigmaBps: bigint;
  buyBlockFrom: bigint;
  buyBlockTo: bigint;
  validUntil: bigint;
  nonce: bigint;
}

/** Typed data for viem's signTypedData / hashTypedData. */
export function volPostTypedData(chainId: number, verifyingContract: Address, message: VolPostMessage) {
  return {
    domain: { name: VOL_DOMAIN_NAME, version: VOL_DOMAIN_VERSION, chainId, verifyingContract },
    types: VOL_POST_TYPES,
    primaryType: "VolPost" as const,
    message,
  };
}

/** The digest the oracle's `hashPost` returns for the same post. */
export function volPostDigest(chainId: number, verifyingContract: Address, message: VolPostMessage): Hex {
  return hashTypedData(volPostTypedData(chainId, verifyingContract, message));
}

/** Market key of a pair: numerator market `a` over denominator market `b`, as keccak256(abi.encode(a, b)). */
export function pairMarketKey(a: Hex, b: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [a, b]));
}

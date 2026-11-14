import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicClient, encodeErrorResult, http, type Hex } from "viem";
import { IODGovernorAbi, IODMinterAbi } from "../abi";
import { decodeRevert, revertDataOf, revertNameOf, RevertError, withDecodedRevert } from "./revert";
import { safeErrorSummary } from "../log";

/** A JSON-RPC node that answers eth_estimateGas the way geth and Nitro do for a custom-error revert: code 3, the message
 * "execution reverted", and the error's selector and arguments in `data`. (Only anvil puts "custom error 0x..." in the message.) */
let server: ReturnType<typeof Bun.serve>;
let revertData: Hex = "0x";
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as { id: number; method: string };
      if (body.method === "eth_estimateGas") {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted", data: revertData } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1" });
    },
  });
});
afterAll(() => server.stop(true));

async function simulate(data: Hex): Promise<unknown> {
  revertData = data;
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${server.port}`, { retryCount: 0 }) });
  try {
    await client.estimateGas({ account: "0x00000000000000000000000000000000000000a1", to: "0x00000000000000000000000000000000000000b2", data: "0x12345678" });
  } catch (error) {
    return error;
  }
  throw new Error("estimateGas did not fail");
}

describe("R14/R19 revert data is decoded from a geth-shaped node", () => {
  test("the viem error for a custom-error revert names neither the error nor its selector (why the old matchers never fired)", async () => {
    const error = await simulate(encodeErrorResult({ abi: IODMinterAbi, errorName: "Slippage", args: [100n, 200n] })) as Error;
    const text = `${error.message} ${(error as { shortMessage?: string }).shortMessage ?? ""} ${safeErrorSummary(error).message}`;
    expect(text).not.toMatch(/Slippage/);
    expect(text.toLowerCase()).not.toContain(encodeErrorResult({ abi: IODMinterAbi, errorName: "Slippage", args: [100n, 200n] }).slice(0, 10));
  });

  test("the revert data is found in the error chain and decoded against the minter's errors", async () => {
    const error = await simulate(encodeErrorResult({ abi: IODMinterAbi, errorName: "Slippage", args: [100n, 200n] }));
    expect(revertDataOf(error)?.startsWith("0x")).toBe(true);
    const decoded = decodeRevert(error)!;
    expect(decoded.name).toBe("Slippage");
    expect(decoded.args).toEqual([100n, 200n]);
    const wrapped = withDecodedRevert(error);
    expect(wrapped).toBeInstanceOf(RevertError);
    expect(safeErrorSummary(wrapped).message).toContain("Slippage(100, 200)");
    expect(revertNameOf(wrapped)).toBe("Slippage");
  });

  test("errors of other interfaces decode too", async () => {
    for (const [errorName, args] of [["StressBudget", [5n, 3n]], ["TooEarly", [9n]], ["NotBacker", []]] as const) {
      const error = await simulate(encodeErrorResult({ abi: IODGovernorAbi, errorName, args: args as never }));
      expect(revertNameOf(withDecodedRevert(error))).toBe(errorName);
    }
  });

  test("an unknown selector, an empty revert and a plain Error are left as they were", async () => {
    const unknown = await simulate("0xdeadbeef");
    expect(withDecodedRevert(unknown)).toBe(unknown);
    const plain = new Error("fetch failed");
    expect(withDecodedRevert(plain)).toBe(plain);
    expect(decodeRevert(plain)).toBeUndefined();
  });
});

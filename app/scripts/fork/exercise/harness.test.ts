import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeErrorResult, toFunctionSelector } from "viem";
import { IODMinterAbi } from "../../../src/abi";
import { Blocked, Row, revertNames, runFlow, type Ctx, type Flow } from "./harness";
import { emptyResults } from "./results";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const file = join(mkdtempSync(join(tmpdir(), "hn-")), "r.json");
const spec = { id: "T01", area: "holders", name: "t", kind: "success" as const };
const fakeCtx = { pub: { readContract: async () => 0n }, c: { ODGovernor: "0x0000000000000000000000000000000000000001" }, usdg: "0x0000000000000000000000000000000000000002" } as unknown as Ctx;
// checkInvariants reads freeCash, exitReserve, USDG balance and the floor; zero everywhere is a consistent book

describe("harness", () => {
  test("row_fails_on_chain_or_api_mismatch_and_decodes_reverts", () => {
    const row = new Row(fakeCtx, spec);
    expect(() => row.chain("tokens", 5n, 6n)).toThrow("chain tokens: got 5, want 6");
    expect(() => row.api("balance", "7", "8")).toThrow("api balance: got 7, want 8");
    expect(() => row.chainWithin("value", 10n, 12n, 1n)).toThrow("within 1");
    row.chainWithin("value", 11n, 12n, 1n);
    row.chain("same", 3n, 3n);
    expect(row.chainN).toBe(4);
    expect(row.apiN).toBe(1);
    // a direct revert and one wrapped inside another error's data (a hook revert reaches the swapper wrapped)
    const direct = encodeErrorResult({ abi: IODMinterAbi, errorName: "Slippage", args: [1n, 2n] });
    expect(revertNames({ data: direct })).toContain("Slippage");
    const inner = encodeErrorResult({ abi: IODMinterAbi, errorName: "BelowMinimum" });
    const wrapped = `0x6190b2b0${encodeAbiParameters([{ type: "bytes" }], [inner]).slice(2)}`;
    expect(revertNames({ cause: { data: wrapped } })).toContain("BelowMinimum");
    expect(revertNames({ data: `0x${toFunctionSelector("Foo()").slice(2)}` })).toEqual([]);
  });

  test("runFlow_records_pass_fail_and_blocked_and_known_bugs", async () => {
    const mk = (run: Flow["run"]): Flow => ({ ...spec, run });
    const pass = await runFlow(mk(async (r) => r.chain("x", 1, 1)), fakeCtx, emptyResults(), file);
    expect(pass.row.status).toBe("pass");
    const fail = await runFlow(mk(async (r) => r.chain("x", 1, 2)), fakeCtx, emptyResults(), file);
    expect(fail.row.status).toBe("fail");
    expect(fail.row.error).toContain("got 1, want 2");
    const blocked = await runFlow(mk(async (r) => r.blocked("no vol engine")), fakeCtx, emptyResults(), file);
    expect(blocked.row.status).toBe("blocked");
    expect(blocked.row.error).toBe("no vol engine");
    // a failure recorded against a known bug does not end the flow, and still fails the row
    const bug = await runFlow(mk(async (r) => { await r.known("BUG-1", () => r.api("quote", "a", "b")); r.chain("after", 1, 1); }), fakeCtx, emptyResults(), file);
    expect(bug.row.status).toBe("fail");
    expect(bug.row.error).toContain("[BUG-1] api quote");
    expect(bug.row.chain.asserted).toBe(1);
    expect(new Blocked("x")).toBeInstanceOf(Error);
  });
});

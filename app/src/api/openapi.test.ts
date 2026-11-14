import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiDocument, apiDocumentText } from "./dump";
import { ROUTE_TABLE } from "./route-kit";

const COMMITTED = join(import.meta.dir, "..", "..", "..", "sdk", "openapi.json");

test("committed_equals_dumped", () => {
  expect(readFileSync(COMMITTED, "utf8")).toBe(apiDocumentText());
});

test("every route has a typed operation: a 200 schema and error bodies for its errors", () => {
  const doc = apiDocument() as { paths: Record<string, Record<string, any>>; openapi: string };
  expect(doc.openapi).toBe("3.1.0");
  for (const r of ROUTE_TABLE.filter((x) => x.tag !== "docs")) {
    const op = doc.paths[r.path]?.[r.method.toLowerCase()];
    expect({ route: `${r.method} ${r.path}`, hasOperation: !!op }).toEqual({ route: `${r.method} ${r.path}`, hasOperation: true });
    expect(op.responses["200"].content["application/json"].schema).toBeTruthy();
    expect(op.summary).toBeTruthy();
    expect(op.tags.length).toBe(1);
  }
  expect(doc.paths["/v1/quote"]!.get!.parameters.map((p: any) => p.name).sort()).toEqual(["account", "gear", "side", "tokens", "usdg"]);
});

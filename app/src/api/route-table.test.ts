import { afterAll, expect, test } from "bun:test";
import { ROUTE_TABLE } from "./route-kit";
import { harness } from "./test-support";

const h = await harness("routetable");
afterAll(async () => { await h?.close(); });

test("every_route_listed_and_no_admin_route", () => {
  if (!h) return;
  const wildcard = h.app.routes.filter((r) => r.method !== "ALL" && r.path.includes("*"));
  // wildcard paths are limiter middleware, never handlers: only these patterns may exist
  for (const w of wildcard) expect(["/v1/intent/*"]).toContain(w.path);
  const registered = h.app.routes.filter((r) => r.method !== "ALL" && r.method !== "OPTIONS" && !r.path.includes("*"));
  const asOpenApi = (path: string) => path.replace(/:([A-Za-z]+)/g, "{$1}");
  for (const r of registered) {
    const found = ROUTE_TABLE.find((t) => t.method === r.method && t.path === asOpenApi(r.path));
    expect({ route: `${r.method} ${r.path}`, listed: !!found }).toEqual({ route: `${r.method} ${r.path}`, listed: true });
    expect(["public", "public_rate_limited"]).toContain(found!.auth);
  }
  for (const t of ROUTE_TABLE) expect(registered.some((r) => r.method === t.method && asOpenApi(r.path) === t.path)).toBe(true);
  expect(ROUTE_TABLE.some((t) => /admin|\/internal|\/pause|\/sign/i.test(t.path))).toBe(false);
  expect(ROUTE_TABLE.filter((t) => t.method === "POST").map((t) => t.path).sort()).toEqual(["/v1/intent/buy", "/v1/intent/sell"]);
  expect(ROUTE_TABLE.filter((t) => t.method === "POST").every((t) => t.auth === "public_rate_limited")).toBe(true);
});

test("a route registered without a table entry fails the check", () => {
  if (!h) return;
  h.app.get("/v1/secret-admin", (c) => c.json({}));
  const registered = h.app.routes.filter((r) => r.path === "/v1/secret-admin");
  expect(registered.length).toBe(1);
  expect(ROUTE_TABLE.some((t) => t.path === "/v1/secret-admin")).toBe(false);
});

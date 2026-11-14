// The OpenAPI document as text, built from an app with no data behind it (the document depends only on the route definitions).
import pino from "pino";
import { loadConfig } from "../config";
import { parseDeployment } from "../lib/deployments";
import { createApiApp } from "./app";
import { TtlCache } from "./cache";
import { openApiDocument } from "./openapi";

export function apiDocument(): unknown {
  const config = loadConfig({ NODE_ENV: "test", NETWORK: "fork", CHAIN_ID: "31337", DATABASE_URL: "postgres://localhost/unused" });
  const deployment = parseDeployment(JSON.parse(require("node:fs").readFileSync(new URL("../../deployments/anvil.json", import.meta.url), "utf8")));
  const app = createApiApp({ sql: undefined as never, config, deployment, logger: pino({ level: "silent" }), cache: new TtlCache(), chain: undefined as never });
  return app.getOpenAPI31Document(openApiDocument);
}
export const apiDocumentText = (): string => `${JSON.stringify(apiDocument(), null, 2)}\n`;

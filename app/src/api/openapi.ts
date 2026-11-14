import { readFileSync } from "node:fs";

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.1.0";

export const openApiDocument = {
  openapi: "3.1.0" as const,
  info: {
    title: "Overdrive API",
    version,
    description: "Gear prices, the daily toll, exact quotes, unsigned transaction intents, the Governor page and the exit reserve. Read only: it reads Postgres and the chain, holds no key and sends nothing.",
  },
  tags: [
    { name: "system", description: "Configuration, status and liveness" },
    { name: "gears", description: "Gears, their price history and the daily toll" },
    { name: "quotes", description: "Exact quotes and unsigned transaction intents" },
    { name: "governor", description: "The Governor, the exit reserve, fees, risk and hedges" },
    { name: "accounts", description: "Balances, vaults and queued sells for an address" },
    { name: "docs", description: "This document and its viewer" },
  ],
};

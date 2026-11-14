# ovrd

A typed TypeScript client for the Overdrive API on Robinhood Chain. It reads gears, the daily toll, the Governor and the exit
reserve, returns exact quotes, and builds unsigned transaction intents. It holds no key and sends nothing: you sign with your own wallet.

```sh
npm install ovrd
```

```ts
import { Overdrive, summarizeQuote, parseUnits, quoteExpired } from "ovrd";

// chainId pins intent checks to the deployment file shipped inside this package (offline, never the API's word).
const od = new Overdrive({ baseUrl: "https://api.example.com", chainId: 4663 });

const gears = await od.gears();
const q = summarizeQuote(await od.quote({ gear: "TSLA-SPORT", side: "buy", usdg: parseUnits("25", 6).toString() }));
if (q.buyable) {
  console.log(q.amountOut, q.tollPerDayBps, q.breakevenDays);
  const intent = await od.intent("buy", { gear: "TSLA-SPORT", account: "0x...", usdg: "25000000" });
  // Throws OverdriveIntentMismatch unless tx.to, every spender and every approved token is in the committed deployment file.
  // intent.tx is { to, data, value: "0" }; sign and send with your own wallet.
} else console.log(q.reason);
```

## What is in it
- Read helpers for every API route (`gears`, `gear`, `tolls`, `governor`, `exit`, `fees`, `risk`, `account`, `backer`, `vault`, ...), typed from the API's OpenAPI document.
- Quote helpers: `summarizeQuote` (BigInt amounts, or the reason it cannot run now), `quoteExpired`, `minOutFor` (slippage in whole basis points, rounded down), `parseUnits` and `formatUnits` (exact, no floating point; USDG 6 decimals, tokens 18).
- Intent builders for buy, sell, backer vaults, queued sells and agent policies, each followed by a check against the deployment file (`verifyIntent`, also exported for use on its own).
- Behaviour: ETag revalidation, a request timeout, bounded retry on 429, `OverdriveApiError(status, code, reason)`. A stale flag is returned, never thrown.

## Claims you can check yourself
Each line says how. Nothing here is a claim about a deployment that does not exist yet.

| Claim | Check |
|---|---|
| Zero runtime dependencies | `npm view ovrd dependencies` prints nothing |
| The tarball holds only `dist/` (`.js` and `.d.ts`), `LICENSE`, `README.md`, `package.json` | `npm pack --dry-run ovrd` |
| It never signs or broadcasts | read `dist/client.js`: the only network calls are `fetch` to your `baseUrl`; there is no key, signer or RPC code |
| Intent targets, spenders and approved tokens must be in the shipped deployment file, and an empty or unknown file refuses everything | read `dist/helpers.js` (`verifyIntent`); run the package tests |
| One address source: the SDK's addresses equal the repository's deployment file | test `sdk_addresses_equal_deployment_file` in `test/client.test.ts` |
| Built from the public source by GitHub Actions with provenance | `npm view ovrd dist.attestations`, once published |

## Honest limits
- The committed deployment file has only the local test chain filled in so far. Until mainnet addresses are committed, `verifyIntent` for chain 4663 refuses every intent, by design (fail closed).
- Quotes are exact for the block they name and expire (`expiresAt`). Nothing here is a promise about price or return.

## Development
`bun run generate` rebuilds `src/generated.ts` (from `openapi.json`) and `src/deployments.generated.ts` (from `../app/deployments/*.json`).
`bun run generate:check`, `bun run typecheck`, `bun test` and `bun run smoke` (packs and runs the tarball under plain Node) gate every release.
MIT licensed.

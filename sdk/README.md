# Overdrive SDK (placeholder package name, not published)

A typed TypeScript client for the Overdrive API. It reads prices, the daily toll, exact quotes and the Governor and exit pages,
and builds unsigned transaction intents. It holds no key and sends nothing: you sign with your own wallet.

The package name is a decision for the owner (D17); `package.json` stays `private` until then.

```ts
import { Overdrive } from "overdrive-sdk-placeholder";

const od = new Overdrive({ baseUrl: "https://api.example.com" });

const gears = await od.gears();                       // price, daily toll, spread, cap, sell mode, buyable + reason
const q = await od.quote({ gear: "TSLA-SPORT", side: "buy", usdg: "25000000" }); // 25 USDG (6 decimals)
if (q.buyable) {
  console.log(q.tokensOut, q.tollPerDayBps, q.breakevenDays); // what executes is what is quoted
  const intent = await od.intent("buy", { gear: "TSLA-SPORT", account: "0x...", usdg: "25000000" });
  // intent.tx is { to, data, value: "0" }; check intent.approvals, then sign and send with your wallet
}
```

## Behaviour
- Amounts are raw integer strings; each response carries `decimals` (USDG 6, tokens and values 18).
- Every response has `asOfBlock`, `asOf` and `stale`. A stale flag is returned, never thrown.
- A 429 is retried after `Retry-After` (at most 2 retries, a wait above `maxRetryWaitSeconds` is not waited for).
- Reads are revalidated with ETags (`If-None-Match`, 304 answers come from memory).
- Each request has a timeout (default 15 s). Failures are `OverdriveApiError(status, code, reason)`.
- `intent()` refuses a target or approval spender that is not one of the deployment's contracts (`OverdriveIntentMismatch`).
  Pin the expected addresses with `expectedContracts`; `deploymentFor(chainId)` has the addresses generated from the deployment file.

## Development
`bun run generate` rebuilds `src/generated.ts` (from `openapi.json`, which `cd ../app && bun run scripts/dump-openapi.ts` writes) and
`src/deployments.generated.ts` (from `../app/deployments/*.json`). `bun run generate:check` fails when either is out of date.

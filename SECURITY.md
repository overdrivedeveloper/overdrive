# Security policy

Overdrive is in development, not deployed and unaudited. Treat every contract in this repository as unreviewed.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Do not open a public issue or pull request for a vulnerability, and do not post details anywhere public before a fix is out. Include the affected file or contract, the steps to reproduce, and the impact you expect. We aim to acknowledge a report within 3 working days.

## Scope

In scope:

- Solidity contracts under `contracts/src`.
- The services under `app/src` (API, indexer, crank, hedger, liquidator, MCP server), including key handling and the intent routes.
- `sdk/`, `mcp/`, `vol-engine/` and `risk-sim/`.

Out of scope: third-party infrastructure (Robinhood Chain, Chainlink, Pyth, Uniswap, venues the hedger trades on), vendored libraries under `contracts/lib` (report those upstream), and findings that need a compromised owner machine or a leaked key.

## Trust assumptions

- The core contracts are non-upgradeable. Admin changes go through a timelock with a 48 hour delay.
- The guardian role can only pause or otherwise reduce risk. It cannot move funds or raise a limit.
- The price oracle fails closed: a stale, missing or disagreeing price stops the action that needs it instead of falling back to a guess.
- Holders are never liquidated. Only backer vaults can be liquidated, through sealed batches that anyone may execute.
- Service keys are separate per role. The API holds no key and reads only Postgres. The liquidator key holds gas only.

## Accepted risks

Known and accepted for the first release, stated generically:

- A trader with outside information can gain a bounded amount per round trip when neither the price feed nor the reference price has moved yet; the gear's cap bounds it.
- Quotes cannot see a token blocklist or pause on a recipient, or a failing fee transfer, so a trade can fall back to the queue.
- A backer vault minted at the minimum ratio can become sealable at a market reopen after a weekend if the reference price moves against it.
- Off-chain components (volatility signer, keeper, hedger) can be late; on-chain guards bound the effect of stale data but do not remove it.
- The system has not been audited.

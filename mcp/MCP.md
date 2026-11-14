# Overdrive MCP server

An MCP server for agents: read gears, quote exactly, and trade for an owner inside the limits the owner set on chain.
Code: `app/src/mcp`. Package: `mcp/` (private, placeholder name, never published from here). Entry point:
`bun run app/src/bin/mcp.ts [--stdio | --http]`.

## Modes (R1)
| Mode | When | Tools |
|---|---|---|
| `read_only` | No agent key, or `MCP_MODE=read_only`. The hosted `--http` server is always this and refuses any key. | `od_gears`, `od_quote`, `od_positions`, `od_governor`, `od_exit` |
| `prepare` | A key, but no readable live policy on chain (or `MCP_MODE=prepare`). | all eight; the write tools return calldata and never send |
| `send` | A key and a live (unexpired, unrevoked) policy readable from the agent router. | all eight; the write tools sign with the agent key and send |

The chain is the authority. Every write reads the policy again (budget left, per-trade limit, expiry, revocation, allowed
markets) and refuses before signing with the contract's own error name (`MaxPerTradeExceeded`, `BudgetExceeded`,
`MarketNotAllowed`, `SellNotAllowed`, `BackNotAllowed`, `PolicyExpired`, `PolicyIsRevoked`, `NoPolicy`). The router
enforces the same rules on chain whatever this server does. One write at a time per owner, so two buys cannot both pass
the same remaining budget.

## Tools
`od_gears {underlying?, power?}`, `od_quote {gear, side, usdg? | tokens?}`, `od_buy_gear {gear, usdg, slippageBps?, deadlineSeconds?, owner?}`,
`od_sell_gear {gear, tokens, ...}`, `od_back {gear, collateralUsdg, mintTokens?, vaultId?, ...}`, `od_positions {owner?}`,
`od_governor {}`, `od_exit {}`. Amounts are raw integers (USDG 6 dp, tokens 18 dp); results add a human field.
Every string that came from the API or the chain is returned inside a `data` field, never inside our own sentences.

Trades: the server asks the API for a quote and an unsigned `ODMinter` intent, checks that the calldata decodes to exactly
the quoted gear, amount, minimum out and deadline with the owner as recipient (`BAD_INTENT` otherwise), and re-wraps it as
`ODAgentRouter.buyFor / sellFor`. A quote that is stale, `CLOSED`, `PAUSED`, `CAP_REACHED` or queued-only is returned with
the API's reason and never sent. `od_back` uses `backFor`, only when the policy has `canBack`; otherwise it answers
`NOT_SUPPORTED_BY_POLICY` with the plan. It refuses Eco gears (`NotBackable`), shows the collateral ratio against the
gear's `collateralBps` (Race 250%) and the liquidation price first, and a new vault needs at least 50 USDG.

## Environment
`OD_API_URL`, `AGENT_OWNER`, `AGENT_ROUTER`, `AGENT_RPC_URL`, `AGENT_CHAIN_ID`, `AGENT_KEYSTORE` + `AGENT_KEYSTORE_PASSWORD_FILE`
(role `agent`; a raw `AGENT_KEY` is development only and refused under `NODE_ENV=production`), `AGENT_POLICY_FROM_ENV=1` with
`AGENT_POLICY` (development only, refused in production), `MCP_MODE`, `MCP_RATE_LIMIT_PER_MINUTE` (60), `MCP_HTTP_HOST`,
`MCP_HTTP_PORT` (3102), `MCP_HTTP_TOKEN`, `MCP_ALLOWED_ORIGINS`, `MCP_TRUSTED_PROXIES`.

## Pinned deployment (R8)
`app/src/mcp/pinned.generated.ts` is written by `bun run scripts/gen-mcp-pin.ts` from `deployments/mainnet.json` (empty until
that file exists). A package built with a pin compares it with `/v1/config` at start and on every config refresh and refuses
with `DEPLOYMENT_MISMATCH` on any difference in router, quoter, minter, USDG, registry or a gear token. A gear the API adds
later is refused until a new package version.

## Limits (R9)
60 requests a minute per client (proxy header only from a trusted peer, else the socket), 64 KB request body, 20 messages per
batch, 200 KB result cap (a cut result says so), 30 s per tool.

## Safety notes
The server never holds a key in hosted mode, never prints or returns the agent key, and never broadcasts anything the
policy forbids. A paused gear pauses the agent's buys; sells follow the same rule as any holder. Nothing here is advice.

# Security policy

Overdrive is in development, not deployed and not externally audited. Treat every contract in this repository as unreviewed.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Do not open a public issue or pull request for a vulnerability, and do not post details anywhere public before a fix is out. Include the affected file or contract, the steps to reproduce, and the impact you expect. We aim to acknowledge a report within 3 working days.

## Scope

Reviewed commit: `3fe7859` (branch `main`, 2026-11-14). The contracts are frozen at the commit that is later tagged for review; findings are reported against a tagged commit. Nothing is deployed, so there are no addresses in scope yet.

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

## Threat model

### Actors

| Actor | Trusted with | Assumed to be |
| --- | --- | --- |
| Holder | Their own gear tokens and USDG | Anyone; may trade on outside information, may be a contract |
| Backer | A vault: collateral posted against minted debt | Anyone; the only party that can be liquidated |
| Liquidity provider (Governor shares) | USDG in the Governor's book | Anyone; exits through a delayed ticket |
| Staker | OVRD in the stake contract | Anyone; first-loss cover and fee discount |
| Executor (liquidation, crank, poke) | Nothing | Anyone; permissionless calls that pay a bounded bonus or nothing |
| Admin (Safe 3-of-5 behind a 48 hour timelock) | Every `DEFAULT_ADMIN_ROLE` setter below | Honest majority of 3; can be seen coming for 48 hours |
| Guardian (Safe 2-of-5) | Pause and risk-reducing actions only | A key set that can be compromised; the damage is bounded to a pause or a risk cut |
| Keeper (crank key) | Session windows, exit-reserve moves, fee buy-and-burn | Can be late or wrong inside bounds |
| Hedger key | Moving USDG to and from the hedger wallet; posting hedge equity | Can be compromised (see L-5) |
| Vol signer | Signing volatility posts | Can be compromised; posts are clamped to per-market bounds; the guardian revokes |
| Paymaster signer | Signing gas sponsorship for agent accounts | Can be compromised; per-op and daily caps bound the loss |

### Assets

- USDG held by the Governor (free cash, exit reserve), the Backer's vault collateral, the insurance fund, the stake contract and the fee contract.
- Holder gear tokens and their value index.
- Availability: holders being able to sell, backers being able to repay, LPs being able to exit.

### What the design relies on

- Chain consensus and the USDG token behave as documented (no rebasing, no blocklist surprises beyond the cases listed under Accepted risks).
- Two independent price sources (feed and reference) agree within a per-market band; when they do not, buys stop.
- The 48 hour timelock and the guardian Safe are held by separate people on separate devices.
- Off-chain components publish on time; on-chain guards bound the damage when they do not.

### What Overdrive does not protect against

- A compromise of 3 of the 5 admin signers acting through the timelock and not caught inside 48 hours.
- A hedger key, vol signer or paymaster signer compromise beyond the bounds stated in this file.
- A price move that neither the feed nor the reference shows yet, beyond the lag band (R14, below).
- An underlying that gaps past the point where a vault's collateral covers its debt: the loss falls to the insurance fund, the stake cover and the Governor, in that order.
- Loss of the value of a gear: a gear can lose value and a holder can lose their whole position; the toll lowers value every day by design.
- Failures of the venues the hedger trades on, or of USDG itself.
- Front-end phishing, a malicious RPC, or a user signing an intent they did not read.

## Privileged functions

Generated from `contracts/src` at the reviewed commit. The holder column is the intended holder at deployment; deploy scripts arrive with todo 11, so no holder is set on any chain yet. "Admin" below means `DEFAULT_ADMIN_ROLE` (or the contract owner for `ODPaymaster`), held by the Safe 3-of-5 through the 48 hour timelock. "Guardian" means `GUARDIAN_ROLE` held by the Safe 2-of-5, acting at once.

### Admin (timelock, 48 hours)

| Contract | Function | Can do | Cannot do, bounds |
| --- | --- | --- | --- |
| ODGovernor | `setMinter`, `setBacker` | Wire the minter and the backer once | Only while unset (`AlreadySet`); no zero address |
| ODGovernor | `setHedger` | Set the hedger wallet that receives USDG | Not the Governor itself, not zero |
| ODGovernor | `setDepositor` | Allow or deny an LP depositor | Not zero, not the Governor |
| ODGovernor | `setMarketGroup` | Put a market in a stress group | Group 0 to 2 |
| ODGovernor | `setParams` | Risk parameters (stress budget, exit-reserve floor, hedge limits, ages, shocks, withdraw delay) | Each field has a hard range: stress budget at most 50%, exit-reserve floor at most 50%, hedge equity at most 80%, hedge jump at most 50%, withdraw delay 1 hour to 30 days, hedge age 10 minutes to 1 day |
| ODGovernor | `skim` | Send USDG held above the books to the insurance fund | Cannot touch tracked cash or the exit reserve |
| ODGovernor | `postHedge` (as admin) | Post hedge equity without the hedger role | The per-window jump bound is skipped for the admin, so this is a timelocked action only |
| ODGovernor | `setBuysPaused(false)` | Unpause buys | Only the admin can unpause |
| ODMinter | `setHook`, `setStake` | Wire the hook (once) and the stake contract | Hook set once, must expose a non-zero pool manager |
| ODMinter | `setTradeParams` | Spread multipliers, closed-market extra, skew, total spread cap, minimum trade, usage cap, settle delay, lag band | Total spread at most 10%, closed extra at most 5%, lag band 1 to 300 bps, settle delay 7 to 365 days, minimum trade at most 1,000 USDG |
| ODMinter | `settleGear` | Settle a gear after a long halt or when out of domain | Reverts unless the gear is genuinely out of domain or halted; value is the last good price, floored at 1 unit |
| ODGearRegistry | `setMinter` | Wire the minter | Once |
| ODGearRegistry | `listGear` | List a gear | Spread and cap bounds checked; at most 12 gears per market and `MAX_GEARS` = 32 gears ever listed (settled gears still count) |
| ODGearRegistry | `setStatus` (any status except none) | Move a gear to any status | Settled is terminal |
| ODGearRegistry | `setParams` | Cap and spread of a gear | Spread within the min and max constants |
| ODOracleGuard | `setMarket` | Per-market feed, reference, bands and ages | Validates the feed, pool and ages against hard limits; zero market refused |
| ODOracleGuard | `setBuysPaused(false)` | Unpause a market and clear a continuity latch | Accepts the jumped price as the new last good price |
| ODVolOracle | `setSigner` | Rotate the vol signer | Invalidates unsubmitted posts of the old key |
| ODVolOracle | `setBounds` | Per-market sigma floor and ceiling | Inside the hard floor and ceiling constants |
| ODMarketHours | `setHolidays`, `setFallbackEnabled` | Holiday calendar and the fallback switch | At most 64 holidays, sorted, early closes inside the session |
| ODBacker | `setStake` | Point at the stake contract | None beyond the address |
| ODBacker | `setUplift` (as admin), `setMintPaused(false)` | Maintenance uplift; unpause vault mints | Uplift at most 20,000 bps and 3 days lead |
| ODInsurance | `setCoverers` | Set the Governor and backer that may draw cover | Each only while unset |
| ODFees | `setSplit`, `setOpsSplit` | Split of fees between buckets | Must sum to 10,000 bps |
| ODFees | `setRecipient` | Where a bucket pays | Governor and exit-reserve buckets must point at the Governor; zero holds the bucket |
| ODFees | `setFeeParams` | Spread share and toll fee | Each at most 3,000 bps |
| ODFees | `setNotifier` | Which contracts may notify fees | Not zero |
| ODBuyBurn | `setRoute`, `setPriceSource`, `setMaxUsdgPerCall` | Swap route, TWAP source and per-call size for the fee buy-and-burn | Slippage at most 2,000 bps; adapter and source must be contracts; cap above zero; zero source refuses every buy |
| ODStake | `setSlashRoute` | Route used to sell stake on a slash | Slippage at most 2,000 bps; contracts only; zero turns the sale off |
| ODStake | `setCoverCap`, `setTiers` | Cover cap; fee discount tiers | At most 4 tiers, ascending, discount at most 20% of the spread |
| ODStake | `setDepositsPaused(false)` | Unpause new stakes | Admin only |
| ODHook | `initializeGearPool` | Create the pool for a gear | Only path that can create a pool with this hook |
| ODPaymaster | `setSigner`, `setGuardian` | Rotate the signer and the guardian | Not zero |
| ODPaymaster | `setLimits` | Per-op, per-account and global daily gas caps | Per-op at most 0.05, account daily at most 0.5, global daily at most 10 (native units); per-op not above account not above global |
| ODPaymaster | `setKernelAccounts` | Which agent accounts are known | None beyond the list |
| ODPaymaster | `setPaused(false)` | Unpause | Owner only |
| ODPaymaster | `addStake`, `unlockStake`, `withdrawStake`, `withdrawTo` | Manage the gas deposit and entry-point stake | Moves only the paymaster's own native deposit; holds no user funds |

### Guardian (Safe 2-of-5, immediate, risk-reducing only)

| Contract | Function | Can do | Cannot do |
| --- | --- | --- | --- |
| ODGovernor | `setBuysPaused(true)` | Pause buys | Cannot unpause; sells and LP claims are not gated by this pause |
| ODOracleGuard | `setBuysPaused(market, true)` | Pause one market | Cannot unpause |
| ODGearRegistry | `setStatus` | Move a gear to buys-paused or sell-only, upward in risk order only | Cannot list, cannot lower the status, cannot settle |
| ODGearRegistry | `setParams` | Lower the cap, keep or widen the spread | Cannot raise a cap or narrow a spread |
| ODBacker | `setUplift` | Raise the uplift or its lead | Cannot lower it |
| ODBacker | `setMintPaused(true)` | Pause vault mints | Cannot unpause |
| ODStake | `setDepositsPaused(true)` | Pause new stakes | Cannot unpause; unstake and claim are unaffected |
| ODVolOracle | `revokeSigner` | Stop every vol post at once | Cannot set a signer; values already posted age into stale |
| ODPaymaster | `setPaused(true)` | Pause sponsorship | Cannot unpause |

### Keeper (crank key)

| Contract | Function | Can do | Cannot do, bounds |
| --- | --- | --- | --- |
| ODGovernor | `moveToExitReserve` | Move free cash into the exit reserve | Only up to tracked cash; cannot take from the reserve (the admin has the same call) |
| ODMarketHours | `setSessionsWithKinds` | Publish session windows | Windows are sorted, non-overlapping, each of bounded length, at most a bounded horizon ahead and a bounded count |
| ODBuyBurn | `execute` | Spend held USDG to buy and burn OVRD | Reverts (spends nothing) when the route or TWAP is missing, spot is off the TWAP, or output is under the floor; capped per call |

### Hedger key

| Contract | Function | Can do | Cannot do, bounds |
| --- | --- | --- | --- |
| ODGovernor | `sendToHedger` | Send USDG to the hedger wallet | Not above free cash; total hedge equity at most the hedge cap (at most 80% of equity); cannot touch the exit reserve |
| ODGovernor | `returnFromHedger` | Return USDG | Pulls from the caller only |
| ODGovernor | `postHedge` | Post hedge delta and equity per market | Timestamp not in the future and not older than the last post; per-window jump bound (see L-5) |

### Vol signer

| Contract | Function | Can do | Cannot do, bounds |
| --- | --- | --- | --- |
| ODVolOracle | `post` (signed) | Post sigma for a market | Clamped to the market's floor and ceiling; validity window bounded; replay-protected by nonce; revoked by the guardian |

### Module-gated (set once by the admin, then fixed)

| Contract | Functions | Caller |
| --- | --- | --- |
| ODGovernor | `onBuy`, `onSell`, `pay`, `onToll` | The minter only |
| ODGovernor | `onBackerMint`, `onBackerRepay`, `absorbLiquidation` | The backer only |
| ODGear | `mint`, `burn` | The minter only |
| ODInsurance | cover draws | The Governor or the backer only |
| ODStake | `slash` | The Governor or the backer only |
| ODStake | `notifyRewards` | The fee contract (`FEES_ROLE`) |
| ODMinter | hook callbacks, backer mint and burn | The hook; the backer |
| ODHook | pool callbacks | The PoolManager only |

All other state-changing functions (trade, queue fill and cancel, accrue, poke, claim, liquidation seal and execute, stake, unstake, `ODFees.sync`) are permissionless and act on the caller's own funds or on public state. `ODFees.sync()` books USDG that reached the fee contract without a notify into the next split; it can only move unbooked USDG into the buckets (post-deploy check: `isNotifier` is true for the Governor, the minter and the backer). `ODBacker.sealBatch` and `executeBatch` take at most `MAX_BATCH` = 50 vaults.

## Pause and unpause runbook

Who acts, in order, when something looks wrong. Names and phone numbers of the signers are kept in the private ops
file (never in this repository); this table names the roles. Fill the private file before the first deploy.

| Role | Does | Time |
| --- | --- | --- |
| On-call operator | Receives the alert (Telegram), checks the facts below, calls the guardian signers | Within 15 minutes of an alert |
| Guardian Safe, 2 of 5 | Pauses. Acts at once, no timelock | Within 1 hour of the operator's call |
| Admin Safe, 3 of 5 | Unpauses, and every other repair, through the 48 hour timelock | Schedule after a written cause; earliest execution 48 hours later |

### Alerts that start it (crank jobs, all read only)

| Alert | Job | What it means |
| --- | --- | --- |
| Timelock scheduled, executed or cancelled a call; code changed at the owner or guardian Safe | `admin-watch` | A role change or setter is coming or has happened |
| Buys paused or unpaused (scope, actor, reason) | `admin-watch` | A pause action was seen on chain |
| Hedge equity share, jump window net, stress and outflow limits | `risk-monitor` | Risk is outside its bounds |
| Oracle or volatility post stale | `vol-watch` | Prices cannot be trusted; the guard halts a market by itself |
| Keeper, hedger, liquidator or signer balance low | `gas-watch` | A bot will stop sending transactions |
| No heartbeat | `heartbeat` | The crank itself is down |

### To pause (guardian, immediate)

1. Confirm from chain, not from the alert text: read `pauseReason` on the Governor and the market status on `ODOracleGuard`.
2. Choose the narrowest switch that stops the harm. One market: `ODOracleGuard.setBuysPaused(market, true)`. All buys: `ODGovernor.setBuysPaused(true)`. Vault mints: `ODBacker.setMintPaused(true)`. New stakes: `ODStake.setDepositsPaused(true)`. Sponsorship: `ODPaymaster.setPaused(true)`. Bad vol posts: `ODVolOracle.revokeSigner`. A gear: `ODGearRegistry.setStatus` (buys paused, then sell only).
3. Post the transaction hash and the reason in the private ops channel and to the public status page.
4. Check that `admin-watch` raised the pause alert. If it did not, the alerting is broken: tell the operator.

### What stays open while paused

Exits never close. Sells and LP claims are not gated by any pause above (the Governor pause covers buys only, and stake unstake and claim are unaffected; the pause tests assert it). A pause stops new risk, it never traps funds. If an exit is blocked by a pause, that is a bug: pause nothing further and treat it as an incident.

### To unpause (admin, 48 hour timelock)

The guardian cannot unpause. Only the admin Safe can, through the timelock, so every unpause is visible for 48 hours first.

1. Write the cause and the fix (or the reason none is needed) in the incident note.
2. Admin Safe schedules the unpause call on the timelock. `admin-watch` alerts on the schedule.
3. Wait the full delay (48 hours). Anyone can watch the pending call; the guardian can pause again at once if the cause returns.
4. Execute. For `ODOracleGuard.setBuysPaused(market, false)` note that it clears the continuity latch and accepts the jumped price as the new last good price: check the price against two independent sources first.
5. Verify: the pause alert shows "unpaused", `pauseReason` reads clear, a small buy and a small sell quote succeed.
6. Close the incident note with the transaction hashes.

### Drills

Run the whole sequence on a fork before launch and after any role change: pause with the guardian, confirm the alert, confirm a sell still works, schedule and execute the unpause on a fast-forwarded timelock.

## Accepted risks

Known and accepted for the first release, stated generically:

- A trader with outside information can gain a bounded amount per round trip when neither the price feed nor the reference price has moved yet; the gear's cap bounds it.
- Quotes cannot see a token blocklist or pause on a recipient, or a failing fee transfer, so a trade can fall back to the queue.
- A backer vault minted at the minimum ratio can become sealable at a market reopen after a weekend if the reference price moves against it.
- Off-chain components (volatility signer, keeper, hedger) can be late; on-chain guards bound the effect of stale data but do not remove it.
- The system has not been audited.

### Known residuals

- **R14, oracle lag beyond the band.** The lag floor on the spread covers a price move inside the lag band. A move larger than the band that neither source shows yet pays a round trip. Measured on the minter for the RACE gear, gain per 10,000 USDG traded: 70.40 at a 75 bps move, 145.56 at 100, 449.90 at 200, 760.28 at 300 (before costs; bounded by the gear cap and the Governor's free cash). Alert: the crank `vol-watch` and `risk-monitor` jobs. The backer vault path now applies the same per-gear spread floor (`TradeParams.lagBandBps`, default 50 bps), so a round trip across a move inside the band never pays on either path; the backer leg beyond the band is bounded by the same floor (`audit/BackerLagRoundTrip.t.sol`). A pair gear is priced on the ratio of two markets, each of which may lag by its own band in opposite directions, so its floor is sized on the sum of both legs' bands (twice `lagBandBps`) on every path (minter, backer and hook): at the default 50 bps band the SPORT pair floor is 102 bps per side, and at the 300 bps maximum the largest pair floor is 1,062 bps (RACE). A round trip with an independent move per leg, each inside the band, never pays on any path (`audit/TwoLegLagRoundTrip.t.sol`, `poc/Rescore2PairLag.t.sol`; it paid +98.48 per 10,000 USDG before).
- **L-5, hedger key inflating NAV.** The hedge jump window anchors on cached equity minus hedge equity, so posts no longer compound: posting the top of the range every window with a permissionless `pokeRisk` between them moves equity by at most 5% of the hedge-free equity per `hedgeMaxAge` window. Measured: 16,000 bps of the starting equity after 24 hours of top-of-range posts (linear; it was 17,958 bps compounding), by `audit/HedgeWindowAnchor.t.sol : test_L5_WindowAnchorExcludesHedge`. No daily bound was added (it would need the 48 hour timelock to post a large real hedge move); accepted with this number. It needs the hedger key, which is separate from every other key; `maxHedgeEquityBps` caps total hedge equity and the guardian can pause buys. Alerts: hedge equity share of NAV, and the jump-window net per window (`risk-monitor` crank job).
- **L-7, hook route needs a seeded PoolManager (decision D26).** A swap through the hook needs the PoolManager to hold the input token. The owner Safe holds a small USDG seed and a small gear seed per launch gear as ERC-6909 claims in the PoolManager. Sizing rule: the largest single router swap equals the seed, so the seed per gear is set to the largest swap the owners accept to support through the hook, and the owner approves the figures at deploy. Swaps larger than the seed, or every swap if the seed is withdrawn, revert with `PoolManagerShort`; direct minter buys and sells are unaffected, so no funds are stuck. Alert: the seed balance per gear falling under its target.
- **L-6, claims under a stale hedge.** While any hedge post is stale, `claim(ticket, 0)` reverts `HedgeStale`; `claim(ticket, min)` with `min > 0` pays at the hedge-free low edge (the caller's minimum is their consent, and remaining LPs are never paid out of unseen hedge equity). The exit page never sends 0: it fills the minimum from `previewRedeem` of the ticket (the same low edge), capped by `freeCash`, less 0.5%. Holders selling and backers repaying are not affected.
- **L-2, USDG in transit to the hedger.** Unabsorbed for more than `hedgeMaxAge`, it makes `hedgeStale()` true (low edge without hedge equity, buys paused `HEDGE_STALE`). A residue up to 1 USDG (`TRANSIT_DUST`, for a venue deposit fee or rounding in the per-market split) never ages, and its clock clears, so a later send ages from its own time; transit above 1 USDG still ages, including sub-dust sends that add up past it (L-8, `poc/Rescore2Transit.t.sol`). At most 1 USDG can sit unabsorbed indefinitely; it counts as hedge equity in NAV. The posted hedge P&L in stress counts at most the book's own move per shock, so a hostile delta can at most double a market's unhedged stress (`audit/HedgeDeltaTransit.t.sol`).
- **L-1, total gear cap.** `ODGearRegistry.MAX_GEARS` = 32 gears ever listed (settled gears still count). `pokeRisk` and every LP deposit and claim walk all of them. Measured on the Robinhood Chain fork with every gear holding supply (`fork/GearCountGasFork.t.sol`): `pokeRisk` 0.38M at 1 gear, 5.98M at 20, 8.66M at 32; at 32 gears an LP deposit costs 4.94M and a claim 4.96M, each asserted under 10M. Raising the cap needs a new registry or a running book.
- **M-6, gas-starved liquidation.** `executeBatch` reverts `ExecuteOutOfGas` when less than `ODBacker.MIN_VAULT_GAS` (400,000) is left before a vault, or when a caught vault failure ran out of gas (1/32 rule, nested calls included), so a low gas limit can never skip a vault or an insurance draw. The batch is marked done only when every vault returned cleanly; a vault that fails for a real reason leaves the batch open until its TTL for another executor (a liquidated vault in that batch cannot withdraw its surplus until the batch is done or expired, at most 15 minutes). On mocks the lowest gas limit for a one-vault batch is 710,000 (`audit/GasStarvedExecute.t.sol`).
- **Batch size against the chain limit.** One transaction on Robinhood Chain (Arbitrum Orbit) is capped near 32M gas. The 400,000 floor is gas kept in hand before each vault, not gas spent per vault. Measured on the fork with every vault a deep crash that draws insurance (`fork/BatchGasFork.t.sol`), lowest execute gas limit: 0.65M for 1 vault, 2.24M for 10, 3.86M for 20, 5.47M for 30, 8.71M for 50 (about 165,000 per extra vault); sealing 50 costs 4.92M. A full `MAX_BATCH` of 50 seals and executes under 24M (asserted). The liquidator reads `MAX_BATCH` from the chain and caps a plan at 24M.
- **Low-severity items closed in fix round 2.** Fees that arrive without a notify are booked by `ODFees.sync()` (L-3, `fees/Fees.t.sol`); the agent router charges sells their USDG proceeds and backer actions their collateral plus mint proceeds against both the per-trade cap and the budget (L-4, `agent/AgentRouter.t.sol`).
- **F12-1, fee books on distribute (closed in fix round 3).** `ODFees.distribute` pays the Governor's share with `fundCash`, which settles the Governor's owed fees back to ODFees with `notify`. The payout measure netted that return, so the Governor bucket kept it as held while it was also pending, and ODFees booked more USDG than it held. `_pay` now counts USDG booked back as pending during the call as paid out, so the balance always covers pending plus held (`poc/FeeDoubleBook.t.sol`).

## Follow-ups

- NatSpec on every external function is not complete; the contracts are frozen, so it is a follow-up.
- Slither runs in CI with a triaged config (`contracts/SLITHER.md`); the 140 triaged results were read by class, not one by one. gitleaks also runs in CI.
- Mutation testing has not been measured.

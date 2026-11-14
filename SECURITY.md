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
| ODGearRegistry | `listGear` | List a gear | Spread and cap bounds checked; at most 12 gears per market |
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

All other state-changing functions (trade, queue fill and cancel, accrue, poke, claim, liquidation seal and execute, stake, unstake) are permissionless and act on the caller's own funds or on public state.

## Accepted risks

Known and accepted for the first release, stated generically:

- A trader with outside information can gain a bounded amount per round trip when neither the price feed nor the reference price has moved yet; the gear's cap bounds it.
- Quotes cannot see a token blocklist or pause on a recipient, or a failing fee transfer, so a trade can fall back to the queue.
- A backer vault minted at the minimum ratio can become sealable at a market reopen after a weekend if the reference price moves against it.
- Off-chain components (volatility signer, keeper, hedger) can be late; on-chain guards bound the effect of stale data but do not remove it.
- The system has not been audited.

### Known residuals

- **R14, oracle lag beyond the band.** The lag floor on the spread covers a price move inside the lag band. A move larger than the band that neither source shows yet pays a round trip. Measured on the minter for the RACE gear, gain per 10,000 USDG traded: 70.40 at a 75 bps move, 145.56 at 100, 449.90 at 200, 760.28 at 300 (before costs; bounded by the gear cap and the Governor's free cash). Alert: the crank `vol-watch` and `risk-monitor` jobs. The backer sale and buy-back path shares this exposure; its spread floor is tracked as a separate item.
- **L-5, hedger key compounding.** A hedger key can raise reported hedge equity by 5% of equity in one block, and by a factor of about 1.7958 over 24 hours (12 windows with a permissionless `pokeRisk` between them), with no assets behind it; a matured LP ticket is paid against that NAV. It needs the hedger key. Measured by `Rescore1Governor::test_Measure_M2ResidualCompoundsPerWindow`. Mitigations: the hedger key is separate from every other key, `maxHedgeEquityBps` caps total hedge equity, `postHedge` is watched by the `risk-monitor` crank job, and the guardian can pause buys. Alert on any hedge equity share above its expected level.
- **L-7, hook route needs a seeded PoolManager (decision D26).** A swap through the hook needs the PoolManager to hold the input token. The owner Safe holds a small USDG seed and a small gear seed per launch gear as ERC-6909 claims in the PoolManager. Sizing rule: the largest single router swap equals the seed, so the seed per gear is set to the largest swap the owners accept to support through the hook, and the owner approves the figures at deploy. Swaps larger than the seed, or every swap if the seed is withdrawn, revert with `PoolManagerShort`; direct minter buys and sells are unaffected, so no funds are stuck. Alert: the seed balance per gear falling under its target.
- **Stale hedge post blocks LP claims.** A hedger outage, or one forgotten market with a non-zero hedge, stops LP claims until a post arrives or the timelock acts. Holders selling and backers repaying are not affected.
- **Other low-severity items** (first-claim gas that grows with the number of listed gears, unbounded posted hedge delta in stress, fees stuck without a notify, agent budget skipping sells) are tracked in the audit-grade reports and are open at the reviewed commit.

## Follow-ups

- NatSpec on every external function is not complete; the contracts are frozen, so it is a follow-up.
- Static analysis (Slither) and a secret scanner are not yet in CI.
- Mutation testing has not been measured.

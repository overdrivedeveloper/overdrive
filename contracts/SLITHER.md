# Slither triage

Slither 0.11.6 runs over `contracts/src` (not `lib`, `test` or `script`) in CI and in `scripts/ci-local.sh`
(`scripts/slither.sh`). The run fails on any result that is not already triaged. Nothing here loosens another scanner.

## Files

| File | What it holds |
|---|---|
| `slither.config.json` | paths skipped, detectors excluded, `fail_on: pedantic` so any new result fails |
| `slither.db.json` | the 159 triaged results (id, check, reason). A change to a flagged function changes its id and the result comes back for a new read |

## Excluded detectors (style or by-design, whole class)

| Detector | Why |
|---|---|
| naming-convention, redundant-statements, unused-state, missing-inheritance | style only |
| timestamp | the toll, ageing windows, the calendar and oracle staleness are time based by design |
| assembly, low-level-calls | used on purpose in the oracle guard (gas capped staticcalls) and the math libraries |
| cyclomatic-complexity, shadowing-local, unindexed-event-address, events-maths | style or gas, no safety effect |
| costly-loop, cache-array-length, var-read-using-this | gas hints; batches are capped and gas is measured on the fork |
| uninitialized-local | zero is the intended starting value of every flagged local |

## Triaged results (kept in the db with the reason)

| Detector | Count | Reason |
|---|---|---|
| incorrect-equality | 33 | exact by construction (zero checks, counters), not donation sensitive |
| calls-loop | 28 | fixed audited callees, capped batch sizes |
| unused-return | 27 | callee reverts on failure or value re-read from storage |
| reentrancy-no-eth | 21 | `nonReentrant` on the entry points, ODFees `distribute`, `release` and `sync` are `nonReentrant` |
| divide-before-multiply | 13 | intentional fixed-point steps, covered by fuzz and invariants |
| missing-zero-check | 6 | zero is valid (optional feeds) or set by the deploy script and its post-deploy check |
| reentrancy-benign, reentrancy-events | 10 | no exploitable state, role gated or `nonReentrant` |
| return-bomb | 5 | gas capped staticcalls with a fixed word decode; failure halts the market |
| reentrancy-balance | 2 | `nonReentrant`, the stale balance only feeds a revert floor |
| weak-prng | 1 | `day % RING` is a ring buffer index |
| write-after-write | 1 | the first write is the intended clear |

Honest limit: the 142 results were read by class, with the Highs and the reentrancy findings checked against the source
(guards and ordering); each of the 142 was not traced by hand to a test. A reviewer should treat the db as a worklist,
not as a proof. Never add to the db to make a red run green without reading the new result.

Fix round 8 moved 93 results (the vault owner passed to the Governor's backer hooks, `paySell` and line shifts changed
their ids). 85 are the same findings on the same code and kept their reason; 8 were read again against the source:
`ODOracleGuard.liquidationBlock` (a zero check on the reference), the `ODBacker` repay, buy-back, mint and liquidation
writes after calls to the fixed minter and Governor (entry points `nonReentrant`), and the `ODGovernorRisk` insurance
draw (amount measured by balance, event after a call to the fixed ODInsurance). No new class of result.

Fix round 10 moved 25 results (line shifts in `ODOracleGuard` and `ODMinterPricing`; same findings on the same code,
reasons kept) and added one, read against the source: `unused-return` in `ODMinterPricing._fromPyth`, which needs only
the source flag of `ODOracleGuard.refPrice` (the price is already in the reading).
Fix round 11 moved 27 results (line shifts in `ODOracleGuard`, `ODMinter` and `ODCalendar`; each matched its old
entry word for word apart from line numbers, reasons kept) and added none. 151 triaged results, 0 open.
Shutdown helper (2026-11-16) added 8, each read against the source: `src/periphery/ODHookSeed.sol` (D26 seed helper for the owner
Safe): arbitrary `from` (the immutable owner Safe, owner-only entry), the unused `unlock` return, calls in the token loop, and
events after the previous iteration's calls. 159 triaged results, 0 open.

To re-triage: `cd contracts && slither . --config-file slither.config.json`, read the new results, then add them to the db.

## Inline exceptions in deployable source

Three `// slither-disable-next-line` comments sit in `contracts/src`, all one detector in one contract. Each is
read and justified here; `script/ci/slither-exceptions.py --check` (contracts job) fails when a disable line is
added, moved to another function or detector, or removed without this table changing. The comments stay inline
(rather than as `slither.db.json` entries) because the source in the audit tag already carries them, so moving
them would change the audited source for no safety gain.

| File | Function | Detector | Why it is safe |
|---|---|---|---|
| `src/agent/ODAgentRouter.sol` | `buyFor` | arbitrary-send-erc20 | `from` is `owner`, but `_active(owner)` first loads `_policies[owner][msg.sender]` and reverts without a live, unrevoked, unexpired policy the owner signed for this caller; `_requireGear` and `_charge` bound the market, per-trade cap and lifetime budget. The USDG pays the owner's own buy and the tokens go to `owner`; the call reverts if the router keeps any balance. Tests: `test/agent/AgentRouter.t.sol` `test_StrangerNoPolicy`, `test_Revoked`, `test_Expired`, `test_MarketNotAllowed`, `test_BudgetLifetime` |
| `src/agent/ODAgentRouter.sol` | `sellFor` | arbitrary-send-erc20 | Same policy gate, plus `canSell`; it pulls the owner's gear tokens only up to the owner's own approval, the minter pays `owner`, and the sell is charged against cap and budget (L-4). Tests: `test_L4_SellChargedAgainstCapAndBudget`, `testFuzz_L4_BudgetCoversEveryAction`, `test_StrangerNoPolicy` |
| `src/agent/ODAgentRouter.sol` | `backFor` | arbitrary-send-erc20 | Same policy gate, plus `canBack`; collateral only ever moves into a vault owned by `owner` (a new vault is opened for `owner`, an existing one must be `owner`'s and on the gear), and mint proceeds stay with the vault. Tests: `test_BackForRefusesOthersVault`, `test_BackCountsBudget` |

# Slither triage

Slither 0.11.6 runs over `contracts/src` (not `lib`, `test` or `script`) in CI and in `scripts/ci-local.sh`
(`scripts/slither.sh`). The run fails on any result that is not already triaged. Nothing here loosens another scanner.

## Files

| File | What it holds |
|---|---|
| `slither.config.json` | paths skipped, detectors excluded, `fail_on: pedantic` so any new result fails |
| `slither.db.json` | the 151 triaged results (id, check, reason). A change to a flagged function changes its id and the result comes back for a new read |

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
the source flag of `ODOracleGuard.refPrice` (the price is already in the reading). 151 triaged results, 0 open.

To re-triage: `cd contracts && slither . --config-file slither.config.json`, read the new results, then add them to the db.

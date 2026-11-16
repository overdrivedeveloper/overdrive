# Audit history (DOC-4)

**There is no outside audit.** The owner decided on 2026-11-15 to launch without one (decision D40): every round
below is an internal review, scored on a 10-point rubric across seven categories with
caps for open findings. An internal review is a strong pre-audit signal, not a substitute for a human audit
before large deposits. This is also stated in `SECURITY.md` (Accepted risks).

Commits are private dev repo shas; the public copy is made from them by a signed sync. The full reports stay
private; each finding they raised is listed by id in `SECURITY.md` (Known residuals) with its fix and tests.

## Audit tag

`audit-2026-11-15` is on private commit `96d4225e91c3b7a2a9ad236660b7f53d32e0ec83`, the commit both final graders
read (rescore 9 and independent 9). The one open Medium found there, I9-3 (a sell quoted below the hook seed on
the direct minter path), was fixed in the API at `c2c0d97` with a test. Since the tag, `contracts/src` has changed
only by NatSpec comments: `git diff audit-2026-11-15 -- contracts/src`.

## Rounds

"Rescore" rounds are graded by the same grader against the fixes; "independent" rounds by a separate grader who
had not read the internal reports before writing findings.

| Date | Round | Commit | Grade (of 10) | Note |
| --- | --- | --- | --- | --- |
| 2026-11-13 | early (quick) | `30fceca` | 4.4 | first run, no High or Critical |
| 2026-11-14 | rescore 1 | `f2fa004` | 5.7 | |
| 2026-11-14 | rescore 2 | `2923f09` | 7.8 | |
| 2026-11-14 | rescore 3 | `f50602d` | 9.2 provisional | disputed by independent 3 |
| 2026-11-14 | independent 3 | `f50602d` | 8.2 | new Medium M-7, reproduced, fixed in round 5 |
| 2026-11-14 | rescore 4 | `c712825` | 8.4 | |
| 2026-11-14 | independent 4 | `c712825` | 7.4 | two open Mediums |
| 2026-11-14 | rescore 5 | `ef2f5f9` | 6.0 capped (7.7 before caps) | |
| 2026-11-14 | independent 5 | `ef2f5f9` | 7.8 | |
| 2026-11-15 | independent 6 | `1ac8bf9` | 8.1 | |
| 2026-11-15 | rescore 7 | `98a6c12` | 8.9 | |
| 2026-11-15 | independent 7 | `98a6c12` | 8.3 | |
| 2026-11-15 | rescore 8 | `5a4c9e7` | 8.8 | |
| 2026-11-15 | independent 8 | `5a4c9e7` | 8.6 | |
| 2026-11-15 | rescore 9 | `96d4225` | 8.9 | final, at the tag |
| 2026-11-15 | independent 9 | `96d4225` | 8.9 | final, at the tag; one open Medium (I9-3) capped it, fixed at `c2c0d97` |

Between rounds there were eleven fix rounds; each fix shipped with a failing-then-passing test. Mutation testing on
the tagged commit: `mutation.md` (90.6%, 126 of 139). The owner's launch bar for this project was 8.9 with no open
High (recorded 2026-11-15).

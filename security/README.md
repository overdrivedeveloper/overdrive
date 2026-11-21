# Public audit evidence

Everything here ships in the public copy. Commits are private dev repo shas.

| File | What | Status |
| --- | --- | --- |
| `AUDITS.md` | Every internal review round, commit and grade; the audit tag; no outside audit (D40) | current |
| `mutation.md` | Mutation testing on the tagged commit: killed / total per contract, every survivor triaged | 2026-11-15 |
| `coverage.md` | Line, branch and function coverage of `contracts/src`, and the floor CI holds | recorded |
| `halmos.md` | Halmos symbolic checks run log (.github/scripts/formal.sh, bounded, outside ci-local) | not recorded yet |
| `live-check.md` | Post-deploy, bytecode and Sourcify checks of the live deployment | pending: bytecode compare not recorded yet |
| `post-deploy-mainnet.txt` | `PostDeployCheck.s.sol` result on mainnet (4663), written by `app/scripts/deploy-mainnet.sh` | PASS, 2026-11-21 |
| `sourcify-mainnet.txt` | Sourcify status of the 18 mainnet contracts, written by `stage_sourcify` | `match` (partial) for all 18, 2026-11-21 |

Related files outside this folder: `SECURITY.md` (roles, accepted risks, stale inputs), `contracts/ROLES.md`
(role holders), `contracts/SLITHER.md` (static analysis triage and inline exceptions), `contracts/AUDIT-SCOPE.md`.

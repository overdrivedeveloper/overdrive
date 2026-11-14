# Fork stack config

`deploy.fork.json` is an overlay on `contracts/script/config/fork.json` (the todo 11 fork deploy config, which is used
unchanged apart from the roles). `setup.ts --config` writes `$FORK_DIR/deploy-config.json` from the two.

| Key | Meaning |
|---|---|
| `roles` | Deploy role -> the anvil dev account part that plays it (`lib.ts` `ROLE_INDEX`): ownerSafe = owner (account 1), guardianSafe = guardian (2), keeper = crank (3), hedger (4), volSigner (5), paymasterSigner (6), treasury (7). The deployer is account 0. |
| `usdgHolder` | The real mainnet USDG holder `fund.ts` impersonates (an EOA, never the v4 PoolManager). Found 2026-11-14 from USDG `Transfer` logs of the last 3000 blocks, then `balanceOf` and `codesize`: 22.5M USDG, code size 0. Balances move; if `fund.ts` says "holder has only", pick another the same way. |
| `relaxations` | Values for the fork-only oracle relaxations R5.1 to R5.3 (`setup.ts` `RELAXATIONS`), applied through the timelock. |
| `warm.codeOnly` | Contracts whose code the run needs but no mutable state (Permit2, EntryPoint, Multicall3, CreateX). |

Nothing here is a key or a secret. The throwaway keystores and their password live in `$FORK_DIR/keys` (mode 600),
outside the repository, and are deleted by `reset.sh`.

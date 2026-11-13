# Vendored dependencies

Installed without git metadata (shallow clone, `.git` removed). Compiler: solc 0.8.26, evm cancun, via_ir.

| Library | Tag | Commit |
|---|---|---|
| openzeppelin-contracts | v5.4.0 | c64a1edb67b6e3f4a15cca8909c9482ad33a02b0 |
| openzeppelin-contracts-upgradeable | v5.4.0 | e725abddf1e01cf05ace496e950fc8e243cc7cab |
| forge-std | v1.9.7 | 77041d2ce690e692d6e03cc812b57d1ddaa4d505 |
| v4-core | v4.0.0 (newest release tag) | e50237c43811bd9b526eff40f26772152a42daba |
| v4-periphery | none published; default branch head | c6e4754dab11bd38c6f08ac51c3c868569e93d64 |
| permit2 (needed by v4-periphery) | none; default branch head | cc56ad0f3439c502c246fc5cfcc3db92bb8b7219 |
| solmate (v4-core dependency; its submodule) | none; default branch head | 89365b880c4f3c786bdd453d4b8e8fe410344a69 |
| prb-math | v4.1.0 | 280fc5f77e1b21b9c54013aac51966be33f4a410 |

v4-periphery's nested `lib/` was removed; its dependencies resolve through remappings to the copies above.

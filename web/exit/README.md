# Overdrive exit page

One static HTML file that lets a wallet holder get out of Overdrive with no Overdrive website and no Overdrive API.
It talks only to the user's own wallet (`window.ethereum`, EIP-1193) and the contracts on chain 4663. It makes no
network request of its own, loads nothing from a CDN, and has no analytics. Open it from disk, from IPFS, or from
any static host.

What it does:

| Section | Contract call |
|---|---|
| Read gear balances, reference value | `gear.balanceOf`, `ODMinter.valuePerToken`, `ODMinter.quote` |
| Sell gears | `ODMinter.sell(gearId, tokensIn, minUsdgOut, recipient, deadline)` |
| Sell when the market is closed, or `sell` returns `UseQueue` | `ODMinter.queueSell(gearId, tokens, minUsdgOut, recipient)` |
| Claim or cancel a queued sell | `ODMinter.fillQueued(ticket)`, `ODMinter.cancelQueued(ticket)` |
| Governor withdrawal | `ODGovernor.requestWithdraw(shares)`, then `ODGovernor.claim(ticket, minAssetsOut)`. The minimum is never 0 (the Governor refuses a zero minimum while the hedge report is late); the page fills it from `previewRedeem` of the ticket, capped by `freeCash`, less 0.5%, and you check it before sending |
| Backer vaults | `ODBacker.repay(vaultId, tokens)`, `ODBacker.withdraw(vaultId, usdg, to)` |

Every send is simulated with `eth_call` first. If the contract would refuse, the page decodes the custom error from
the embedded ABIs and says why in plain words (for example, `UseQueue` points you to Queue sell). Your wallet still
shows the final transaction.

Gear holders are never liquidated. Backer vaults can be: the page says so next to the vault controls.

## Layout

```
web/exit/lib.cjs       pure module: keccak256, ABI encode/decode, revert decoding, call builders (no DOM, no network)
web/exit/app.js        the page's UI script (wallet, reads, sends)
web/exit/page.html     template with the styles; no external references
web/exit/build.mjs     node build script (no network): embeds addresses and ABIs, prints the sha256
web/exit/test/         node tests, plus a small mock contract for the anvil test
web/exit/dist/         build output (git-ignored): overdrive-exit.html and overdrive-exit.html.sha256
```

## Build

```
node web/exit/build.mjs                      # mainnet: reads app/deployments/mainnet.json
node web/exit/build.mjs --deployment anvil --allow-incomplete   # test page, shows a TEST BUILD banner
```

Addresses come from `app/deployments/<name>.json` and ABIs from `app/src/abi/*.json`. A mainnet page needs chainId
4663 and the `ODMinter`, `ODGovernor` and `ODBacker` addresses, `external.usdg`, and at least one gear with a token
address and a bytes32 id. If any is missing the build stops and writes nothing. `--allow-incomplete` is refused for
mainnet. Until the mainnet deployment file exists, `node web/exit/build.mjs` fails on purpose.

The build prints, and writes next to the file, the sha256 of the page. The output has no timestamps, so the same
inputs always give the same hash.

## Verify a published copy

```
shasum -a 256 overdrive-exit.html      # must equal the hash in the release notes and in overdrive-exit.html.sha256
```

Better: check out the tagged commit, run `node web/exit/build.mjs`, and compare the hash you built with the published one.
Also compare the address table at the top of the page with the deployment file.

## Use from disk

1. Save `overdrive-exit.html` and open it in a browser that has a wallet extension. Some wallets only inject into
   `http` or `https` pages. If yours does not work from `file://`, run `python3 -m http.server` in the folder and open
   `localhost`, or use the IPFS copy.
2. Press Connect. If the wallet is on another network press Switch network. If the wallet does not know Robinhood
   Chain (4663), add it in the wallet's network settings first.
3. The page lists your queued sells, withdrawal tickets and vaults by reading the chain log from the deployment's
   start block. If your wallet's node limits log reads, type the ticket or vault number into the box.

## Tests

```
node --test web/exit/test/exit.test.mjs
```

Covers: keccak and selectors against `cast`, every needed selector, event topic and error present in the built page,
no external URL or network API in the page, mainnet build refusal, deterministic hash, plain-English refusals, a stub
DOM load, and (when `anvil` and `forge` are installed) a local chain where the page's own encoders run one sell,
one queued sell, one Governor claim, one refusal, one repay and one collateral withdrawal against a mock contract.
Set `RHC_RPC_URL` to run the same test on a fork.

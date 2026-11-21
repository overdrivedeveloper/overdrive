#!/usr/bin/env python3
"""Keep the README's "### Deployment" section equal to app/deployments/<chain>.json (the files the services read).

    python3 .github/scripts/readme-deployments.py           # rewrite the section body in README.md
    python3 .github/scripts/readme-deployments.py --check   # CI: exit 1 if README.md differs from the files

The section is the text between the `### Deployment` heading and the next heading. Only chain files count
(mainnet.json or 4663.json, testnet.json or 46630.json); anvil.json is the local record and is never published. A chain is
listed once its file names at least one contract address. With none, the section reads "Not deployed yet". After a
deploy, run it without --check and commit README.md together with the deployment file.

When security/sourcify-<network>.txt exists (written by the deploy script: `<name> <address> <status>` per line), the
table gains a Sourcify column with the status and a link per address, and lists the verified contracts the record does
not name (libraries, the gear implementation) below the record's own rows.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "app" / "deployments"
README = ROOT / "README.md"
HEADING = "### Deployment\n"
NOT_DEPLOYED = ("Not deployed yet. No addresses are published. This section will list them from "
                "`app/deployments/<chain>.json` once the contracts are live.")
# The deploy scripts write mainnet.json and testnet.json (app/scripts/deploy-*.sh); a numeric name works too.
FILE_CHAIN = {"mainnet": 4663, "testnet": 46630}
NAMES = {4663: "Robinhood Chain mainnet", 46630: "Robinhood Chain testnet"}
EXPLORERS = {4663: "https://robinhoodchain.blockscout.com", 46630: "https://explorer.testnet.chain.robinhood.com"}
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
SOURCIFY_REPO = "https://repo.sourcify.dev"
NETWORK_NAME = {v: k for k, v in FILE_CHAIN.items()}


def sourcify(chain):
    """[(name, address, status)] from security/sourcify-<network>.txt, or None when the file is absent."""
    path = ROOT / "security" / f"sourcify-{NETWORK_NAME.get(chain, chain)}.txt"
    if not path.exists():
        return None
    out = []
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) == 3 and ADDRESS.match(parts[1]):
            out.append((parts[0], parts[1], parts[2]))
    return out


def chains():
    out = []
    for path in sorted(DEPLOY.glob("*.json")):
        stem = str(FILE_CHAIN.get(path.stem, path.stem))
        if not re.fullmatch(r"\d+", stem):
            continue
        d = json.loads(path.read_text())
        if int(d.get("chainId", -1)) != int(stem):
            sys.exit(f"{path.relative_to(ROOT)}: chainId {d.get('chainId')} does not match the file name")
        if any(isinstance(a, str) and a for a in (d.get("contracts") or {}).values()):
            out.append((int(stem), path, d))
    return out


def link(addr, chain):
    if not ADDRESS.match(addr):
        sys.exit(f"chain {chain}: '{addr}' is not an address")
    base = EXPLORERS.get(chain)
    return f"[`{addr}`]({base}/address/{addr})" if base else f"`{addr}`"


def section(chain, path, d):
    rel = path.relative_to(ROOT).as_posix()
    name = NAMES.get(chain, f"chain {chain}")
    verified = sourcify(chain)
    status = {a.lower(): st for _, a, st in (verified or [])}

    def row(label, addr):
        if verified is None:
            return f"| {label} | {link(addr, chain)} |"
        st = status.get(addr.lower())
        cell = f"[{st}]({SOURCIFY_REPO}/{chain}/{addr})" if st else "n/a"
        return f"| {label} | {link(addr, chain)} | {cell} |"

    rows = [
        f"**{name} (`{chain}`)**, deployed at block {int(d['startBlock']):,} from commit `{d['commit']}`. "
        f"Every address is in [`{rel}`]({rel}).",
        "",
        "| Contract | Address |" if verified is None else "| Contract | Address | Sourcify |",
        "| --- | --- |" if verified is None else "| --- | --- | --- |",
    ]
    seen = set()
    for cname, addr in (d.get("contracts") or {}).items():
        if addr:
            rows.append(row(f"`{cname}`", addr))
            seen.add(addr.lower())
    for g in d.get("gears") or []:
        rows.append(row(f"gear `{g['symbol']}`", g["token"]))
        seen.add(g["token"].lower())
    admin = d.get("admin") or {}
    for key, label in (("timelock", "Timelock"), ("ownerSafe", "Owner Safe"), ("guardianSafe", "Guardian Safe")):
        if admin.get(key) and int(admin[key], 16) != 0:
            rows.append(row(label, admin[key]))
            seen.add(admin[key].lower())
    for vname, addr, _ in verified or []:
        if addr.lower() not in seen:
            rows.append(row(f"`{vname}`", addr))
            seen.add(addr.lower())
    if verified:
        counts = {}
        for _, _, st in verified:
            counts[st] = counts.get(st, 0) + 1
        summary = ", ".join(f"`{st}` for {n}" for st, n in sorted(counts.items()))
        rows += ["", f"Sourcify verification ({len(verified)} contracts): {summary}. `match` is a partial match: the "
                 "deployed bytecode matches the source, the metadata hash does not (`exact_match` would mean both do). "
                 "The Safes are Safe's own audited contracts and are not verified here."]
    return rows


def render():
    found = chains()
    if not found:
        return NOT_DEPLOYED + "\n"
    out = []
    for chain, path, d in found:
        out += section(chain, path, d) + [""]
    out.append("This section is generated from the files (`python3 .github/scripts/readme-deployments.py`).")
    return "\n".join(out) + "\n"


def main():
    text = README.read_text()
    if text.count(HEADING) != 1:
        sys.exit(f"README.md must have exactly one '{HEADING.strip()}' heading")
    head, rest = text.split(HEADING, 1)
    m = re.search(r"^#{1,6} ", rest, re.M)
    if not m:
        sys.exit("README.md: no heading after the Deployment section")
    body, tail = rest[: m.start()], rest[m.start():]
    new = head + HEADING + "\n" + render() + "\n" + tail
    if "--check" in sys.argv:
        if new != text:
            sys.exit("README.md deployment section differs from app/deployments: run python3 .github/scripts/readme-deployments.py")
        print("README deployment section matches app/deployments")
        return
    README.write_text(new)
    print("README deployment section rewritten from app/deployments")


if __name__ == "__main__":
    main()

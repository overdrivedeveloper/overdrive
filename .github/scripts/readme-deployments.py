#!/usr/bin/env python3
"""Keep the README's "### Deployment" section equal to app/deployments/<chain>.json (the files the services read).

    python3 .github/scripts/readme-deployments.py           # rewrite the section body in README.md
    python3 .github/scripts/readme-deployments.py --check   # CI: exit 1 if README.md differs from the files

The section is the text between the `### Deployment` heading and the next heading. Only numeric chain files count
(4663.json for mainnet, 46630.json for testnet); anvil.json is the local record and is never published. A chain is
listed once its file names at least one contract address. With none, the section reads "Not deployed yet". After a
deploy, run it without --check and commit README.md together with the deployment file.
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
NAMES = {4663: "Robinhood Chain mainnet", 46630: "Robinhood Chain testnet"}
EXPLORERS = {4663: "https://robinhoodchain.blockscout.com", 46630: "https://explorer.testnet.chain.robinhood.com"}
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def chains():
    out = []
    for path in sorted(DEPLOY.glob("*.json")):
        if not re.fullmatch(r"\d+", path.stem):
            continue
        d = json.loads(path.read_text())
        if int(d.get("chainId", -1)) != int(path.stem):
            sys.exit(f"{path.relative_to(ROOT)}: chainId {d.get('chainId')} does not match the file name")
        if any(isinstance(a, str) and a for a in (d.get("contracts") or {}).values()):
            out.append((int(path.stem), path, d))
    return out


def link(addr, chain):
    if not ADDRESS.match(addr):
        sys.exit(f"chain {chain}: '{addr}' is not an address")
    base = EXPLORERS.get(chain)
    return f"[`{addr}`]({base}/address/{addr})" if base else f"`{addr}`"


def section(chain, path, d):
    rel = path.relative_to(ROOT).as_posix()
    name = NAMES.get(chain, f"chain {chain}")
    rows = [
        f"**{name} (`{chain}`)**, deployed at block {int(d['startBlock']):,} from commit `{d['commit']}`. "
        f"Every address is in [`{rel}`]({rel}).",
        "",
        "| Contract | Address |",
        "| --- | --- |",
    ]
    for cname, addr in (d.get("contracts") or {}).items():
        if addr:
            rows.append(f"| `{cname}` | {link(addr, chain)} |")
    for g in d.get("gears") or []:
        rows.append(f"| gear `{g['symbol']}` | {link(g['token'], chain)} |")
    admin = d.get("admin") or {}
    for key, label in (("timelock", "Timelock"), ("ownerSafe", "Owner Safe"), ("guardianSafe", "Guardian Safe")):
        if admin.get(key) and int(admin[key], 16) != 0:
            rows.append(f"| {label} | {link(admin[key], chain)} |")
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

#!/usr/bin/env python3
"""Repository hygiene gate (CI and scripts/ci-local.sh). Prints one FAIL line per problem and exits 1 on any:

  - dependencies: exact versions (no ^, ~, ranges, tags) in every Bun package (app/, sdk/, mcp/, and web/ or exit/
    when they have a package.json); a committed bun.lock and a bunfig.toml minimumReleaseAge guard in each;
    install hooks that run `bun install` use --frozen-lockfile;
  - Solidity: deployable contracts in contracts/src use a fixed pragma (`pragma solidity 0.8.x;`); interfaces and
    shared libraries may keep a range;
  - runtimes: bun, node, python and foundry are pinned exactly in CI (workflow env), `.tool-versions`, `.python-version`
    and the `packageManager` / `engines` fields of app, sdk and mcp, and all of them agree;
  - CI: every `uses:` in .github/workflows is pinned to a full commit SHA, and every workflow sets `permissions:`.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXACT = re.compile(r"^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|file:.+|workspace:.+|link:.+)$")
PACKAGES = ("app", "sdk", "mcp", "web", "exit")
OPTIONAL = ("web", "exit")  # checked only when the folder has a package.json
problems = []


def bad(msg):
    problems.append(msg)


# ---- dependencies
for pkg_dir in PACKAGES:
    d = ROOT / pkg_dir
    if not (d / "package.json").exists():
        if pkg_dir not in OPTIONAL:
            bad(f"{pkg_dir}/package.json is missing")
        continue
    pkg = json.loads((d / "package.json").read_text())
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name, spec in pkg.get(section, {}).items():
            if section == "peerDependencies":
                continue  # a library's peer range is a compatibility statement, not an install
            if not EXACT.match(spec):
                bad(f"{pkg_dir}/package.json: {name} is '{spec}', pin an exact version")
    for script, cmd in pkg.get("scripts", {}).items():
        if script in ("postinstall", "preinstall", "install", "prepare") and "bun install" in cmd and "--frozen-lockfile" not in cmd:
            bad(f"{pkg_dir}/package.json: {script} runs a non-frozen bun install")
    has_deps = any(pkg.get(s) for s in ("dependencies", "devDependencies", "optionalDependencies"))
    if has_deps and not (d / "bun.lock").exists():
        bad(f"{pkg_dir}/bun.lock is missing (commit the lockfile)")
    bunfig = d / "bunfig.toml"
    if has_deps and (not bunfig.exists() or not re.search(r"^\s*minimumReleaseAge\s*=\s*[1-9]\d*", bunfig.read_text(), re.M)):
        bad(f"{pkg_dir}/bunfig.toml: set [install] minimumReleaseAge")

# ---- fixed pragmas on deployable contracts (interfaces and libraries are compiled into other contracts)
RANGE_OK = ("contracts/src/interfaces/", "contracts/src/libs/")
for sol in sorted((ROOT / "contracts" / "src").rglob("*.sol")):
    rel = sol.relative_to(ROOT).as_posix()
    if rel.startswith(RANGE_OK):
        continue
    m = re.search(r"^\s*pragma solidity ([^;]+);", sol.read_text(), re.M)
    if not m:
        bad(f"{rel}: no pragma")
    elif not re.fullmatch(r"0\.8\.\d+", m.group(1).strip()):
        bad(f"{rel}: floating pragma '{m.group(1).strip()}', use a fixed version")

# ---- GitHub Actions pinned by SHA, permissions set
for wf in sorted((ROOT / ".github" / "workflows").glob("*.y*ml")):
    text = wf.read_text()
    rel = wf.relative_to(ROOT).as_posix()
    if not re.search(r"^permissions:", text, re.M):
        bad(f"{rel}: no top-level permissions:")
    for line_no, line in enumerate(text.splitlines(), 1):
        m = re.match(r"\s*-?\s*uses:\s*([^\s#]+)", line)
        if m and not m.group(1).startswith("./") and not re.search(r"@[0-9a-f]{40}$", m.group(1)):
            bad(f"{rel}:{line_no}: action '{m.group(1)}' is not pinned to a commit SHA")

# ---- runtime pins agree everywhere
ci_text = (ROOT / ".github" / "workflows" / "ci.yml").read_text()


def ci_env(name):
    m = re.search(rf'^\s*{name}:\s*"?v?([0-9][^"\s]*)"?\s*$', ci_text, re.M)
    if not m:
        bad(f"ci.yml: env {name} is missing or not an exact version")
        return None
    return m.group(1)


pins = {"bun": ci_env("BUN_VERSION"), "nodejs": ci_env("NODE_VERSION"), "python": ci_env("PYTHON_VERSION"), "foundry": ci_env("FOUNDRY_VERSION")}
for tool, ver in pins.items():
    if ver and not re.fullmatch(r"\d+\.\d+\.\d+", ver):
        bad(f"ci.yml: {tool} '{ver}' is not an exact x.y.z version")
tv = {}
tv_file = ROOT / ".tool-versions"
if tv_file.exists():
    for line in tv_file.read_text().split("\n"):
        parts = line.split()
        if len(parts) == 2:
            tv[parts[0]] = parts[1]
else:
    bad(".tool-versions is missing")
for tool, ver in pins.items():
    if ver and tv.get(tool) != ver:
        bad(f".tool-versions: {tool} is '{tv.get(tool)}', ci.yml says '{ver}'")
py_file = ROOT / ".python-version"
if not py_file.exists() or py_file.read_text().strip() != pins["python"]:
    bad(f".python-version must be {pins['python']} (as in ci.yml)")
for pkg_dir in ("app", "sdk", "mcp"):
    pj = ROOT / pkg_dir / "package.json"
    if not pj.exists():
        continue
    pkg = json.loads(pj.read_text())
    if pkg.get("packageManager") != f"bun@{pins['bun']}":
        bad(f"{pkg_dir}/package.json: packageManager must be bun@{pins['bun']}")
    eng = pkg.get("engines", {})
    if eng.get("bun") != pins["bun"]:
        bad(f"{pkg_dir}/package.json: engines.bun must be {pins['bun']}")
    if pkg_dir != "mcp" and eng.get("node") != pins["nodejs"]:  # mcp is a published CLI: its node range is for consumers
        bad(f"{pkg_dir}/package.json: engines.node must be {pins['nodejs']}")
    if pkg_dir == "mcp" and "node" not in eng:
        bad("mcp/package.json: engines.node is missing")

for p in problems:
    print(f"FAIL {p}")
if problems:
    sys.exit(f"{len(problems)} hygiene problem(s)")
print("hygiene: dependencies pinned and frozen, pragmas fixed, actions pinned, runtimes pinned")

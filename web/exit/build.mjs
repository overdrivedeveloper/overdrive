// Builds web/exit/dist/overdrive-exit.html: ONE self-contained file (no server, no CDN, no API calls) that lets a wallet
// holder sell gears, claim queued sells and Governor tickets, and repay or withdraw as a backer, straight from the
// contracts. Addresses and ABIs are embedded from app/deployments/<name>.json and app/src/abi/*.json.
// Usage: node web/exit/build.mjs [--deployment mainnet|anvil|<path>] [--allow-incomplete] [--out <file>]
// No network. Prints the sha256 of the file so it can be published and checked.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const require = createRequire(import.meta.url);
const lib = require("./lib.cjs");

const NEEDED = {
  minter: { file: "IODMinter", fns: ["sell", "queueSell", "fillQueued", "cancelQueued", "queuedSell", "quote", "valuePerToken", "ticketCount"], events: ["SellQueued"] },
  governor: { file: "IODGovernor", fns: ["claim", "requestWithdraw", "ticketOf", "balanceOf", "decimals", "symbol", "convertToAssets", "canPay", "previewRedeem", "hedgeStale", "freeCash"], events: ["WithdrawalQueued"] },
  backer: { file: "IODBacker", fns: ["repay", "withdraw", "vault", "health", "tollFeeOwed"], events: ["VaultOpened"] },
  gear: { file: "IODGear", fns: ["balanceOf", "decimals", "symbol"], events: [] },
};
const REQUIRED_ADDR = ["ODMinter", "ODGovernor", "ODBacker"];
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a);

export function buildPage({ deployment, abiDir = join(repo, "app/src/abi"), allowIncomplete = false }) {
  const d = deployment;
  const problems = [];
  const mainnet = d.network === "mainnet";
  if (mainnet && d.chainId !== 4663) problems.push(`mainnet deployment must have chainId 4663, has ${d.chainId}`);
  if (allowIncomplete && mainnet) problems.push("--allow-incomplete is not allowed for a mainnet page");
  for (const k of REQUIRED_ADDR) if (!isAddr(d.contracts?.[k])) problems.push(`contracts.${k} is missing or not an address`);
  if (!isAddr(d.external?.usdg)) problems.push("external.usdg is missing or not an address");
  if (!Array.isArray(d.gears) || d.gears.length === 0) problems.push("gears is empty");
  else d.gears.forEach((g, i) => { if (!isAddr(g.token) || !/^0x[0-9a-fA-F]{64}$/.test(g.id || "")) problems.push(`gears[${i}] needs a token address and a bytes32 id`); });
  const warnings = [];
  if (problems.length) {
    if (mainnet || !allowIncomplete) throw new Error("exit page refused:\n  - " + problems.join("\n  - "));
    warnings.push(...problems);
  }

  const abis = {};
  const errors = new Map();
  for (const f of readdirSync(abiDir).filter((x) => /^IOD.*\.json$/.test(x))) {
    for (const e of JSON.parse(readFileSync(join(abiDir, f), "utf8"))) if (e.type === "error") errors.set(lib.selectorOf(e), { type: "error", name: e.name, inputs: e.inputs.map(({ name, type, components }) => ({ name, type, components })), sel: lib.selectorOf(e) });
  }
  for (const [key, spec] of Object.entries(NEEDED)) {
    const abi = JSON.parse(readFileSync(join(abiDir, spec.file + ".json"), "utf8"));
    abis[key] = [];
    for (const name of spec.fns) {
      const fr = abi.find((x) => x.type === "function" && x.name === name);
      if (!fr) throw new Error(`ABI ${spec.file} has no function ${name}`);
      abis[key].push({ type: "function", name, inputs: fr.inputs, outputs: fr.outputs, sel: lib.selectorOf(fr) });
    }
    for (const name of spec.events) {
      const ev = abi.find((x) => x.type === "event" && x.name === name);
      if (!ev) throw new Error(`ABI ${spec.file} has no event ${name}`);
      abis[key].push({ type: "event", name, inputs: ev.inputs, topic: lib.topicOf(ev) });
    }
  }
  const data = {
    chainId: d.chainId, network: d.network, commit: d.commit, deployedAt: d.deployedAt, startBlock: d.startBlock,
    complete: problems.length === 0,
    addr: { ODMinter: d.contracts?.ODMinter || "", ODGovernor: d.contracts?.ODGovernor || "", ODBacker: d.contracts?.ODBacker || "", USDG: d.external?.usdg || "" },
    gears: (d.gears || []).map((g) => ({ id: g.id, symbol: g.symbol, power: g.power, token: g.token })),
    abis, errors: [...errors.values()],
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const safe = (s) => s.replace(/<\/script/gi, "<\\/script");
  let html = readFileSync(join(here, "page.html"), "utf8");
  const parts = { "/*__LIB__*/": safe(readFileSync(join(here, "lib.cjs"), "utf8")), "/*__APP__*/": safe(readFileSync(join(here, "app.js"), "utf8")), "/*__DATA__*/": json };
  for (const [k, v] of Object.entries(parts)) { if (!html.includes(k)) throw new Error("template lacks " + k); html = html.replace(k, () => v); }
  const sha256 = createHash("sha256").update(html).digest("hex");
  return { html, sha256, warnings, data };
}

export function loadDeployment(name) {
  const p = existsSync(name) ? name : join(repo, "app/deployments", name + ".json");
  if (!existsSync(p)) throw new Error(`no deployment file ${p}. Mainnet addresses do not exist yet; build with --deployment anvil --allow-incomplete for a test page.`);
  return JSON.parse(readFileSync(p, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const arg = (k, def) => (a.includes(k) ? a[a.indexOf(k) + 1] : def);
  try {
    const dep = loadDeployment(arg("--deployment", "mainnet"));
    const r = buildPage({ deployment: dep, allowIncomplete: a.includes("--allow-incomplete") });
    const out = resolve(arg("--out", join(here, "dist", "overdrive-exit.html")));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, r.html);
    writeFileSync(out + ".sha256", `${r.sha256}  ${out.split("/").pop()}\n`);
    for (const w of r.warnings) console.error("warning: " + w);
    console.log(`built ${out}`);
    console.log(`network ${dep.network} chain ${dep.chainId} bytes ${Buffer.byteLength(r.html)}`);
    console.log(`sha256 ${r.sha256}`);
  } catch (e) { console.error("build-exit: " + e.message); process.exit(1); }
}

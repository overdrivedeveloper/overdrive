// node --test exit/test/exit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

function noMatch(text, re, why = "") { const m = re.exec(text); assert.ok(!m, `${why} found: ${m && m[0]}`); }
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildPage, loadDeployment } from "../build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const lib = createRequire(import.meta.url)("../lib.cjs");
const abiDir = join(here, "../../app/src/abi");
const ADDR = { ODMinter: "0x1111111111111111111111111111111111111111", ODGovernor: "0x2222222222222222222222222222222222222222", ODBacker: "0x3333333333333333333333333333333333333333" };
const GEAR = { id: "0x" + "ab".repeat(32), symbol: "TSLA2", gear: 1, power: 2, marketA: "x", marketB: null, token: "0x4444444444444444444444444444444444444444", poolId: "0x" + "00".repeat(32), capUsd: 1 };
function anvilDeployment(addr = ADDR) {
  const d = loadDeployment("anvil");
  d.contracts = { ...d.contracts, ...addr };
  d.gears = [GEAR];
  return d;
}
const foundryBin = join(homedir(), ".foundry/bin");
const tool = (n) => (existsSync(join(foundryBin, n)) ? join(foundryBin, n) : n);

test("keccak256 and selectors match known values", () => {
  assert.equal(lib.keccakText(""), "0xc5d2460186f7233c927e7db2dcc703c0" + "e500b653ca82273b7bfad8045d85a470");
  assert.equal(lib.keccakText("transfer(address,uint256)").slice(0, 10), "0xa9059cbb");
  // multi-block input (longer than the 136 byte rate)
  const long = "a".repeat(300);
  const cast = spawnSync(tool("cast"), ["keccak", long], { encoding: "utf8" });
  if (cast.status === 0) assert.equal(lib.keccakText(long), cast.stdout.trim());
});

test("every embedded selector equals cast sig", () => {
  const r = buildPage({ deployment: anvilDeployment(), abiDir });
  const cast = spawnSync(tool("cast"), ["sig", "transfer(address,uint256)"], { encoding: "utf8" });
  for (const abi of Object.values(r.data.abis)) for (const f of abi.filter((x) => x.type === "function")) {
    assert.equal(f.sel, lib.keccakText(lib.signature(f)).slice(0, 10));
    if (cast.status === 0) assert.equal(spawnSync(tool("cast"), ["sig", lib.signature(f)], { encoding: "utf8" }).stdout.trim(), f.sel);
  }
});

test("built page contains every needed selector, event topic and error, and no external URL", () => {
  const { html, data } = buildPage({ deployment: anvilDeployment(), abiDir });
  const need = { minter: ["sell", "queueSell", "fillQueued", "cancelQueued", "queuedSell", "quote", "valuePerToken"], governor: ["claim", "requestWithdraw", "ticketOf", "balanceOf"], backer: ["repay", "withdraw", "vault", "health"], gear: ["balanceOf"] };
  for (const [k, names] of Object.entries(need)) for (const n of names) {
    const f = data.abis[k].find((x) => x.name === n && x.type === "function");
    assert.ok(f, `${k}.${n} embedded`);
    assert.ok(html.includes(f.sel), `selector of ${k}.${n} in page`);
  }
  for (const n of ["SellQueued", "WithdrawalQueued", "VaultOpened"]) assert.ok(html.includes(Object.values(data.abis).flat().find((x) => x.name === n).topic), n);
  for (const n of ["UseQueue", "Slippage", "ClaimBelowMin", "TooEarly", "NotFillable", "Undercollateralized"]) assert.ok(data.errors.some((e) => e.name === n), "error " + n);
  assert.ok(html.includes(ADDR.ODMinter) && html.includes(GEAR.token));
  noMatch(html, /https?:\/\//i);
  noMatch(html, /\/\/[a-z0-9.-]+\.[a-z]{2,}/i, "protocol-relative URL");
  noMatch(html, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts)\b|import\(|<script[^>]+src=|<link|<img|<iframe/i);
  noMatch(html, /—|–/, "no em or en dashes");
  noMatch(html, new RegExp("\\b(" + ["yi" + "eld", "A" + "PY", "guarant" + "eed", "risk-" + "free", "squa" + "red", "part" + "ner"].join("|") + ")\\b", "i"));
  assert.match(html, /TEST BUILD/);
});

test("build is deterministic and the hash is the sha256 of the file", () => {
  const a = buildPage({ deployment: anvilDeployment(), abiDir }), b = buildPage({ deployment: anvilDeployment(), abiDir });
  assert.equal(a.sha256, b.sha256);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
});

test("build refuses a mainnet page with missing addresses, and refuses allow-incomplete on mainnet", () => {
  const m = { ...anvilDeployment({}), network: "mainnet", chainId: 4663 };
  assert.throws(() => buildPage({ deployment: m, abiDir }), /exit page refused/);
  assert.throws(() => buildPage({ deployment: m, abiDir, allowIncomplete: true }), /exit page refused/);
  assert.throws(() => buildPage({ deployment: { ...m, chainId: 31337, contracts: ADDR }, abiDir }), /chainId 4663/);
  assert.throws(() => buildPage({ deployment: { ...anvilDeployment({}) }, abiDir }), /exit page refused/, "anvil without addresses needs the flag");
  const ok = buildPage({ deployment: { ...m, contracts: ADDR }, abiDir });
  assert.equal(ok.data.complete, true);
  const cli = spawnSync(process.execPath, [join(here, "../build.mjs")], { encoding: "utf8" });
  assert.notEqual(cli.status, 0);
});

test("revert decoding gives plain-English reasons", () => {
  const { data } = buildPage({ deployment: anvilDeployment(), abiDir });
  const t = lib.errorTable(data.errors);
  const sel = (n) => data.errors.find((e) => e.name === n).sel;
  assert.match(lib.explain(lib.decodeRevert(t, sel("UseQueue"))), /Queue sell/);
  const slip = sel("Slippage") + lib.encodeArgs([{ type: "uint256" }, { type: "uint256" }], [90_000000n, 100_000000n]);
  assert.match(lib.explain(lib.decodeRevert(t, slip)), /receive 90 USDG.*minimum is 100 USDG/);
  assert.match(lib.explain(lib.decodeRevert(t, "0x")), /no reason/);
  assert.match(lib.explain(lib.decodeRevert(t, "0xdeadbeef")), /does not know/);
  assert.equal(lib.parseUnits("1.5", 6), 1500000n);
  assert.throws(() => lib.parseUnits("1.2345678", 6));
});

test("the page script loads against a stub DOM and every element id it uses exists in the page", () => {
  const { html } = buildPage({ deployment: anvilDeployment(), abiDir });
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const app = readFileSync(join(here, "../app.js"), "utf8");
  const used = [...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
  for (const u of used) assert.ok(ids.has(u), "missing element #" + u);
  for (const m of app.matchAll(/say\("([a-z]+)"/g)) assert.ok(ids.has("msg-" + m[1]), "missing #msg-" + m[1]);
  const els = new Proxy({}, { get: (t, k) => (t[k] ??= { innerHTML: "", textContent: "", value: "0", hidden: false, dataset: {} }) });
  const doc = { getElementById: (k) => els[k], addEventListener() {} };
  const ctx = vm.createContext({ document: doc, window: {}, console, location: {} });
  ctx.globalThis = ctx; ctx.window = ctx;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const sc of scripts) vm.runInContext(sc, ctx);
  assert.match(els.chaininfo.textContent, /chain id 31337/);
  assert.match(els.testbanner.innerHTML, /TEST BUILD/);
  assert.match(els.contracts.innerHTML, /ODMinter/);
});

// Runs the page's own embedded lib and data in a sandbox, so the test uses the shipped encode functions.
function pageLib(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const ctx = vm.createContext({ window: {}, console });
  ctx.globalThis = ctx;
  vm.runInContext(scripts[0], ctx);
  vm.runInContext(scripts[1], ctx);
  return { L: ctx.window.ExitLib || ctx.ExitLib, D: ctx.window.EXIT_DATA };
}

const haveAnvil = spawnSync(tool("anvil"), ["--version"]).status === 0 && spawnSync(tool("forge"), ["--version"]).status === 0;
test("anvil: one sell, one queued sell, one claim, one refusal through the page's own encoders", { skip: !haveAnvil && "anvil/forge not installed", timeout: 180000 }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "exit-test-"));
  mkdirSync(join(work, "src"));
  copyFileSync(join(here, "MockExit.sol"), join(work, "src/MockExit.sol"));
  writeFileSync(join(work, "foundry.toml"), '[profile.default]\nsrc="src"\nout="out"\nsolc="0.8.26"\noffline=true\n');
  const b = spawnSync(tool("forge"), ["build", "--root", work], { encoding: "utf8" });
  if (b.status !== 0) { t.skip("forge could not compile the mock (solc 0.8.26 missing offline): " + b.stderr.slice(-200)); return; }
  const bytecode = JSON.parse(readFileSync(join(work, "out/MockExit.sol/MockExit.json"), "utf8")).bytecode.object;
  const port = 18545 + Math.floor(Math.random() * 1000);
  const args = ["--port", String(port), "--chain-id", "31337", "--silent"];
  if (process.env.RHC_RPC_URL) args.push("--fork-url", process.env.RHC_RPC_URL);
  const node = spawn(tool("anvil"), args, { stdio: "ignore" });
  t.after(() => node.kill());
  const url = `http://127.0.0.1:${port}`;
  const rpc = async (method, params = []) => { const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) { const e = new Error(r.error.message); e.data = r.error.data; throw e; } return r.result; };
  for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const [me] = await rpc("eth_accounts");
  const receipt = async (h) => { for (let i = 0; i < 100; i++) { const r = await rpc("eth_getTransactionReceipt", [h]); if (r) return r; await new Promise((x) => setTimeout(x, 50)); } throw new Error("no receipt " + h); };
  const deploy = async () => (await receipt(await rpc("eth_sendTransaction", [{ from: me, data: bytecode, gas: "0x200000" }]))).contractAddress;
  const addr = { ODMinter: await deploy(), ODGovernor: await deploy(), ODBacker: await deploy() };
  const { html } = buildPage({ deployment: anvilDeployment(addr), abiDir });
  const { L, D } = pageLib(html);
  const C = L.calls(D.abis, D.addr);
  const table = L.errorTable(D.errors);
  const sendTx = async (tx) => { const h = await rpc("eth_sendTransaction", [{ from: me, ...tx, gas: "0x100000" }]); const r = await receipt(h); assert.equal(r.status, "0x1"); return r; };
  const word = (hex, i) => BigInt("0x" + hex.slice(2 + i * 64, 66 + i * 64));

  // sell
  const tokens = L.parseUnits("2.5", 18), min = L.parseUnits("10", 6);
  const sell = C.sell(GEAR.id, tokens, min, me, 1900000000);
  assert.equal(sell.data.slice(0, 10), D.abis.minter.find((f) => f.name === "sell").sel);
  const r1 = await sendTx(sell);
  assert.equal(word(r1.logs[0].data, 0), BigInt(GEAR.id));
  assert.equal(word(r1.logs[0].data, 1), tokens);
  assert.equal(word(r1.logs[0].data, 2), min);
  assert.equal("0x" + r1.logs[0].data.slice(2 + 3 * 64 + 24, 2 + 4 * 64), me.toLowerCase());
  assert.equal(word(r1.logs[0].data, 4), 1900000000n);

  // the contract refuses with UseQueue: the page explains it, then queueSell goes through
  let refusal;
  try { await rpc("eth_call", [{ from: me, ...C.sell(GEAR.id, L.parseUnits("999", 18), 0n, me, 1900000000) }, "latest"]); } catch (e) { refusal = e; }
  assert.ok(refusal, "sell must revert");
  const data = L.revertDataFromError(refusal);
  assert.match(L.explain(L.decodeRevert(table, data)), /Queue sell/);
  const r2 = await sendTx(C.queueSell(GEAR.id, L.parseUnits("999", 18), 0n, me));
  assert.equal(word(r2.logs[0].data, 1), L.parseUnits("999", 18));

  // claim with a minimum: refused when the minimum is above what can be paid, accepted otherwise
  let low;
  try { await rpc("eth_call", [{ from: me, ...C.claim(7n, L.parseUnits("2000", 6)) }, "latest"]); } catch (e) { low = e; }
  assert.match(L.explain(L.decodeRevert(table, L.revertDataFromError(low))), /can pay 5 USDG now, below your minimum of 2000 USDG/);
  const r3 = await sendTx(C.claim(7n, L.parseUnits("4", 6)));
  assert.equal(word(r3.logs[0].data, 0), 7n);
  assert.equal(word(r3.logs[0].data, 1), 4000000n);

  // backer repay and withdraw
  const r4 = await sendTx(C.repay(3n, tokens));
  assert.equal(word(r4.logs[0].data, 0), 3n); assert.equal(word(r4.logs[0].data, 1), tokens);
  const r5 = await sendTx(C.withdrawCollateral(3n, min, me));
  assert.equal(word(r5.logs[0].data, 1), min);
});

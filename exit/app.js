// Overdrive exit page UI. Uses window.ExitLib (lib.cjs) and window.EXIT_DATA (embedded at build time).
(function () {
  "use strict";
  var L = window.ExitLib, D = window.EXIT_DATA, A = D.abis, ZERO = "0x" + "0".repeat(40);
  var errTable = L.errorTable(D.errors), C = L.calls(A, D.addr);
  var state = { acct: null, gearDec: 18, usdDec: 6, shareDec: 6, queued: {}, tickets: {}, vaults: {} };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  function eth() { if (!window.ethereum) throw new Error("No wallet found in this browser. Open this file in a browser with a wallet extension."); return window.ethereum; }
  function req(method, params) { return eth().request({ method: method, params: params || [] }); }
  function say(id, text, kind) { var el = $("msg-" + id); el.innerHTML = text ? '<div class="msg ' + (kind || "") + '">' + esc(text) + "</div>" : ""; }
  function hexn(n) { return "0x" + BigInt(n).toString(16); }
  function pad32(x) { return "0x" + BigInt(x).toString(16).padStart(64, "0"); }
  function topicAddr(a) { return "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }
  function frag(abi, name) { return L.find(abi, name); }
  function ev(abi, name) { for (var i = 0; i < abi.length; i++) if (abi[i].type === "event" && abi[i].name === name) return abi[i]; throw new Error(name); }
  async function read(to, abi, name, args) {
    var f = frag(abi, name), out = await req("eth_call", [{ to: to, data: L.encodeCall(f, args) }, "latest"]);
    return L.decodeResult(f, out);
  }
  function reasonFrom(e) {
    if (e && e.code === 4001) return "You rejected the request in your wallet.";
    var data = L.revertDataFromError(e);
    if (data) return L.explain(L.decodeRevert(errTable, data));
    return "The wallet or the network refused: " + ((e && (e.message || e.reason)) || e);
  }
  async function assertChain() {
    var id = parseInt(await req("eth_chainId"), 16);
    if (id !== D.chainId) throw new Error("Your wallet is on chain " + id + ". This page works on chain " + D.chainId + ". Press Switch network.");
  }
  // Simulate first so a refusal is explained in plain words, then send.
  async function send(tx, msgId, okText) {
    try {
      if (!state.acct) throw new Error("Connect your wallet first.");
      await assertChain();
      var t = { from: state.acct, to: tx.to, data: tx.data };
      try { await req("eth_call", [t, "latest"]); }
      catch (e) { var dd = L.revertDataFromError(e); if (dd) { var dec = L.decodeRevert(errTable, dd); say(msgId, L.explain(dec), "bad"); return { refused: dec }; } throw e; }
      say(msgId, "Waiting for your wallet...", "");
      var hash = await req("eth_sendTransaction", [t]);
      say(msgId, "Sent: " + hash + ". Waiting for it to be mined...", "");
      for (var i = 0; i < 180; i++) {
        var r = await req("eth_getTransactionReceipt", [hash]);
        if (r) {
          if (r.status === "0x1") { say(msgId, (okText || "Done.") + " Transaction " + hash, "ok"); return { hash: hash }; }
          say(msgId, "The transaction was mined but failed: " + hash, "bad"); return { failed: hash };
        }
        await new Promise(function (res) { setTimeout(res, 2000); });
      }
      say(msgId, "Not mined yet. Check your wallet for " + hash + ".", "");
      return { hash: hash };
    } catch (e) { say(msgId, reasonFrom(e), "bad"); return { error: e }; }
  }
  async function logs(address, topics) {
    var latest = parseInt(await req("eth_blockNumber"), 16), from = Number(D.startBlock || 0), out = [], step = 200000;
    while (from <= latest) {
      var to = Math.min(latest, from + step - 1);
      try { out = out.concat(await req("eth_getLogs", [{ address: address, topics: topics, fromBlock: hexn(from), toBlock: hexn(to) }])); from = to + 1; }
      catch (e) { if (step <= 1000) throw e; step = Math.floor(step / 4); }
    }
    return out;
  }

  // ---- connect --------------------------------------------------------------------------------------------
  function drawStatic() {
    if (D.network !== "mainnet" || !D.complete) $("testbanner").innerHTML = '<div class="banner">TEST BUILD (' + esc(D.network) + '). Not for real funds. Do not use this file on Robinhood Chain.</div>';
    $("chaininfo").textContent = "Network " + D.network + ", chain id " + D.chainId + ". Built from commit " + D.commit + ".";
    var rows = [["ODMinter (sell gears)", D.addr.ODMinter], ["ODGovernor (withdrawals)", D.addr.ODGovernor], ["ODBacker (vaults)", D.addr.ODBacker], ["USDG", D.addr.USDG]];
    D.gears.forEach(function (g) { rows.push(["Gear " + g.symbol, g.token]); });
    $("contracts").innerHTML = rows.map(function (r) { return "<tr><td>" + esc(r[0]) + "</td><td><code>" + esc(r[1]) + "</code></td></tr>"; }).join("");
    $("s-gear").innerHTML = D.gears.map(function (g, i) { return '<option value="' + i + '">' + esc(g.symbol) + "</option>"; }).join("");
  }
  async function connect() {
    try {
      var accts = await req("eth_requestAccounts");
      state.acct = accts[0];
      $("acct").textContent = "Account " + state.acct;
      $("s-to").value = state.acct; $("v-to").value = state.acct;
      var id = parseInt(await req("eth_chainId"), 16);
      $("btn-switch").hidden = id === D.chainId;
      if (id !== D.chainId) { say("connect", "Your wallet is on chain " + id + ". Press Switch network to move to chain " + D.chainId + ".", "bad"); return; }
      say("connect", "");
      for (var k in { ODMinter: 1, ODGovernor: 1, ODBacker: 1 }) { var code = await req("eth_getCode", [D.addr[k], "latest"]); if (code === "0x") { say("connect", k + " has no code at " + D.addr[k] + " on this chain. Do not send anything.", "bad"); return; } }
      try { state.usdDec = Number(await read(D.addr.USDG, A.gear, "decimals", [])); } catch (e) {}
      try { state.shareDec = Number(await read(D.addr.ODGovernor, A.governor, "decimals", [])); } catch (e) {}
      await refreshAll();
    } catch (e) { say("connect", reasonFrom(e), "bad"); }
  }
  async function switchChain() {
    try { await req("wallet_switchEthereumChain", [{ chainId: hexn(D.chainId) }]); await connect(); }
    catch (e) { say("connect", "Your wallet could not switch. Add Robinhood Chain (chain id " + D.chainId + ") in your wallet's network settings, then press Connect again.", "bad"); }
  }
  async function refreshAll() { await Promise.all([refreshGears(), refreshQueued(), refreshGov(), refreshVaults()].map(function (p) { return p.catch(function (e) { console.warn(e); }); })); }

  // ---- gears and sell -----------------------------------------------------------------------------------
  async function refreshGears() {
    var rows = [];
    for (var i = 0; i < D.gears.length; i++) {
      var g = D.gears[i], bal = await read(g.token, A.gear, "balanceOf", [state.acct]);
      g.bal = bal; var val = "";
      try { var v = await read(D.addr.ODMinter, A.minter, "valuePerToken", [g.id]); val = L.fmtUnits(v[0], 18, 4) + " USD per gear" + (v[1] ? "" : " (outside its normal range)"); } catch (e) { val = "no price available now"; }
      rows.push("<tr><td>" + esc(g.symbol) + "</td><td>" + esc(L.fmtUnits(bal, state.gearDec)) + "</td><td class=mut>" + esc(val) + "</td></tr>");
    }
    $("gears").innerHTML = "<tr><th>Gear</th><th>You hold</th><th>Reference value</th></tr>" + rows.join("");
  }
  function selGear() { return D.gears[Number($("s-gear").value)]; }
  function sellArgs() {
    var g = selGear(); if (!g) throw new Error("Pick a gear.");
    var tokens = L.parseUnits($("s-amt").value, state.gearDec); if (tokens === 0n) throw new Error("Enter an amount.");
    var minTxt = $("s-min").value.trim(); if (!minTxt) throw new Error("Set the smallest USDG you accept. Press Get quote to fill it in.");
    var to = $("s-to").value.trim() || state.acct;
    return { g: g, tokens: tokens, min: L.parseUnits(minTxt, state.usdDec), to: to };
  }
  async function doQuote() {
    try {
      var g = selGear(), tokens = L.parseUnits($("s-amt").value, state.gearDec);
      var q = await read(D.addr.ODMinter, A.minter, "quote", [g.id, false, true, tokens]);
      var out = q[1]; $("s-min").value = L.fmtUnits(out * 99n / 100n, state.usdDec, state.usdDec);
      say("sell", "The contract would pay about " + L.fmtUnits(out, state.usdDec) + " USDG now. I set your minimum 1% lower so small price moves do not stop the sale. Change it if you want." + (q[8] ? " This sell would be queued, not paid now: use Queue sell." : ""), "ok");
    } catch (e) { say("sell", reasonFrom(e), "bad"); }
  }
  async function doSell() {
    try {
      var a = sellArgs(), deadline = Math.floor(Date.now() / 1000) + 1200;
      var r = await send(C.sell(a.g.id, a.tokens, a.min, a.to, deadline), "sell", "Sold.");
      if (r.refused && r.refused.name === "UseQueue") $("btn-qsell").focus();
      else if (r.hash) refreshAll();
    } catch (e) { say("sell", e.message, "bad"); }
  }
  async function doQueueSell() {
    try { var a = sellArgs(); var r = await send(C.queueSell(a.g.id, a.tokens, a.min, a.to), "sell", "Queued. Your gears are in escrow until the sell is filled or you cancel it."); if (r.hash) refreshAll(); }
    catch (e) { say("sell", e.message, "bad"); }
  }

  // ---- queued sells -------------------------------------------------------------------------------------
  async function refreshQueued() {
    var evq = ev(A.minter, "SellQueued");
    try { (await logs(D.addr.ODMinter, [L.topicOf(evq), null, null, topicAddr(state.acct)])).forEach(function (l) { state.queued[BigInt(l.topics[1]).toString()] = 1; }); }
    catch (e) { say("queued", "Could not read your past tickets from the chain log (" + reasonFrom(e) + "). Type the ticket number below instead.", "bad"); }
    var rows = [];
    for (var t in state.queued) {
      var q = await read(D.addr.ODMinter, A.minter, "queuedSell", [BigInt(t)]);
      if (q[1] === ZERO) { rows.push("<tr><td>#" + t + "</td><td class=mut colspan=2>Filled or cancelled</td></tr>"); continue; }
      var g = D.gears.filter(function (x) { return x.id.toLowerCase() === q[0].toLowerCase(); })[0];
      rows.push("<tr><td>#" + t + "</td><td>" + esc(L.fmtUnits(q[3], state.gearDec)) + " " + esc(g ? g.symbol : "gear") + ", minimum " + esc(L.fmtUnits(q[4], state.usdDec)) + " USDG</td><td><button data-fill=" + t + ">Claim</button><button class=alt data-cancel=" + t + ">Cancel</button></td></tr>");
    }
    $("queued").innerHTML = rows.join("") || "<tr><td class=mut>No queued sells found.</td></tr>";
  }

  // ---- Governor ---------------------------------------------------------------------------------------------
  async function refreshGov() {
    $("g-shares").textContent = L.fmtUnits(await read(D.addr.ODGovernor, A.governor, "balanceOf", [state.acct]), state.shareDec);
    var evw = ev(A.governor, "WithdrawalQueued");
    try { (await logs(D.addr.ODGovernor, [L.topicOf(evw), topicAddr(state.acct)])).forEach(function (l) { state.tickets[BigInt(l.topics[2]).toString()] = 1; }); }
    catch (e) { say("gov", "Could not read your past tickets from the chain log. Type the ticket number below instead.", "bad"); }
    var rows = [];
    for (var t in state.tickets) {
      var r = await read(D.addr.ODGovernor, A.governor, "ticketOf", [BigInt(t)]);
      if (r[0] === ZERO || r[1] === 0n) { rows.push("<tr><td>#" + t + "</td><td class=mut colspan=2>Claimed</td></tr>"); continue; }
      rows.push("<tr><td>#" + t + "</td><td>" + esc(L.fmtUnits(r[1], state.shareDec)) + " shares, claimable from " + esc(new Date(Number(r[2]) * 1000).toUTCString()) + "</td><td><button data-claim=" + t + ">Claim</button></td></tr>");
    }
    $("tickets").innerHTML = rows.join("") || "<tr><td class=mut>No withdrawal tickets found.</td></tr>";
  }

  // ---- vaults ---------------------------------------------------------------------------------------------
  async function refreshVaults() {
    var evv = ev(A.backer, "VaultOpened");
    try { (await logs(D.addr.ODBacker, [L.topicOf(evv), null, topicAddr(state.acct)])).forEach(function (l) { state.vaults[BigInt(l.topics[1]).toString()] = 1; }); }
    catch (e) { say("vault", "Could not read your vaults from the chain log. Type the vault number below instead.", "bad"); }
    var rows = [];
    for (var id in state.vaults) {
      var v = await read(D.addr.ODBacker, A.backer, "vault", [BigInt(id)]);
      if (v[0].toLowerCase() !== state.acct.toLowerCase()) continue;
      var g = D.gears.filter(function (x) { return x.id.toLowerCase() === v[1].toLowerCase(); })[0], ratio = "";
      try { var h = await read(D.addr.ODBacker, A.backer, "health", [BigInt(id)]); ratio = "; ratio " + Number(h[2]) / 100 + "% (needs " + Number(h[3]) / 100 + "%, liquidation below " + Number(h[4]) / 100 + "%)"; } catch (e) {}
      rows.push("<tr><td>#" + id + "</td><td>" + esc(g ? g.symbol : "gear") + ": collateral " + esc(L.fmtUnits(v[2], state.usdDec)) + " USDG, debt " + esc(L.fmtUnits(v[3], state.gearDec)) + " gears" + esc(ratio) + "</td><td><button class=alt data-vfill=" + id + ">Use</button></td></tr>");
    }
    $("vaults").innerHTML = rows.join("") || "<tr><td class=mut>No vaults found for this wallet.</td></tr>";
  }
  function vaultArgs() {
    var id = $("v-id").value.trim(); if (!/^\d+$/.test(id)) throw new Error("Enter the vault number.");
    return BigInt(id);
  }

  // ---- wiring -------------------------------------------------------------------------------------------------
  function bind() {
    $("btn-connect").onclick = connect; $("btn-switch").onclick = switchChain;
    $("btn-quote").onclick = doQuote; $("btn-sell").onclick = doSell; $("btn-qsell").onclick = doQueueSell;
    $("btn-max").onclick = function () { var g = selGear(); if (g && g.bal !== undefined) $("s-amt").value = L.fmtUnits(g.bal, state.gearDec, state.gearDec); };
    $("btn-qadd").onclick = function () { var v = $("q-id").value.trim(); if (/^\d+$/.test(v)) { state.queued[v] = 1; refreshQueued(); } };
    $("btn-qrefresh").onclick = refreshQueued; $("btn-wrefresh").onclick = refreshGov; $("btn-vrefresh").onclick = refreshVaults;
    $("btn-wadd").onclick = function () { var v = $("w-id").value.trim(); if (/^\d+$/.test(v)) { state.tickets[v] = 1; refreshGov(); } };
    $("btn-wreq").onclick = async function () { try { var r = await send(C.requestWithdraw(L.parseUnits($("w-shares").value, state.shareDec)), "gov", "Withdrawal requested. Claim it after the delay."); if (r.hash) refreshGov(); } catch (e) { say("gov", e.message, "bad"); } };
    $("btn-vrepay").onclick = async function () { try { var r = await send(C.repay(vaultArgs(), L.parseUnits($("v-amt").value, state.gearDec)), "vault", "Repaid."); if (r.hash) refreshAll(); } catch (e) { say("vault", e.message, "bad"); } };
    $("btn-vwd").onclick = async function () { try { var r = await send(C.withdrawCollateral(vaultArgs(), L.parseUnits($("v-amt").value, state.usdDec), $("v-to").value.trim() || state.acct), "vault", "Collateral sent."); if (r.hash) refreshAll(); } catch (e) { say("vault", e.message, "bad"); } };
    document.addEventListener("click", async function (e) {
      var t = e.target, d = t && t.dataset; if (!d) return;
      if (d.fill) { var r = await send(C.fillQueued(BigInt(d.fill)), "queued", "Claimed. The USDG was sent to the address you chose when you queued."); if (r.hash) refreshAll(); }
      if (d.cancel) { var r2 = await send(C.cancelQueued(BigInt(d.cancel)), "queued", "Cancelled. Your gears are back in your wallet."); if (r2.hash) refreshAll(); }
      if (d.claim) { try { var min = L.parseUnits($("w-min").value || "0", state.usdDec); var r3 = await send(C.claim(BigInt(d.claim), min), "gov", "Claimed."); if (r3.hash) refreshAll(); } catch (x) { say("gov", x.message, "bad"); } }
      if (d.vfill) $("v-id").value = d.vfill;
    });
    if (window.ethereum && window.ethereum.on) { window.ethereum.on("chainChanged", function () { location.reload(); }); window.ethereum.on("accountsChanged", function () { location.reload(); }); }
  }
  drawStatic(); bind();
  window.ExitApp = { state: state };
})();

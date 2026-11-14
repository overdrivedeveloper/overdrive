// Overdrive exit page: pure helpers (no DOM, no network). Inlined into the built page and imported by tests.
// keccak256, ABI encode/decode for static types, revert decoding and plain-English reasons.
(function (root) {
  "use strict";
  var M = (1n << 64n) - 1n;
  var RHO = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
  var PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
  function rot(x, n) { return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M; }
  function f(s) {
    var R = 1, r, x, y, j, i;
    for (r = 0; r < 24; r++) {
      var C = [];
      for (x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
      for (x = 0; x < 5; x++) {
        var d = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
        for (y = 0; y < 25; y += 5) s[y + x] ^= d;
      }
      var t = s[1];
      for (i = 0; i < 24; i++) { j = PI[i]; var b = s[j]; s[j] = rot(t, RHO[i]); t = b; }
      for (y = 0; y < 25; y += 5) {
        var c = s.slice(y, y + 5);
        for (x = 0; x < 5; x++) s[y + x] = c[x] ^ ((~c[(x + 1) % 5] & M) & c[(x + 2) % 5]);
      }
      for (j = 0; j < 7; j++) {
        R = ((R << 1) ^ ((R >> 7) * 0x71)) & 0xff;
        if (R & 2) s[0] ^= 1n << BigInt((1 << j) - 1);
      }
    }
  }
  function utf8(str) {
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 128) out.push(c);
      else throw new Error("ascii only");
    }
    return out;
  }
  function keccak256(bytes) {
    var rate = 136, s = [], i, k;
    for (i = 0; i < 25; i++) s.push(0n);
    var m = bytes.slice();
    m.push(0x01);
    while (m.length % rate !== 0) m.push(0);
    m[m.length - 1] |= 0x80;
    for (var off = 0; off < m.length; off += rate) {
      for (i = 0; i < rate / 8; i++) {
        var w = 0n;
        for (k = 7; k >= 0; k--) w = (w << 8n) | BigInt(m[off + i * 8 + k]);
        s[i] ^= w;
      }
      f(s);
    }
    var hex = "";
    for (i = 0; i < 4; i++) for (k = 0; k < 8; k++) hex += ((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
    return "0x" + hex;
  }
  function keccakText(str) { return keccak256(utf8(str)); }

  function typeStr(p) {
    if (p.type === "tuple") return "(" + p.components.map(typeStr).join(",") + ")";
    return p.type;
  }
  function signature(frag) { return frag.name + "(" + frag.inputs.map(typeStr).join(",") + ")"; }
  function selectorOf(frag) { return frag.sel || keccakText(signature(frag)).slice(0, 10); }
  function topicOf(frag) { return frag.topic || keccakText(signature(frag)); }

  function isDynamic(p) { return p.type === "string" || p.type === "bytes" || /\[\]$/.test(p.type); }
  function words(p) {
    if (p.type === "tuple") return p.components.reduce(function (a, c) { return a + words(c); }, 0);
    return 1;
  }
  function pad(hex) { return hex.padStart(64, "0"); }
  function encOne(p, v) {
    if (isDynamic(p)) throw new Error("dynamic type not supported: " + p.type);
    if (p.type === "tuple") return p.components.map(function (c, i) { return encOne(c, v[i]); }).join("");
    if (p.type === "address") {
      var a = String(v).toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error("bad address");
      return pad(a.slice(2));
    }
    if (p.type === "bool") return pad(v ? "1" : "0");
    if (p.type === "bytes32") {
      var b = String(v).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(b)) throw new Error("bad bytes32");
      return b.slice(2);
    }
    var m = /^(u?)int(\d*)$/.exec(p.type);
    if (m) {
      var bits = m[2] ? parseInt(m[2], 10) : 256;
      var n = BigInt(v);
      if (m[1]) { if (n < 0n || n >= (1n << BigInt(bits))) throw new Error("out of range " + p.type); return pad(n.toString(16)); }
      var lim = 1n << BigInt(bits - 1);
      if (n < -lim || n >= lim) throw new Error("out of range " + p.type);
      if (n < 0n) n += 1n << 256n;
      return pad(n.toString(16));
    }
    throw new Error("unsupported type " + p.type);
  }
  function encodeArgs(inputs, values) {
    if (inputs.length !== values.length) throw new Error("expected " + inputs.length + " arguments");
    return inputs.map(function (p, i) { return encOne(p, values[i]); }).join("");
  }
  function encodeCall(frag, values) { return selectorOf(frag) + encodeArgs(frag.inputs, values || []); }

  function decOne(p, hex, pos) {
    if (p.type === "tuple") {
      var out = [], at = pos;
      p.components.forEach(function (c) { var r = decOne(c, hex, at); out.push(r[0]); at = r[1]; });
      return [out, at];
    }
    var w = hex.slice(pos * 64, pos * 64 + 64);
    if (w.length < 64) throw new Error("short data");
    var v;
    if (p.type === "address") v = "0x" + w.slice(24);
    else if (p.type === "bool") v = BigInt("0x" + w) !== 0n;
    else if (p.type === "bytes32") v = "0x" + w;
    else {
      var m = /^(u?)int(\d*)$/.exec(p.type);
      if (!m) throw new Error("unsupported type " + p.type);
      v = BigInt("0x" + w);
      if (!m[1] && (v >> 255n)) v -= 1n << 256n;
    }
    return [v, pos + 1];
  }
  function decodeArgs(params, data) {
    var hex = data.replace(/^0x/, ""), at = 0, out = [];
    params.forEach(function (p) { if (isDynamic(p)) throw new Error("dynamic"); var r = decOne(p, hex, at); out.push(r[0]); at = r[1]; });
    return out;
  }
  function decodeResult(frag, data) {
    var r = decodeArgs(frag.outputs, data);
    return r.length === 1 ? r[0] : r;
  }

  // ---- revert decoding -------------------------------------------------------------------------------------
  function errorTable(frags) {
    var t = {};
    frags.forEach(function (e) { if (e.type === "error") t[selectorOf(e)] = e; });
    return t;
  }
  function decodeRevert(table, data) {
    if (!data || data === "0x") return { name: "EmptyRevert", args: [] };
    var sel = data.slice(0, 10).toLowerCase();
    if (sel === "0x08c379a0") {
      try {
        var h = data.slice(10);
        var len = parseInt(h.slice(64, 128), 16), s = "";
        for (var i = 0; i < len; i++) s += String.fromCharCode(parseInt(h.slice(128 + i * 2, 130 + i * 2), 16));
        return { name: "Error", args: [s] };
      } catch (e) { return { name: "Error", args: [""] }; }
    }
    if (sel === "0x4e487b71") return { name: "Panic", args: [BigInt("0x" + data.slice(10, 74))] };
    var e = table[sel];
    if (!e) return { name: "Unknown", args: [], selector: sel };
    try { return { name: e.name, args: decodeArgs(e.inputs, "0x" + data.slice(10)) }; }
    catch (x) { return { name: e.name, args: [] }; }
  }
  function fmtUnits(v, dec, shown) {
    var n = BigInt(v), neg = n < 0n; if (neg) n = -n;
    var base = 10n ** BigInt(dec), whole = n / base, frac = (n % base).toString().padStart(dec, "0");
    frac = frac.slice(0, shown === undefined ? 6 : shown).replace(/0+$/, "");
    return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
  }
  function parseUnits(str, dec) {
    var s = String(str).trim();
    if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error("Enter a number like 12.5");
    var parts = s.split("."), fr = (parts[1] || "");
    if (fr.length > dec) throw new Error("At most " + dec + " decimal places");
    return BigInt(parts[0] || "0") * 10n ** BigInt(dec) + BigInt((fr + "0".repeat(dec)).slice(0, dec) || "0");
  }
  var USD = 6;
  var REASONS = {
    Expired: function () { return "The deadline passed before the transaction was mined. Send it again."; },
    Slippage: function (a) { return "The price moved. You would receive " + fmtUnits(a[0], USD) + " USDG but your minimum is " + fmtUnits(a[1], USD) + " USDG. Lower your minimum or try again."; },
    BelowMinimum: function () { return "The amount is below the smallest size this contract accepts."; },
    UseQueue: function () { return "The contract cannot pay this sell right now (market closed or no fresh price). Use Queue sell: your gears are held in escrow and paid at the next fresh price. You can cancel while it waits."; },
    NotTicketOwner: function () { return "This ticket belongs to another address. Connect the wallet that created it."; },
    NotFillable: function () { return "This queued sell cannot be filled yet (no fresh price, or the price is below your minimum). Try again later, or cancel it to get your gears back."; },
    TooEarly: function (a) { return "This withdrawal is not claimable yet. It opens at " + new Date(Number(a[0]) * 1000).toUTCString() + "."; },
    ClaimBelowMin: function (a) { return "The Governor can pay " + fmtUnits(a[0], USD) + " USDG now, below your minimum of " + fmtUnits(a[1], USD) + " USDG. Lower the minimum or wait."; },
    InsufficientCash: function (a) { return "The Governor does not have enough free cash for this right now (needs " + fmtUnits(a[0], USD) + " USDG, has " + fmtUnits(a[1], USD) + "). Try again later."; },
    UseWithdrawalQueue: function () { return "This amount must go through the withdrawal queue. Request a withdrawal, then claim it after the delay."; },
    PayOutOfGas: function () { return "The payout ran out of gas. Try again with a higher gas limit."; },
    NotVaultOwner: function () { return "This vault belongs to another address. Connect the wallet that opened it."; },
    Undercollateralized: function (a) { return "That would leave the vault under its required collateral (" + (Number(a[0]) / 100) + "% against " + (Number(a[1]) / 100) + "% required). Repay some debt first or take out less."; },
    InBatch: function () { return "This vault is inside a liquidation batch right now. Repaying is still allowed."; },
    BelowMinimumCollateral: function () { return "That would leave the vault below the minimum collateral."; },
    ZeroAddress: function () { return "The address is empty. Enter a real address."; },
    UnknownGear: function () { return "The contract does not know this gear."; },
    NotBackable: function () { return "This gear cannot be backed."; },
    BuysPaused: function () { return "Buys are paused. Selling and exits still work."; },
    EmptyRevert: function () { return "The contract refused with no reason. Check the amount and the wallet you are using."; },
    Panic: function () { return "The contract hit an internal error. Do not retry with the same values; ask in the community."; },
    Unknown: function (a, d) { return "The contract refused with an error this page does not know (" + (d && d.selector) + ")."; }
  };
  function explain(d) {
    if (d.name === "Error") return "The contract said: " + d.args[0];
    var fn = REASONS[d.name];
    if (fn) return fn(d.args, d);
    return "The contract refused: " + d.name + (d.args.length ? " (" + d.args.map(String).join(", ") + ")" : "") + ".";
  }
  function revertDataFromError(err) {
    // wallets and nodes put the revert bytes in different places
    var cands = [err && err.data, err && err.data && err.data.data, err && err.error && err.error.data, err && err.info && err.info.error && err.info.error.data];
    for (var i = 0; i < cands.length; i++) if (typeof cands[i] === "string" && /^0x[0-9a-fA-F]*$/.test(cands[i])) return cands[i];
    var m = err && err.message && /0x[0-9a-fA-F]{8,}/.exec(err.message);
    return m ? m[0] : null;
  }

  // ---- the five exit calls, as pure call builders --------------------------------------------------------------
  // frag lookup: abis = { minter: [...], governor: [...], backer: [...], gear: [...] }
  function find(abi, name) {
    for (var i = 0; i < abi.length; i++) if (abi[i].type === "function" && abi[i].name === name) return abi[i];
    throw new Error("missing function " + name);
  }
  function calls(abis, addr) {
    return {
      sell: function (gearId, tokens, minUsdgOut, recipient, deadline) { return { to: addr.ODMinter, data: encodeCall(find(abis.minter, "sell"), [gearId, tokens, minUsdgOut, recipient, deadline]) }; },
      queueSell: function (gearId, tokens, minUsdgOut, recipient) { return { to: addr.ODMinter, data: encodeCall(find(abis.minter, "queueSell"), [gearId, tokens, minUsdgOut, recipient]) }; },
      fillQueued: function (ticket) { return { to: addr.ODMinter, data: encodeCall(find(abis.minter, "fillQueued"), [ticket]) }; },
      cancelQueued: function (ticket) { return { to: addr.ODMinter, data: encodeCall(find(abis.minter, "cancelQueued"), [ticket]) }; },
      requestWithdraw: function (shares) { return { to: addr.ODGovernor, data: encodeCall(find(abis.governor, "requestWithdraw"), [shares]) }; },
      claim: function (ticket, minAssetsOut) { return { to: addr.ODGovernor, data: encodeCall(find(abis.governor, "claim"), [ticket, minAssetsOut]) }; },
      repay: function (vaultId, tokens) { return { to: addr.ODBacker, data: encodeCall(find(abis.backer, "repay"), [vaultId, tokens]) }; },
      withdrawCollateral: function (vaultId, usdg, to) { return { to: addr.ODBacker, data: encodeCall(find(abis.backer, "withdraw"), [vaultId, usdg, to]) }; }
    };
  }

  var api = {
    keccak256: keccak256, keccakText: keccakText, signature: signature, selectorOf: selectorOf, topicOf: topicOf,
    encodeArgs: encodeArgs, encodeCall: encodeCall, decodeArgs: decodeArgs, decodeResult: decodeResult,
    errorTable: errorTable, decodeRevert: decodeRevert, explain: explain, revertDataFromError: revertDataFromError,
    fmtUnits: fmtUnits, parseUnits: parseUnits, find: find, calls: calls
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ExitLib = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

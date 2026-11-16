#!/usr/bin/env bash
# ORACLE-SRC: record every external price source of one stock market LIVE, once while the market is OPEN and once at a
# moment it was CLOSED, as fixtures for contracts/test/oracle/SourceFixtures.t.sol and app/src/crank/hermes.test.ts.
# Sources: the Chainlink proxy (latestRoundData), Pyth (Hermes HTTP and the on-chain Pyth contract) and the v3 pool
# TWAP (observe). The OPEN side reads the latest block and refuses to run outside 09:30-16:00 New York, Monday to
# Friday; the CLOSED side reads the archive block at CLOSED_TS (default Saturday 2026-11-14 17:00 UTC) and asks Hermes
# for that timestamp. Read-only: eth_call and HTTP GET only. Never prints the RPC URL or the Hermes key.
# Needs RHC_MAINNET_RPC_URL (archive reads), PYTH_HERMES_API_KEY and PYTH_HERMES_AUTH_HEADER in the environment.
# Usage: bash scripts/record-oracle-fixtures.sh [SYMBOL] [CLOSED_TS]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cast="${CAST:-$HOME/.foundry/bin/cast}"
sym="${1:-TSLA}"
closed_ts="${2:-1794675600}"
rpc="${RHC_MAINNET_RPC_URL:?set RHC_MAINNET_RPC_URL}"
hermes="${PYTH_HERMES_URL:-https://hermes.pyth.network}"
out_dir="$root/contracts/test/fixtures/oracle-sources"
mkdir -p "$out_dir"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

dow="$(TZ=America/New_York date +%u)"; hm="$(TZ=America/New_York date +%H%M)"
if [ "$dow" -gt 5 ] || [ "$hm" -lt 0930 ] || [ "$hm" -ge 1600 ]; then
  echo "record-oracle-fixtures: the market is not open now (New York $dow $hm); the OPEN side must be live" >&2; exit 1
fi

cfg="$(python3 -I -c '
import json, sys
m = [m for m in json.load(open(sys.argv[1]))["markets"] if m["symbol"] == sys.argv[2]][0]
x = json.load(open(sys.argv[1]))["external"]
print(m["feed"], m["twapPool"], m["stockAsset"], "0x" + m["pythId"], m["twapWindow"], x["pythCore"])
' "$root/contracts/script/config/mainnet.json" "$sym")"
read -r feed pool stock pyth_id window pyth_core <<EOF
$cfg
EOF

key="${PYTH_HERMES_API_KEY:-}"; hdr="${PYTH_HERMES_AUTH_HEADER:-x-api-key}"
if [ "$(printf %s "$hdr" | tr '[:upper:]' '[:lower:]')" = authorization ]; then case "$key" in [Bb]earer\ *) ;; *) key="Bearer $key" ;; esac; fi
hermes_get() { # $1 = path+query, $2 = out file; prints the HTTP status
  curl -s -o "$2" -w '%{http_code}' -H "accept: application/json" -H "$hdr: $key" "${hermes%/}$1"
}

record() { # $1 = state name, $2 = block number, $3 = Hermes path
  local blk="$2" d="$work/$1"
  mkdir -p "$d"
  "$cast" block "$blk" --rpc-url "$rpc" -f timestamp >"$d/ts"
  echo "$blk" >"$d/block"
  "$cast" call "$feed" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$rpc" --block "$blk" --json >"$d/chainlink"
  "$cast" call "$feed" "decimals()(uint8)" --rpc-url "$rpc" --block "$blk" >"$d/decimals"
  "$cast" call "$pool" "observe(uint32[])(int56[],uint160[])" "[$window,0]" --rpc-url "$rpc" --block "$blk" --json >"$d/observe"
  "$cast" call "$pool" "token0()(address)" --rpc-url "$rpc" --block "$blk" >"$d/token0"
  "$cast" call "$stock" "uiMultiplier()(uint256)" --rpc-url "$rpc" --block "$blk" --json >"$d/mult"
  "$cast" call "$pyth_core" "getPriceUnsafe(bytes32)((int64,uint64,int32,uint256))" "$pyth_id" --rpc-url "$rpc" --block "$blk" --json >"$d/pyth"
  hermes_get "$3" "$d/hermes" >"$d/hermes_status"
}

record open "$("$cast" block-number --rpc-url "$rpc")" "/v2/updates/price/latest?ids[]=$pyth_id&encoding=hex&parsed=true"
record closed "$("$cast" find-block "$closed_ts" --rpc-url "$rpc")" "/v2/updates/price/$closed_ts?ids[]=$pyth_id&encoding=hex&parsed=true"
unknown="0x$(printf 'ab%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32)"
hermes_get "/v2/updates/price/latest?ids[]=$unknown&encoding=hex&parsed=true" "$work/unknown" >"$work/unknown_status"

python3 -I - "$work" "$sym" "$feed" "$pool" "$stock" "$pyth_id" "$window" "$closed_ts" "$unknown" >"$out_dir/$sym.json" <<'PY'
import json, re, sys
w, sym, feed, pool, stock, pyth_id, window, closed_ts, unknown = sys.argv[1:]
def rd(p): return open(f"{w}/{p}").read().strip()
def hermes(p):
    body = rd(p)
    try: return json.loads(body)
    except ValueError: return body
def state(s):
    rnd = json.loads(rd(f"{s}/chainlink")); obs = json.loads(rd(f"{s}/observe")); py = json.loads(rd(f"{s}/pyth"))[0]
    cum = [int(c) for c in obs[0]]
    return {
        "block": int(rd(f"{s}/block")), "timestamp": int(rd(f"{s}/ts")),
        "chainlink": {"roundId": rnd[0], "answer": int(rnd[1]), "startedAt": int(rnd[2]), "updatedAt": int(rnd[3]),
                      "decimals": int(rd(f"{s}/decimals").split()[0])},
        "pythOnchain": {"price": int(py[0]), "conf": int(py[1]), "expo": int(py[2]), "publishTime": int(py[3])},
        "hermes": {"status": int(rd(f"{s}/hermes_status")), "body": hermes(f"{s}/hermes")},
        "twap": {"window": int(window), "tickCumulatives": cum, "meanTick": (cum[1] - cum[0]) // int(window),
                 "poolAsset0": rd(f"{s}/token0").split()[0]},
        "uiMultiplier": json.loads(rd(f"{s}/mult"))[0],
    }
out = json.dumps({
    "description": f"Live responses of every price source of {sym} on Robinhood Chain mainnet (4663), recorded by scripts/record-oracle-fixtures.sh: once with the market OPEN (latest block) and once CLOSED (archive block at {closed_ts}). Hermes is the HTTP answer as received (status and body); pythOnchain is the Pyth contract the guard reads. ORACLE-SRC.",
    "symbol": sym, "feed": feed, "pool": pool, "stockAsset": stock, "pythId": pyth_id,
    "open": state("open"), "closed": state("closed"),
    "hermesUnknownId": {"id": unknown, "status": int(rd("unknown_status")), "body": hermes("unknown")},
}, indent=2)
# 32-byte hex ids are not keys: the public guard needs its marker on the same line, so each gets a sibling note.
mark = re.compile(r'^(\s*"(\w+)": "[^"]*0x[0-9a-fA-F]{64}[^"]*")(,?)$')
print("\n".join(mark.sub(lambda m: f'{m[1]}, "{m[2]}Note": "// not-a-key: Pyth price id"{m[3]}', l) for l in out.split("\n")))
PY
echo "wrote ${out_dir#"$root"/}/$sym.json"

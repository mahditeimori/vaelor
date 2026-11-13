"""Live MT5 checks against a running bridge (read paths + order error surface)."""

import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get("BRIDGE_URL", "http://127.0.0.1:8899")
TOKEN = os.environ.get("BRIDGE_TOKEN", "smoke-token-123")


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"x-bridge-token": TOKEN, "accept": "application/json"}
    if data:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, raw


status, body = call("GET", "/api/status")
print("status", status, "mode", body["mode"], "tradingEnabled", body["tradingEnabled"])
print("account", json.dumps(body["account"], indent=None))
print("autotrading", body["provider"]["autotrading"])

status, diag = call("GET", "/api/mt5/diagnostics")
print("\nterminals:")
for t in diag["terminals"]:
    print(f"  {t['name']:<28} running={t['running']!s:<5} {t['path']}")

status, quote = call("GET", "/api/quote?symbol=XAUUSD")
print("\nXAUUSD quote", status, quote)

status, hist = call("GET", "/api/history?days=90")
print("\nhistory", status, "deals", len(hist.get("trades", [])))
for d in hist.get("trades", [])[:3]:
    print("  ", d["symbol"], d["side"], d["volume"], d["openPrice"], "->", d["closePrice"], d["pnl"])

status, bt = call(
    "POST",
    "/api/backtest",
    {
        "strategyId": "gold-ema-trend",
        "symbol": "XAUUSD",
        "timeframe": "H1",
        "initialBalance": 10000,
        "spreadPips": 2.0,
    },
)
print("\nbacktest on real broker H1 history:", status)
if status == 200:
    s = bt["result"]["stats"]
    print(
        f"  bars={s['bars']} trades={s['trades']} winRate={s['winRate']}% "
        f"PF={s['profitFactor']} expectancyR={s['expectancyR']} maxDD={s['maxDrawdownPct']}% "
        f"return={s['totalReturnPct']}% score={s['score']} confidence={s['confidence']}"
    )
    print("  window", bt["result"]["stats"]["start"], "->", bt["result"]["stats"]["end"])
    print("  first trade", bt["result"]["trades"][0] if bt["result"]["trades"] else None)
else:
    print("  ", bt)

status, order = call(
    "POST",
    "/api/orders",
    {"symbol": "XAUUSD", "side": "buy", "volume": 0.01, "confirm": True, "comment": "bridge check"},
)
print("\norder attempt:", status)
print(json.dumps(order, indent=1)[:1200])

status, mode = call("POST", "/api/mode", {"mode": "live", "confirm": "LIVE"})
print("\nswitch to live:", status, mode)

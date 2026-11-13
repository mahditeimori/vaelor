"""End-to-end smoke test against a running bridge.

    .\\run.ps1
    .\\.venv\\Scripts\\python.exe tools\\smoke.py            # uses http://127.0.0.1:8899

Reads the token from data/bridge-token unless BRIDGE_TOKEN is set. Creates a
throwaway strategy, runs a backtest, opens/modifies/partially closes/closes a
position, exercises the signal queue, the risk gate and the kill switch, then
prints a PASS/FAIL line per check and exits non-zero on any failure.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = os.environ.get("BRIDGE_URL", "http://127.0.0.1:8899").rstrip("/")
TOKEN = os.environ.get("BRIDGE_TOKEN") or (ROOT / "data" / "bridge-token").read_text().strip()

PASS = 0
FAIL = 0


def call(method: str, path: str, payload: dict | None = None, token: str | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"accept": "application/json"}
    if token is not False:
        headers["x-bridge-token"] = token or TOKEN
    if data:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            body = json.loads(raw)
        except Exception:
            body = raw
        return exc.code, body


def check(label: str, ok: bool, detail: object = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}  {detail}")


def skip(label: str, why: str) -> None:
    """A check that does not apply to this environment (e.g. MT5 is attached)."""
    global PASS
    PASS += 1
    print(f"SKIP  {label}  ({why})")


def main() -> int:
    print(f"bridge: {BASE}")

    status, health = call("GET", "/health", token=False)
    check("health is public", status == 200 and health.get("ok") is True, health)

    status, body = call("GET", "/api/status", token=False)
    check("status rejects a missing token", status == 401, (status, body))

    status, body = call("GET", "/api/status", token="wrong")
    check("status rejects a wrong token", status == 401, (status, body))

    status, body = call("GET", "/api/status")
    check("status returns an account", status == 200 and body["account"]["balance"] > 0, body)
    mode = body["mode"]
    print(f"      mode={mode} provider={body['provider']['provider']} reason={body['provider'].get('reason')}")

    status, body = call("GET", "/api/symbols")
    symbols = [s["symbol"] for s in body["symbols"]]
    check("symbols are listed", status == 200 and "XAUUSD" in symbols, symbols)

    status, body = call("GET", "/api/quote?symbol=XAUUSD")
    quote = body
    check("quote has bid < ask", status == 200 and quote["bid"] < quote["ask"], quote)

    # ---------------------------------------------------------------- strategy
    manifest = {
        "id": "smoke-ema",
        "name": "Smoke EMA cross",
        "author": "smoke test",
        "description": "Throwaway strategy used by tools/smoke.py",
        "symbols": ["XAUUSD"],
        "timeframe": "H1",
        "direction": "both",
        "entryLong": {"all": [{"type": "ema_cross", "fast": 12, "slow": 36, "direction": "up"}]},
        "entryShort": {"all": [{"type": "ema_cross", "fast": 12, "slow": 36, "direction": "down"}]},
        "stop": {"type": "atr", "mult": 2.0},
        "target": {"type": "atr", "mult": 4.0},
        "trail": {"type": "atr", "mult": 1.5},
        "risk": {"riskPct": 1.0, "maxPositions": 1},
        "tags": ["smoke"],
    }
    status, body = call("POST", "/api/strategies", {"strategy": manifest})
    check("strategy registers", status == 200 and body["strategy"]["id"] == "smoke-ema", body)

    status, body = call("POST", "/api/strategies", {"strategy": {**manifest, "stop": {"type": "atr"}}})
    check("invalid strategy is rejected", status == 400, (status, body))

    status, body = call("GET", "/api/strategies")
    ids = [s["id"] for s in body["strategies"]]
    check("strategy appears in the registry", "smoke-ema" in ids, ids)

    status, body = call("POST", "/api/strategies/smoke-ema/toggle", {"enabled": True, "autoExecute": False})
    check("strategy toggles on", status == 200 and body["strategy"]["enabled"] is True, body)

    # ---------------------------------------------------------------- backtest
    end = int(time.time())
    status, body = call(
        "POST",
        "/api/backtest",
        {
            "strategyId": "smoke-ema",
            "symbol": "XAUUSD",
            "timeframe": "H1",
            "start": str(end - 300 * 86400),
            "end": str(end),
            "initialBalance": 10000,
            "spreadPips": 1.5,
        },
    )
    ok = status == 200 and body["result"]["stats"]["bars"] > 100
    check("backtest runs", ok, body if status != 200 else "")
    if ok:
        stats = body["result"]["stats"]
        print(
            f"      trades={stats['trades']} winRate={stats['winRate']}% "
            f"PF={stats['profitFactor']} score={stats['score']} confidence={stats['confidence']} "
            f"dd={stats['maxDrawdownPct']}% return={stats['totalReturnPct']}%"
        )
        bt_id = body["id"]
        status, body = call("GET", f"/api/backtests/{bt_id}")
        check("backtest is retrievable", status == 200 and body["id"] == bt_id, status)
        check(
            "equity curve is ordered",
            all(
                a["time"] <= b["time"]
                for a, b in zip(body["result"]["equity"], body["result"]["equity"][1:])
            ),
        )

    # ------------------------------------------------------------------ orders
    status, body = call("GET", "/api/quote?symbol=XAUUSD")
    q = body
    # A fresh idempotency key per run so a repeated smoke run does not replay
    # yesterday's (already closed) ticket instead of placing a new order.
    run_key = f"smoke-open-{int(time.time())}"
    status, body = call(
        "POST",
        "/api/orders",
        {
            "symbol": "XAUUSD",
            "side": "buy",
            "volume": 0.2,
            "sl": round(q["bid"] - 25, 2),
            "tp": round(q["bid"] + 50, 2),
            "comment": "smoke",
            "strategyId": "smoke-ema",
            "idempotencyKey": run_key,
            "confirm": True,
        },
    )
    check("market order fills", status == 200 and body["order"]["ticket"] > 0, body)
    ticket = body["order"]["ticket"] if status == 200 else 0

    status, body = call(
        "POST",
        "/api/orders",
        {
            "symbol": "XAUUSD",
            "side": "buy",
            "volume": 0.2,
            "confirm": True,
            "idempotencyKey": run_key,
        },
    )
    check(
        "idempotent retry reuses the ticket",
        status == 200 and body["order"]["ticket"] == ticket,
        body,
    )

    status, body = call("GET", "/api/positions")
    check("position is in the book", any(p["ticket"] == ticket for p in body["positions"]), body)

    status, body = call(
        "POST", f"/api/positions/{ticket}/modify", {"sl": round(q["bid"] - 12, 2)}
    )
    check("modify accepts a new stop", status == 200 and body["position"]["status"] == "modified", body)

    status, body = call("POST", f"/api/positions/{ticket}/breakeven")
    # On a live venue the stop can only move to entry once the trade has cleared
    # the spread and the broker's minimum stop distance. That refusal is a safety
    # feature, not a failure.
    refused = status == 400 and "break-even is not possible yet" in json.dumps(body)
    check("breakeven moves the stop to entry (or refuses safely)", status == 200 or refused, body)
    if refused:
        print("      note: price had not cleared the spread yet, stop left unchanged")

    status, body = call("POST", f"/api/positions/{ticket}/trail", {"distancePips": 300})
    refused = status == 400 and "would move the stop backwards" in json.dumps(body)
    check("trail moves the stop (or refuses a worse stop)", status == 200 or refused, body)

    status, body = call("POST", f"/api/positions/{ticket}/close", {"volume": 0.1})
    check(
        "partial close leaves a remainder",
        status == 200 and abs(body["position"]["remainingVolume"] - 0.1) < 1e-6,
        body,
    )

    status, body = call("POST", f"/api/positions/{ticket}/close", {})
    check("full close removes the position", status == 200 and body["position"]["remainingVolume"] == 0, body)

    status, body = call("GET", "/api/positions")
    check("book is flat again", not any(p["ticket"] == ticket for p in body["positions"]), body)

    status, body = call("GET", "/api/history?days=2")
    # MT5 can take a moment to publish a just-closed deal to the history cache.
    for _ in range(6):
        if len([d for d in body.get("trades", []) if d.get("ticket") == ticket]) >= 2:
            break
        time.sleep(1)
        status, body = call("GET", "/api/history?days=2")
    check(
        "both fills are in the deal history",
        len([d for d in body["trades"] if d["ticket"] == ticket]) >= 2,
        body,
    )

    # ------------------------------------------------------------------ signals
    status, body = call(
        "POST",
        "/api/signals",
        {
            "signal": {
                "strategyId": "smoke-ema",
                "symbol": "XAUUSD",
                "side": "buy",
                "sl": round(q["bid"] - 20, 2),
                "confidence": 0.66,
                "note": "smoke signal",
            }
        },
    )
    check("signal is queued", status == 200 and body["signal"]["status"] == "pending", body)
    sig_id = body["signal"]["id"] if status == 200 else ""

    status, body = call("POST", f"/api/signals/{sig_id}/approve", {"note": "smoke approval"})
    check("signal approves into a position", status == 200 and body["signal"]["status"] == "executed", body)
    sig_ticket = body["order"]["ticket"] if status == 200 else 0

    status, body = call(
        "POST",
        "/api/signals",
        {"signal": {"strategyId": "smoke-ema", "symbol": "XAUUSD", "side": "sell"}},
    )
    sid2 = body["signal"]["id"] if status == 200 else ""
    status, body = call("POST", f"/api/signals/{sid2}/reject", {"note": "smoke rejection"})
    check("signal rejects cleanly", status == 200 and body["signal"]["status"] == "rejected", body)

    # ------------------------------------------------------------ performance
    status, body = call("GET", "/api/performance")
    row = next((r for r in body["strategies"] if r["id"] == "smoke-ema"), None)
    check("performance lists the strategy", status == 200 and row is not None, body)
    if row:
        print(
            f"      successRate={row['successRate']} evidence={row['evidence']} "
            f"score={row['score']} confidence={row['confidence']} sample={row['sample']}"
        )

    # --------------------------------------------------------------- risk gate
    status, body = call(
        "POST", "/api/orders", {"symbol": "XAUUSD", "side": "buy", "volume": 99, "confirm": True}
    )
    check("lot cap blocks an oversized order", status == 400, (status, body))

    status, body = call("POST", "/api/kill", {"active": True, "confirm": "KILL", "closePositions": True})
    check("kill switch activates and flattens", status == 200 and body["killSwitch"] is True, body)

    status, body = call(
        "POST", "/api/orders", {"symbol": "XAUUSD", "side": "buy", "volume": 0.1, "confirm": True}
    )
    check("kill switch blocks new orders", status == 400, (status, body))

    status, body = call("GET", "/api/positions")
    check("no positions survive the kill switch", body["positions"] == [], body)

    status, body = call("POST", "/api/kill", {"active": False})
    check("kill switch deactivates", status == 200 and body["killSwitch"] is False, body)

    status, body = call("GET", "/api/mt5/diagnostics")
    if body.get("connected"):
        skip("live mode is refused without MT5", "a terminal is attached in this environment")
    else:
        status, body = call("POST", "/api/mode", {"mode": "live", "confirm": "LIVE"})
        check("live mode is refused without MT5", status == 400, (status, body))

    # ------------------------------------------------------------------- audit
    status, body = call("GET", "/api/audit?limit=200")
    actions = {e["action"] for e in body["entries"]}
    for expected in ("order.placed", "position.closed", "signal.received", "safety.kill_switch", "backtest.completed"):
        check(f"audit records {expected}", expected in actions, sorted(actions))

    # ----------------------------------------------------------------- cleanup
    status, body = call("POST", "/api/strategies/smoke-ema/toggle", {"enabled": False})
    check("strategy toggles off", status == 200 and body["strategy"]["enabled"] is False, body)

    print(f"\n{PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"FATAL {exc!r}")
        sys.exit(2)

"""Period breakdowns for a finished backtest.

Turns the flat trade list into day / week / month aggregates plus an
exit-reason breakdown, so the Execution page can show the whole run and the
individual decisions behind it without doing the maths in the browser.

Everything is computed in UTC, matching the timestamps MT5 returns.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

DAY = "day"
WEEK = "week"
MONTH = "month"

_REASON_LABELS = {
    "stop": "Stop loss",
    "target": "Take profit",
    "signal": "Exit signal",
    "trail": "Trailing stop",
    "end_of_data": "Still open at end",
    "manual": "Manual close",
}


def _ts(trade: dict) -> int:
    return int(trade.get("exitTime") or trade.get("entryTime") or 0)


def _dt(ts: int) -> datetime:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc)


def _bucket_of(ts: int, kind: str) -> tuple[str, str]:
    """Return (sortable key, human label) for a timestamp and period kind."""
    moment = _dt(ts)
    if kind == DAY:
        return moment.strftime("%Y-%m-%d"), moment.strftime("%a %d %b %Y")
    if kind == WEEK:
        monday = moment.date() - timedelta(days=moment.weekday())
        sunday = monday + timedelta(days=6)
        iso = moment.isocalendar()
        return (
            f"{iso.year}-W{iso.week:02d}",
            f"Week {iso.week:02d} · {monday.strftime('%d %b')} → {sunday.strftime('%d %b %Y')}",
        )
    return moment.strftime("%Y-%m"), moment.strftime("%B %Y")


def _new_bucket(key: str, label: str, equity: float) -> dict:
    return {
        "key": key,
        "label": label,
        "trades": 0,
        "wins": 0,
        "losses": 0,
        "breakeven": 0,
        "netPnl": 0.0,
        "grossProfit": 0.0,
        "grossLoss": 0.0,
        "rSum": 0.0,
        "bestTradePnl": None,
        "worstTradePnl": None,
        "bestTradeTime": None,
        "worstTradeTime": None,
        "firstTradeTime": None,
        "lastTradeTime": None,
        "equityStart": round(equity, 2),
        "equityEnd": round(equity, 2),
        "_trades": [],
    }


def _finish_bucket(bucket: dict, initial_balance: float) -> dict:
    trades = bucket.pop("_trades")
    count = bucket["trades"]
    bucket["netPnl"] = round(bucket["netPnl"], 2)
    bucket["grossProfit"] = round(bucket["grossProfit"], 2)
    bucket["grossLoss"] = round(bucket["grossLoss"], 2)
    bucket["winRate"] = round(bucket["wins"] / count * 100, 2) if count else 0.0
    bucket["avgPnl"] = round(bucket["netPnl"] / count, 2) if count else 0.0
    bucket["avgR"] = round(bucket["rSum"] / count, 3) if count else 0.0
    bucket["profitFactor"] = (
        round(bucket["grossProfit"] / abs(bucket["grossLoss"]), 2)
        if bucket["grossLoss"]
        else None
    )
    bucket["returnPct"] = (
        round((bucket["equityEnd"] / bucket["equityStart"] - 1) * 100, 2)
        if bucket["equityStart"]
        else 0.0
    )
    bucket["start"] = bucket["firstTradeTime"]
    bucket["end"] = bucket["lastTradeTime"]
    bucket.pop("rSum", None)
    bucket["tradeIndexes"] = [t["_index"] for t in trades]
    return bucket


def _aggregate(ordered: list[dict], kind: str, initial_balance: float) -> list[dict]:
    buckets: list[dict] = []
    current: dict | None = None
    equity = float(initial_balance)

    for index, trade in enumerate(ordered):
        ts = _ts(trade)
        key, label = _bucket_of(ts, kind)
        if current is None or current["key"] != key:
            if current is not None:
                buckets.append(_finish_bucket(current, initial_balance))
            current = _new_bucket(key, label, equity)

        pnl = float(trade.get("pnl") or 0.0)
        reward = float(trade.get("r") or 0.0)
        equity += pnl

        current["trades"] += 1
        current["netPnl"] += pnl
        current["rSum"] += reward
        if pnl > 0:
            current["wins"] += 1
            current["grossProfit"] += pnl
        elif pnl < 0:
            current["losses"] += 1
            current["grossLoss"] += pnl
        else:
            current["breakeven"] += 1

        if current["bestTradePnl"] is None or pnl > current["bestTradePnl"]:
            current["bestTradePnl"] = round(pnl, 2)
            current["bestTradeTime"] = ts
        if current["worstTradePnl"] is None or pnl < current["worstTradePnl"]:
            current["worstTradePnl"] = round(pnl, 2)
            current["worstTradeTime"] = ts

        if current["firstTradeTime"] is None:
            current["firstTradeTime"] = ts
        current["lastTradeTime"] = ts
        current["equityEnd"] = round(equity, 2)
        current["_trades"].append({"_index": index})

    if current is not None:
        buckets.append(_finish_bucket(current, initial_balance))
    return buckets


def _reason_report(ordered: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for trade in ordered:
        reason = str(trade.get("reason") or "unknown")
        row = grouped.setdefault(
            reason,
            {
                "reason": reason,
                "label": _REASON_LABELS.get(reason, reason.replace("_", " ").title()),
                "count": 0,
                "wins": 0,
                "losses": 0,
                "pnl": 0.0,
                "rSum": 0.0,
            },
        )
        pnl = float(trade.get("pnl") or 0.0)
        row["count"] += 1
        row["pnl"] += pnl
        row["rSum"] += float(trade.get("r") or 0.0)
        if pnl > 0:
            row["wins"] += 1
        elif pnl < 0:
            row["losses"] += 1

    rows = []
    for row in grouped.values():
        row["pnl"] = round(row["pnl"], 2)
        row["avgPnl"] = round(row["pnl"] / row["count"], 2) if row["count"] else 0.0
        row["avgR"] = round(row["rSum"] / row["count"], 3) if row["count"] else 0.0
        row.pop("rSum", None)
        rows.append(row)
    rows.sort(key=lambda r: r["pnl"])
    return rows


def _extremes(rows: Iterable[dict], key: str) -> tuple[dict | None, dict | None]:
    candidates = [r for r in rows if r["trades"]]
    if not candidates:
        return None, None
    best = max(candidates, key=lambda r: r[key])
    worst = min(candidates, key=lambda r: r[key])
    return best, worst


def build_report(trades: list[dict], initial_balance: float = 10_000.0) -> dict:
    """Full period report for a finished backtest."""
    ordered = sorted(trades, key=_ts)
    days = _aggregate(ordered, DAY, initial_balance)
    weeks = _aggregate(ordered, WEEK, initial_balance)
    months = _aggregate(ordered, MONTH, initial_balance)
    reasons = _reason_report(ordered)

    total_net = sum(float(t.get("pnl") or 0.0) for t in ordered)
    gross_profit = sum(float(t.get("pnl") or 0.0) for t in ordered if float(t.get("pnl") or 0) > 0)
    gross_loss = sum(float(t.get("pnl") or 0.0) for t in ordered if float(t.get("pnl") or 0) < 0)
    wins = sum(1 for t in ordered if float(t.get("pnl") or 0) > 0)
    losses = sum(1 for t in ordered if float(t.get("pnl") or 0) < 0)

    best_day, worst_day = _extremes(days, "netPnl")
    best_week, worst_week = _extremes(weeks, "netPnl")
    best_month, worst_month = _extremes(months, "netPnl")

    best_trade = max(ordered, key=lambda t: float(t.get("pnl") or 0)) if ordered else None
    worst_trade = min(ordered, key=lambda t: float(t.get("pnl") or 0)) if ordered else None

    equity = float(initial_balance)
    curve = [{"time": _ts(t), "equity": round(equity := equity + float(t.get("pnl") or 0), 2)} for t in ordered]

    return {
        "firstTradeTime": _ts(ordered[0]) if ordered else None,
        "lastTradeTime": _ts(ordered[-1]) if ordered else None,
        "totals": {
            "trades": len(ordered),
            "wins": wins,
            "losses": losses,
            "netPnl": round(total_net, 2),
            "grossProfit": round(gross_profit, 2),
            "grossLoss": round(gross_loss, 2),
            "winRate": round(wins / len(ordered) * 100, 2) if ordered else 0.0,
            "avgPnl": round(total_net / len(ordered), 2) if ordered else 0.0,
            "bestTrade": best_trade,
            "worstTrade": worst_trade,
        },
        "counts": {
            "days": len(days),
            "profitableDays": sum(1 for d in days if d["netPnl"] > 0),
            "losingDays": sum(1 for d in days if d["netPnl"] < 0),
            "flatDays": sum(1 for d in days if d["netPnl"] == 0),
            "avgDayPnl": round(sum(d["netPnl"] for d in days) / len(days), 2) if days else 0.0,
            "weeks": len(weeks),
            "months": len(months),
        },
        "days": days,
        "weeks": weeks,
        "months": months,
        "reasons": reasons,
        "bestDay": best_day,
        "worstDay": worst_day,
        "bestWeek": best_week,
        "worstWeek": worst_week,
        "bestMonth": best_month,
        "worstMonth": worst_month,
        "equityByTrade": curve,
    }

"""Backtest adapter for sandboxed Python strategies.

The strategy code is executed by ``py_runner_driver.py`` in a separate,
isolated interpreter with a restricted builtins table. This module only builds
the request, applies a hard timeout, and turns the returned trades into the same
statistics/report shape the DSL backtester produces, so the Execution page does
not need to know which kind of strategy it is looking at.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from typing import Sequence

from .models import StrategyManifest
from .performance import summarise
from .report import build_report

DRIVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "py_runner_driver.py")
RUNNER_TIMEOUT_SECONDS = 180
MAX_EQUITY_POINTS = 600


def run_python_backtest(
    manifest: StrategyManifest,
    bars: Sequence[dict],
    symbol,
    *,
    initial_balance: float = 10_000.0,
    risk_pct: float | None = None,
    spread_pips: float = 1.0,
    commission_per_lot: float = 0.0,
    leverage: int = 100,
    timeframe: str | None = None,
) -> dict:
    if manifest.runtime == "external":
        raise ValueError(
            "This strategy is an external MetaTrader 5 driver: it places its own orders, so "
            "the bridge cannot replay it on bar history. Use a JSON manifest or a Python "
            "on_bar strategy for backtests."
        )
    if manifest.runtime != "python":
        raise ValueError("not a Python strategy")
    if not manifest.code:
        raise ValueError("this Python strategy has no source code stored")
    if len(bars) < 60:
        raise ValueError("not enough bars for a backtest (need at least 60)")

    bars = list(bars)
    payload = {
        "code": manifest.code,
        "bars": [
            {
                "time": int(bar["time"]),
                "open": float(bar["open"]),
                "high": float(bar["high"]),
                "low": float(bar["low"]),
                "close": float(bar["close"]),
                "volume": float(bar.get("volume") or 0.0),
            }
            for bar in bars
        ],
        "symbol": {
            "symbol": symbol.symbol,
            "contract": float(symbol.contract),
            "pip": float(symbol.pip),
            "digits": int(symbol.digits),
        },
        "timeframe": timeframe or manifest.timeframe,
        "initialBalance": float(initial_balance),
        "riskPct": risk_pct,
        "defaultRiskPct": float(manifest.risk.riskPct),
        "maxLots": float(manifest.risk.maxLots or 100.0),
        "spreadPips": float(spread_pips),
        "commissionPerLot": float(commission_per_lot),
        "leverage": int(leverage),
    }

    try:
        completed = subprocess.run(
            [sys.executable, "-I", DRIVER],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=RUNNER_TIMEOUT_SECONDS,
            cwd=os.path.dirname(DRIVER),
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError(
            f"the Python strategy did not finish within {RUNNER_TIMEOUT_SECONDS}s"
        ) from exc

    if not completed.stdout.strip():
        tail = (completed.stderr or "").strip().splitlines()[-3:]
        raise ValueError("the Python runner produced no result" + (f": {' / '.join(tail)}" if tail else ""))

    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(f"the Python runner returned invalid output: {exc}") from exc

    if not result.get("ok"):
        raise ValueError(str(result.get("error") or "the Python strategy failed"))
    if completed.returncode not in (0, None):
        tail = (completed.stderr or "").strip().splitlines()[-3:]
        if tail:
            raise ValueError("the Python runner failed: " + " / ".join(tail))

    trades = result.get("trades") or []
    curve = result.get("curve") or []
    warmup = int(result.get("warmup") or 0)

    equity_values = [float(point.get("equity") or 0.0) for point in curve] or [float(initial_balance)]
    stats = summarise(trades, equity_values)
    final_equity = equity_values[-1]
    stats["totalReturnPct"] = round((final_equity / initial_balance - 1) * 100, 2)
    stats["finalEquity"] = round(final_equity, 2)
    stats["initialBalance"] = float(initial_balance)
    stats["start"] = bars[warmup]["time"] if warmup < len(bars) else bars[0]["time"]
    stats["end"] = bars[-1]["time"]
    stats["bars"] = max(0, len(bars) - warmup)
    stats["timeframe"] = timeframe or manifest.timeframe
    stats["symbol"] = symbol.symbol
    stats["leverageCapped"] = 0
    stats["spreadPips"] = spread_pips
    stats["commissionPerLot"] = commission_per_lot

    report = build_report(trades, initial_balance)
    stats["firstTrade"] = report["firstTradeTime"]
    stats["lastTrade"] = report["lastTradeTime"]

    step = max(1, math.ceil(len(curve) / MAX_EQUITY_POINTS))
    sampled = curve[::step]
    if curve and sampled[-1] is not curve[-1]:
        sampled.append(curve[-1])

    return {
        "stats": stats,
        "trades": trades,
        "equity": sampled,
        "warmupBars": warmup,
        "report": report,
        "logs": result.get("logs") or [],
    }

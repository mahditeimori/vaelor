"""Success-rate and risk statistics.

Every number the dashboard shows comes from one of these functions, so the
backtest, the paper book and the live book are measured identically.
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence


def wilson_lower(wins: int, total: int, z: float = 1.96) -> float | None:
    """Lower bound of the 95% Wilson score interval for a win rate."""
    if total <= 0:
        return None
    p = wins / total
    denominator = 1 + z * z / total
    centre = p + z * z / (2 * total)
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)
    return max(0.0, (centre - spread) / denominator)


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _stdev(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))


def max_drawdown(equity: Iterable[float]) -> tuple[float, float]:
    """Return (absolute, percent) max drawdown of an equity curve."""
    peak = -math.inf
    worst_abs = 0.0
    worst_pct = 0.0
    for value in equity:
        peak = max(peak, value)
        if peak <= 0:
            continue
        drop = peak - value
        if drop > worst_abs:
            worst_abs = drop
            worst_pct = drop / peak * 100
    return worst_abs, worst_pct


def trade_stats(trades: Sequence[dict]) -> dict:
    """Aggregate closed trades into the metrics used across the platform."""
    pnls = [float(t.get("pnl", 0.0)) for t in trades]
    rs = [float(t.get("r", 0.0)) for t in trades if t.get("r") is not None]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))

    streak = worst_streak = 0
    for pnl in pnls:
        if pnl < 0:
            streak += 1
            worst_streak = max(worst_streak, streak)
        else:
            streak = 0

    rs_std = _stdev(rs)
    sharpe = (_mean(rs) / rs_std * math.sqrt(len(rs))) if rs_std > 0 else 0.0
    total = len(pnls)
    win_rate = (len(wins) / total * 100) if total else 0.0

    return {
        "trades": total,
        "wins": len(wins),
        "losses": len(losses),
        "winRate": round(win_rate, 2),
        "profitFactor": round(gross_profit / gross_loss, 3) if gross_loss > 0 else None,
        "netProfit": round(sum(pnls), 2),
        "grossProfit": round(gross_profit, 2),
        "grossLoss": round(gross_loss, 2),
        "avgWin": round(_mean(wins), 2),
        "avgLoss": round(_mean(losses), 2),
        "expectancy": round(_mean(pnls), 2),
        "expectancyR": round(_mean(rs), 3) if rs else None,
        "payoff": round(_mean(wins) / abs(_mean(losses)), 3) if wins and losses else None,
        "sharpe": round(sharpe, 3),
        "maxConsecutiveLosses": worst_streak,
        "avgBarsHeld": round(_mean([t.get("bars", 0) for t in trades]), 1) if trades else 0,
        "wilsonLower": round((wilson_lower(len(wins), total) or 0) * 100, 2) if total else 0.0,
    }


def confidence_label(stats: dict) -> str:
    n = stats.get("trades", 0)
    if n < 10:
        return "insufficient"
    if n < 30:
        return "low"
    if n < 100:
        return "medium"
    return "high"


def strategy_score(stats: dict, max_dd_pct: float | None = None) -> float:
    """A 0-100 composite that penalises small samples and deep drawdowns.

    Deliberately conservative: the Wilson lower bound means a 90% win rate on
    12 trades cannot outrank a 60% win rate on 400 trades.
    """
    n = int(stats.get("trades", 0))
    if n == 0:
        return 0.0

    wilson = float(stats.get("wilsonLower") or 0.0)
    pf = stats.get("profitFactor")
    expectancy_r = stats.get("expectancyR") or 0.0

    win_component = min(wilson, 100.0) * 0.45
    pf_component = 0.0
    if pf is not None:
        pf_component = min(max(pf, 0.0), 3.0) / 3.0 * 100 * 0.30
    exp_component = min(max(expectancy_r, -1.0), 2.0)
    exp_component = (exp_component + 1.0) / 3.0 * 100 * 0.25

    sample_factor = min(1.0, math.sqrt(n / 40.0))
    base = (win_component + pf_component + exp_component) * sample_factor

    if max_dd_pct is not None and max_dd_pct > 0:
        penalty = min(25.0, max(0.0, max_dd_pct - 10.0) * 1.2)
        base -= penalty
    return round(max(0.0, min(100.0, base)), 1)


def summarise(trades: Sequence[dict], equity: Sequence[float] | None = None) -> dict:
    stats = trade_stats(trades)
    if equity is not None and equity:
        _, dd_pct = max_drawdown(equity)
        stats["maxDrawdownPct"] = round(dd_pct, 2)
    else:
        stats["maxDrawdownPct"] = None
    stats["confidence"] = confidence_label(stats)
    stats["score"] = strategy_score(stats, stats.get("maxDrawdownPct"))
    stats["wilsonLower"] = stats.get("wilsonLower", 0.0)
    return stats

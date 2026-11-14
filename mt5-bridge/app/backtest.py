"""Event-driven backtester for the strategy DSL.

Signals are evaluated on closed bars and filled at the next bar's open, with
spread, commission, ATR/pip/percent stops, fixed-R targets and ATR trailing.
That is deliberately strict: no look-ahead, no intrabar optimism (if the stop
and the target are both inside one candle, the stop wins).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

from .performance import max_drawdown, summarise
from .report import build_report
from .strategies import EvalContext, entry_side, should_exit, warmup_bars
from .models import StrategyManifest, TF_MINUTES


@dataclass
class SymbolCtx:
    symbol: str
    contract: float = 100.0
    pip: float = 0.01
    digits: int = 2


def _rule_distance(rule: Any, price: float, atr_value: float | None, pip: float) -> float | None:
    if rule is None:
        return None
    if rule.type == "atr":
        if atr_value is None:
            return None
        return float(rule.mult or 0) * atr_value
    if rule.type == "pips":
        return float(rule.pips or 0) * pip
    if rule.type == "percent":
        return price * float(rule.pct or 0) / 100.0
    return None


def _round_lots(lots: float, step: float = 0.01) -> float:
    return max(step, math.floor(lots / step) * step)


def run_backtest(
    manifest: StrategyManifest,
    bars: Sequence[dict],
    symbol: SymbolCtx,
    *,
    initial_balance: float = 10_000.0,
    risk_pct: float | None = None,
    spread_pips: float = 1.0,
    commission_per_lot: float = 0.0,
    leverage: int = 100,
) -> dict:
    if len(bars) < 50:
        raise ValueError("not enough bars for a backtest (need at least 50)")

    bars = list(bars)
    ctx = EvalContext(bars)
    warmup = min(warmup_bars(manifest), max(10, len(bars) - 2))
    spread = max(0.0, spread_pips) * symbol.pip
    risk = risk_pct if risk_pct is not None else manifest.risk.riskPct
    max_lots = manifest.risk.maxLots or 100.0

    equity = float(initial_balance)
    peak_equity = equity
    position: dict[str, Any] | None = None
    pending_entry: dict[str, Any] | None = None
    pending_exit = False

    trades: list[dict] = []
    curve: list[dict] = []
    blocked_by_leverage = 0

    def atr_at(index: int) -> float | None:
        try:
            series = ctx.series("atr", period=14)
            return series[index] if index < len(series) else None
        except Exception:
            return None

    def open_position(side: str, index: int, fill_base: float) -> None:
        nonlocal equity, position, blocked_by_leverage
        price = fill_base + (spread / 2 if side == "buy" else -spread / 2)
        atr_value = atr_at(index)
        stop_distance = _rule_distance(manifest.stop, price, atr_value, symbol.pip)
        if not stop_distance or stop_distance <= 0:
            stop_distance = price * 0.005
        target_distance = _rule_distance(manifest.target, price, atr_value, symbol.pip)
        risk_amount = equity * risk / 100.0
        lots = risk_amount / (stop_distance * symbol.contract)
        lots = _round_lots(min(lots, max_lots))
        notional = lots * symbol.contract * price
        max_notional = equity * leverage
        if notional > max_notional:
            lots = _round_lots(max(0.01, lots * max_notional / notional))
            blocked_by_leverage += 1
        if lots <= 0:
            return
        position = {
            "side": side,
            "entry": price,
            "lots": lots,
            "sl": price - stop_distance if side == "buy" else price + stop_distance,
            "tp": (
                price + target_distance
                if side == "buy" and target_distance
                else price - target_distance
                if target_distance
                else None
            ),
            "entry_index": index,
            "entry_time": bars[index]["time"],
            "best": price,
            "risk": risk_amount,
            "stop_distance": stop_distance,
        }

    def close_position(index: int, exit_base: float, reason: str) -> None:
        nonlocal equity, position
        assert position is not None
        side = position["side"]
        price = exit_base - (spread / 2 if side == "buy" else -spread / 2)
        direction = 1 if side == "buy" else -1
        pnl = (price - position["entry"]) * direction * position["lots"] * symbol.contract
        pnl -= commission_per_lot * position["lots"]
        equity += pnl
        trades.append(
            {
                "side": side,
                "entry": round(position["entry"], symbol.digits),
                "exit": round(price, symbol.digits),
                "lots": round(position["lots"], 2),
                "pnl": round(pnl, 2),
                "r": round(pnl / position["risk"], 3) if position["risk"] else 0.0,
                "bars": index - position["entry_index"],
                "entryTime": position["entry_time"],
                "exitTime": bars[index]["time"],
                "reason": reason,
            }
        )
        position = None

    for i in range(warmup, len(bars)):
        bar = bars[i]

        # 1. Fill a pending signal from the previous close at this open.
        if position is None and pending_entry is not None:
            open_position(pending_entry["side"], i, float(bar["open"]))
            pending_entry = None

        # 2. Manage an open position using the stop/target carried in from the
        #    previous bar, so a trailing update can never use the same candle it
        #    is tested against.
        if position is not None:
            if position.get("exit_pending"):
                close_position(i, float(bar["open"]), "signal")
            else:
                stop_hit = (
                    bar["low"] <= position["sl"]
                    if position["side"] == "buy"
                    else bar["high"] >= position["sl"]
                )
                target_hit = position["tp"] is not None and (
                    bar["high"] >= position["tp"]
                    if position["side"] == "buy"
                    else bar["low"] <= position["tp"]
                )
                if stop_hit:
                    close_position(i, position["sl"], "stop")
                elif target_hit:
                    close_position(i, position["tp"], "target")
                elif should_exit(manifest, ctx, i):
                    position["exit_pending"] = True
                elif manifest.trail is not None:
                    atr_value = atr_at(i)
                    distance = _rule_distance(
                        manifest.trail, position["entry"], atr_value, symbol.pip
                    )
                    if distance:
                        if position["side"] == "buy":
                            position["best"] = max(position["best"], bar["high"])
                            candidate = position["best"] - distance
                            if candidate > position["sl"]:
                                position["sl"] = candidate
                        else:
                            position["best"] = min(position["best"], bar["low"])
                            candidate = position["best"] + distance
                            if candidate < position["sl"]:
                                position["sl"] = candidate

        # 3. New entry signal on this close (never while a position is open).
        if position is None:
            side = entry_side(manifest, ctx, i)
            if side:
                pending_entry = {"side": side}

        # 4. Mark-to-market equity for the drawdown curve.
        floating = 0.0
        if position is not None:
            direction = 1 if position["side"] == "buy" else -1
            floating = (
                (float(bar["close"]) - position["entry"])
                * direction
                * position["lots"]
                * symbol.contract
            )
        curve.append({"time": bar["time"], "equity": round(equity + floating, 2)})

    if position is not None:
        close_position(len(bars) - 1, float(bars[-1]["close"]), "end_of_data")
        curve.append({"time": bars[-1]["time"], "equity": round(equity, 2)})

    # Guarantee no duplicate timestamps in the eventual chart.
    seen: set[Any] = set()
    clean_curve = []
    for point in curve:
        if point["time"] in seen:
            continue
        seen.add(point["time"])
        clean_curve.append(point)

    stats = summarise(trades, [p["equity"] for p in clean_curve])
    stats["totalReturnPct"] = round((equity / initial_balance - 1) * 100, 2)
    stats["finalEquity"] = round(equity, 2)
    stats["initialBalance"] = initial_balance
    stats["start"] = bars[warmup]["time"] if warmup < len(bars) else bars[0]["time"]
    stats["end"] = bars[-1]["time"]
    stats["bars"] = len(bars) - warmup
    stats["timeframe"] = manifest.timeframe
    stats["symbol"] = symbol.symbol
    stats["leverageCapped"] = blocked_by_leverage
    stats["spreadPips"] = spread_pips
    stats["commissionPerLot"] = commission_per_lot
    report = build_report(trades, initial_balance)
    stats["firstTrade"] = report["firstTradeTime"]
    stats["lastTrade"] = report["lastTradeTime"]

    max_points = 600
    step = max(1, math.ceil(len(clean_curve) / max_points))
    sampled = clean_curve[::step]
    if clean_curve and sampled[-1] != clean_curve[-1]:
        sampled.append(clean_curve[-1])

    return {
        "stats": stats,
        "trades": trades,
        "equity": sampled,
        "warmupBars": warmup,
        "report": report,
    }


def buy_and_hold(bars: Sequence[dict], initial_balance: float = 10_000) -> float:
    """Percent return of holding the asset across the same window."""
    if len(bars) < 2:
        return 0.0
    return (bars[-1]["close"] / bars[0]["close"] - 1) * 100


def timeframe_minutes(tf: str) -> int:
    return TF_MINUTES.get(tf.upper(), 60)

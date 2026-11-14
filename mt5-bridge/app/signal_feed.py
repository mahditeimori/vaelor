"""Live signal feed: turn enabled strategy rules into actionable MT5 tickets.

Every tick the engine asks this module to look at the last *closed* bar of each
enabled strategy. When the rules fire, a **pending signal** is created with the
entry, stop, target, suggested lots and a management plan. Nothing is sent to
the broker here: the desk decides, and on prop-firm accounts the signal-only
lock refuses every order.

The evaluation reuses the exact same DSL code as the backtester, so a signal is
the rule set the user measured, not a second interpretation of it.
"""

from __future__ import annotations

import time
from typing import Any

from .models import TF_MINUTES, StrategyManifest
from .providers import Provider, spec_for
from .strategies import EvalContext, entry_side, validate_strategy, warmup_bars


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


def _round_lots(lots: float, spec: Any) -> float:
    step = float(spec.lot_step or 0.01)
    if step <= 0:
        step = 0.01
    rounded = round(round(lots / step) * step, 2)
    return max(float(spec.min_lot or step), min(rounded, float(spec.max_lot or 100.0)))


def _management_plan(manifest: StrategyManifest, risk_pct: float) -> dict:
    """The manual instructions attached to every signal.

    This is guidance derived from the rules the strategy already declares. The
    backtest only ever uses stop/target/trail; breakeven at 1R is the safe
    default a discretionary prop trader can apply without changing the edge.
    """
    trail = None
    if manifest.trail is not None:
        trail = manifest.trail.model_dump(exclude_none=True)
        trail["afterR"] = 1.0
    steps = [
        "Enter at the quoted price; the bridge never sends this order while signal-only is on.",
        "Move the stop to the entry price (breakeven, risk free) when the trade is 1R in profit.",
    ]
    if trail:
        steps.append("After 1R, trail the stop by the strategy's trail rule.")
    steps.append(
        "Take profit at the target, or close early if the exit rule fires. Never widen the stop."
    )
    return {
        "breakevenAtR": 1.0,
        "trail": trail,
        "riskPct": risk_pct,
        "steps": steps,
    }


class SignalFeed:
    """Bar-close signal generator shared by the engine tick and the manual scan."""

    def __init__(self, provider: Provider) -> None:
        self.provider = provider

    def scan(self, strategies: list[dict], *, now: int | None = None) -> list[dict]:
        created: list[dict] = []
        now = int(now or time.time())
        for row in strategies:
            if not row.get("enabled"):
                continue
            if row.get("runtime") in {"external", "python"}:
                # External drivers trade themselves; Python on_bar strategies
                # are replayed by the backtest runner, not evaluated live here.
                continue
            try:
                manifest = validate_strategy(
                    StrategyManifest(
                        **{k: v for k, v in row.items() if k not in {"source", "createdAt", "updatedAt"}}
                    )
                )
            except Exception:
                continue
            for symbol in manifest.symbols:
                try:
                    signal = self._signal_for(manifest, symbol, now)
                except Exception:
                    continue
                if signal:
                    created.append(signal)
        return created

    # ------------------------------------------------------------------ core
    def _signal_for(self, manifest: StrategyManifest, symbol: str, now: int) -> dict | None:
        tf = manifest.timeframe
        step = TF_MINUTES.get(tf, 60) * 60
        need = warmup_bars(manifest) + 40
        # Request a generous calendar window: weekends and broker holidays leave
        # gaps, and a too-narrow range can return fewer bars than the warmup
        # needs. The evaluation still uses the last closed bar only.
        start = now - max(need * step * 3, 7 * 86400)
        bars = self.provider.rates(symbol, tf, start, now)
        if len(bars) < need:
            return None

        # The provider includes the forming candle. Signals are evaluated on the
        # last fully closed bar (index -2), exactly like the backtester.
        index = len(bars) - 2
        if index < need - 1:
            return None
        bar_time = int(bars[index]["time"])
        # Never publish a ticket from a stale bar (weekend, long holiday): it
        # would be expired the moment it appeared.
        if now > bar_time + max(3600, 2 * step):
            return None

        ctx = EvalContext(bars)
        side = entry_side(manifest, ctx, index)
        if not side:
            return None
        # Fade repeated evaluations of the same bar.
        if manifest.exit is not None:
            try:
                from .strategies import should_exit

                if should_exit(manifest, ctx, index):
                    return None
            except Exception:
                pass

        quote = self.provider.quote(symbol)
        price = float(quote["ask"] if side == "buy" else quote["bid"])
        spec = spec_for(symbol)
        atr_series = ctx.series("atr", period=14)
        atr_value = atr_series[index] if index < len(atr_series) else None

        stop_distance = _rule_distance(manifest.stop, price, atr_value, spec.pip)
        if not stop_distance or stop_distance <= 0:
            stop_distance = price * 0.005
        target_distance = _rule_distance(manifest.target, price, atr_value, spec.pip)
        if target_distance is not None and target_distance <= 0:
            target_distance = None

        sl = price - stop_distance if side == "buy" else price + stop_distance
        tp = None
        if target_distance:
            tp = price + target_distance if side == "buy" else price - target_distance

        risk_pct = float(manifest.risk.riskPct)
        try:
            account = self.provider.account()
            equity = float(account["equity"])
        except Exception:
            equity = 10_000.0
        lots = equity * risk_pct / 100.0 / (stop_distance * float(spec.contract or 1))
        lots = _round_lots(min(lots, float(manifest.risk.maxLots or 100.0)), spec)

        rr = round(target_distance / stop_distance, 2) if target_distance else None
        plan = _management_plan(manifest, risk_pct)
        direction = "BUY" if side == "buy" else "SELL"
        note = (
            f"{direction} {symbol} on the {tf} close. Entry {price:.{spec.digits}f}, "
            f"stop {sl:.{spec.digits}f}"
            + (f", target {tp:.{spec.digits}f}" if tp else ", target: exit rule only")
            + f". Suggested {lots:g} lots at {risk_pct:g}% risk"
            + (f", {rr:g}R" if rr else "")
            + ". Move to breakeven at 1R."
        )
        return {
            "strategyId": manifest.id,
            "symbol": symbol,
            "side": side,
            "entry": round(price, spec.digits),
            "sl": round(sl, spec.digits),
            "tp": round(tp, spec.digits) if tp else None,
            "lots": lots,
            "rr": rr,
            "barTime": bar_time,
            "timeframe": tf,
            "source": "strategy",
            "signalOnly": True,
            "management": plan,
            "note": note,
            "createdAt": _iso(now),
        }


def _iso(ts: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")

"""Strategy DSL validation and evaluation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import indicators as ind
from .models import Condition, Group, StrategyManifest


class StrategyError(ValueError):
    """Raised when a strategy manifest is structurally invalid."""


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def _need(condition: Condition, *fields: str) -> None:
    missing = [f for f in fields if getattr(condition, f) is None]
    if missing:
        raise StrategyError(
            f"{condition.type}: missing {', '.join(missing)}"
        )


def _check_condition(condition: Condition) -> None:
    t = condition.type
    if t in {"ema_cross", "sma_cross"}:
        _need(condition, "fast", "slow", "direction")
        if condition.fast >= condition.slow:
            raise StrategyError(f"{t}: fast must be smaller than slow")
    elif t in {"price_vs_ema", "price_vs_sma"}:
        _need(condition, "period", "op")
    elif t == "rsi":
        _need(condition, "period", "op", "value")
        if not 0 <= (condition.value or 0) <= 100:
            raise StrategyError("rsi value must be between 0 and 100")
    elif t == "macd":
        _need(condition, "fast", "slow", "period", "direction")
        if condition.fast >= condition.slow:
            raise StrategyError("macd: fast must be smaller than slow")
    elif t == "breakout":
        _need(condition, "lookback", "side")
        if (condition.lookback or 0) < 2:
            raise StrategyError("breakout: lookback must be >= 2")
    elif t == "bollinger":
        _need(condition, "period", "mult", "side")
    elif t == "atr_filter":
        _need(condition, "period", "min")
    elif t != "always":
        raise StrategyError(f"unknown condition type: {t}")

    for field in ("fast", "slow", "period", "lookback"):
        value = getattr(condition, field)
        if value is not None and value <= 0:
            raise StrategyError(f"{t}: {field} must be positive")
        if value is not None and value > 500:
            raise StrategyError(f"{t}: {field} is unreasonably large (max 500)")


def _check_group(group: Group | None, label: str) -> None:
    if group is None:
        return
    if group.all and group.any:
        raise StrategyError(f"{label}: use either `all` or `any`, not both")
    for condition in [*group.all, *group.any]:
        _check_condition(condition)


def validate_strategy(manifest: StrategyManifest) -> StrategyManifest:
    _check_group(manifest.entry, "entry")
    _check_group(manifest.entryLong, "entryLong")
    _check_group(manifest.entryShort, "entryShort")
    _check_group(manifest.exit, "exit")

    for label, rule in (("stop", manifest.stop), ("target", manifest.target), ("trail", manifest.trail)):
        if rule is None:
            continue
        if rule.type == "atr" and not rule.mult:
            raise StrategyError(f"{label}: atr rule needs `mult`")
        if rule.type == "pips" and not rule.pips:
            raise StrategyError(f"{label}: pips rule needs `pips`")
        if rule.type == "percent" and not rule.pct:
            raise StrategyError(f"{label}: percent rule needs `pct`")

    if manifest.entry and manifest.direction == "both":
        raise StrategyError(
            "direction=both requires entryLong and entryShort (or pick long/short)"
        )
    if manifest.entryLong and manifest.direction == "short":
        raise StrategyError("entryLong conflicts with direction=short")
    if manifest.entryShort and manifest.direction == "long":
        raise StrategyError("entryShort conflicts with direction=long")
    return manifest


def warmup_bars(manifest: StrategyManifest) -> int:
    longest = 30
    groups = [manifest.entry, manifest.entryLong, manifest.entryShort, manifest.exit]
    for group in groups:
        if not group:
            continue
        for condition in [*group.all, *group.any]:
            candidates = [
                condition.period or 0,
                condition.slow or 0,
                condition.fast or 0,
                condition.lookback or 0,
            ]
            longest = max(longest, max(candidates))
    return longest + 3


# --------------------------------------------------------------------------
# Evaluation
# --------------------------------------------------------------------------

@dataclass
class EvalContext:
    """Bars plus a per-strategy indicator cache."""

    bars: list[dict[str, Any]]

    def __post_init__(self) -> None:
        self.closes = [float(bar["close"]) for bar in self.bars]
        self._cache: dict[tuple, list] = {}

    def series(self, kind: str, **params: Any) -> list:
        key = (kind, tuple(sorted(params.items())))
        if key not in self._cache:
            if kind == "ema":
                self._cache[key] = ind.ema(self.closes, params["period"])
            elif kind == "sma":
                self._cache[key] = ind.sma(self.closes, params["period"])
            elif kind == "rsi":
                self._cache[key] = ind.rsi(self.closes, params["period"])
            elif kind == "macd":
                self._cache[key] = ind.macd(
                    self.closes, params["fast"], params["slow"], params["signal"]
                )
            elif kind == "atr":
                self._cache[key] = ind.atr(self.bars, params["period"])
            elif kind == "bollinger":
                self._cache[key] = ind.bollinger(
                    self.closes, params["period"], params["mult"]
                )
            else:
                raise StrategyError(f"unknown indicator: {kind}")
        return self._cache[key]

    def value(self, series: list, index: int) -> float | None:
        if index < 0 or index >= len(series):
            return None
        return series[index]


def _crossed(ctx: EvalContext, fast: list, slow: list, index: int, up: bool) -> bool:
    if index < 1:
        return False
    f0, s0 = ctx.value(fast, index - 1), ctx.value(slow, index - 1)
    f1, s1 = ctx.value(fast, index), ctx.value(slow, index)
    if None in (f0, s0, f1, s1):
        return False
    return (f0 <= s0 and f1 > s1) if up else (f0 >= s0 and f1 < s1)


def _compare(series: list, ctx: EvalContext, index: int, op: str, value: float) -> bool:
    current, previous = ctx.value(series, index), ctx.value(series, index - 1)
    if current is None:
        return False
    if op == "above":
        return current > value
    if op == "below":
        return current < value
    if previous is None:
        return False
    if op == "cross_up":
        return previous <= value < current
    return previous >= value > current


def _eval_condition(condition: Condition, ctx: EvalContext, index: int) -> bool:
    t = condition.type

    if t == "always":
        return True

    if t in {"ema_cross", "sma_cross"}:
        kind = "ema" if t == "ema_cross" else "sma"
        fast = ctx.series(kind, period=int(condition.fast))
        slow = ctx.series(kind, period=int(condition.slow))
        return _crossed(ctx, fast, slow, index, condition.direction == "up")

    if t in {"price_vs_ema", "price_vs_sma"}:
        kind = "ema" if t == "price_vs_ema" else "sma"
        series = ctx.series(kind, period=int(condition.period))
        band = ctx.value(series, index)
        if band is None:
            return False
        close = ctx.closes[index]
        op = condition.op or "above"
        if op == "above":
            return close > band
        if op == "below":
            return close < band
        previous_band = ctx.value(series, index - 1)
        if previous_band is None:
            return False
        previous_close = ctx.closes[index - 1]
        if op == "cross_up":
            return previous_close <= previous_band and close > band
        return previous_close >= previous_band and close < band

    if t == "rsi":
        series = ctx.series("rsi", period=int(condition.period))
        return _compare(series, ctx, index, condition.op or "above", float(condition.value or 50))

    if t == "macd":
        line, signal = ctx.series(
            "macd",
            fast=int(condition.fast),
            slow=int(condition.slow),
            signal=int(condition.period),
        )
        return _crossed(ctx, line, signal, index, condition.direction == "up")

    if t == "breakout":
        if condition.side == "high":
            level = ind.rolling_high(ctx.bars, int(condition.lookback), index)
            return level is not None and ctx.closes[index] > level
        level = ind.rolling_low(ctx.bars, int(condition.lookback), index)
        return level is not None and ctx.closes[index] < level

    if t == "bollinger":
        _, upper, lower = ctx.series(
            "bollinger", period=int(condition.period), mult=float(condition.mult)
        )
        band = ctx.value(upper if condition.side == "upper" else lower, index)
        if band is None:
            return False
        bar = ctx.bars[index]
        if condition.mode == "touch":
            return bar["high"] >= band if condition.side == "upper" else bar["low"] <= band
        return ctx.closes[index] > band if condition.side == "upper" else ctx.closes[index] < band

    if t == "atr_filter":
        series = ctx.series("atr", period=int(condition.period))
        value = ctx.value(series, index)
        return value is not None and value >= float(condition.min or 0)

    return False


def eval_group(group: Group | None, ctx: EvalContext, index: int) -> bool:
    if group is None:
        return False
    if group.all:
        return all(_eval_condition(c, ctx, index) for c in group.all)
    if group.any:
        return any(_eval_condition(c, ctx, index) for c in group.any)
    return False


def entry_side(manifest: StrategyManifest, ctx: EvalContext, index: int) -> str | None:
    """Return 'buy', 'sell' or None for the bar at ``index``."""
    if manifest.entryLong and eval_group(manifest.entryLong, ctx, index):
        return "buy"
    if manifest.entryShort and eval_group(manifest.entryShort, ctx, index):
        return "sell"
    if manifest.entry and eval_group(manifest.entry, ctx, index):
        return "buy" if manifest.direction == "long" else "sell"
    return None


def should_exit(manifest: StrategyManifest, ctx: EvalContext, index: int) -> bool:
    return manifest.exit is not None and eval_group(manifest.exit, ctx, index)


# --------------------------------------------------------------------------
# Built-in starter strategies (seeded into every fresh bridge database)
# --------------------------------------------------------------------------

def seed_strategies() -> list[StrategyManifest]:
    return [
        StrategyManifest(
            id="gold-ema-trend",
            name="Gold EMA trend + RSI filter",
            author="Vaelor desk",
            description=(
                "Classic trend continuation on gold: 20/50 EMA cross with an RSI "
                "momentum filter, ATR stop and 2R target, ATR trailing stop."
            ),
            symbols=["XAUUSD"],
            timeframe="H1",
            direction="both",
            entryLong=Group(
                all=[
                    Condition(type="ema_cross", fast=20, slow=50, direction="up"),
                    Condition(type="rsi", period=14, op="above", value=50),
                ]
            ),
            entryShort=Group(
                all=[
                    Condition(type="ema_cross", fast=20, slow=50, direction="down"),
                    Condition(type="rsi", period=14, op="below", value=50),
                ]
            ),
            exit=Group(
                any=[
                    Condition(type="ema_cross", fast=20, slow=50, direction="down"),
                ]
            ),
            stop={"type": "atr", "mult": 2.0},
            target={"type": "atr", "mult": 4.0},
            trail={"type": "atr", "mult": 1.5},
            risk={"riskPct": 1.0, "maxPositions": 1},
            tags=["trend", "metals"],
        ),
        StrategyManifest(
            id="fx-rsi-reversion",
            name="FX RSI mean reversion",
            author="Vaelor desk",
            description=(
                "Buys oversold RSI in an uptrend and sells overbought RSI in a "
                "downtrend, using the 200 EMA as the regime filter."
            ),
            symbols=["EURUSD", "GBPUSD"],
            timeframe="M15",
            direction="both",
            entryLong=Group(
                all=[
                    Condition(type="price_vs_ema", period=200, op="above"),
                    Condition(type="rsi", period=14, op="cross_up", value=30),
                ]
            ),
            entryShort=Group(
                all=[
                    Condition(type="price_vs_ema", period=200, op="below"),
                    Condition(type="rsi", period=14, op="cross_down", value=70),
                ]
            ),
            exit=Group(any=[Condition(type="rsi", period=14, op="cross_up", value=50)]),
            stop={"type": "atr", "mult": 1.5},
            target={"type": "atr", "mult": 2.5},
            risk={"riskPct": 0.75, "maxPositions": 2},
            tags=["mean-reversion", "fx"],
        ),
        StrategyManifest(
            id="index-breakout",
            name="Index 55-bar breakout",
            author="Vaelor desk",
            description=(
                "Donchian-style breakout on the Dow: close beyond the prior 55-bar "
                "extreme, wide ATR stop, 3R target."
            ),
            symbols=["US30"],
            timeframe="H1",
            direction="both",
            entryLong=Group(all=[Condition(type="breakout", lookback=55, side="high")]),
            entryShort=Group(all=[Condition(type="breakout", lookback=55, side="low")]),
            stop={"type": "atr", "mult": 2.0},
            target={"type": "atr", "mult": 6.0},
            risk={"riskPct": 1.0, "maxPositions": 1},
            tags=["breakout", "indices"],
        ),
        StrategyManifest(
            id="crypto-macd",
            name="Crypto MACD momentum",
            author="Vaelor desk",
            description=(
                "MACD signal-line cross in the direction of the 200 EMA trend on "
                "BTCUSD H4, ATR risk envelope."
            ),
            symbols=["BTCUSD"],
            timeframe="H4",
            direction="both",
            entryLong=Group(
                all=[
                    Condition(type="price_vs_ema", period=200, op="above"),
                    Condition(type="macd", fast=12, slow=26, period=9, direction="up"),
                ]
            ),
            entryShort=Group(
                all=[
                    Condition(type="price_vs_ema", period=200, op="below"),
                    Condition(type="macd", fast=12, slow=26, period=9, direction="down"),
                ]
            ),
            exit=Group(
                any=[Condition(type="macd", fast=12, slow=26, period=9, direction="down")]
            ),
            stop={"type": "atr", "mult": 2.5},
            target={"type": "atr", "mult": 5.0},
            risk={"riskPct": 1.0, "maxPositions": 1},
            tags=["momentum", "crypto"],
        ),
    ]


SEED_IDS = {s.id for s in seed_strategies()}

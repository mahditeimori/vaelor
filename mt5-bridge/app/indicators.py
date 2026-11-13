"""Small, dependency-free technical indicators.

All functions take a plain list and return a list of the same length, padded
with ``None`` until enough history exists. That keeps the backtester indexed by
bar number without any alignment bugs.
"""

from __future__ import annotations

from typing import Sequence


def sma(values: Sequence[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if period <= 0:
        return out
    total = 0.0
    for i, value in enumerate(values):
        total += value
        if i >= period:
            total -= values[i - period]
        if i >= period - 1:
            out[i] = total / period
    return out


def ema(values: Sequence[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    k = 2.0 / (period + 1.0)
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1.0 - k)
        out[i] = prev
    return out


def rsi(values: Sequence[float], period: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) <= period:
        return out
    gains = 0.0
    losses = 0.0
    for i in range(1, period + 1):
        delta = values[i] - values[i - 1]
        gains += max(delta, 0.0)
        losses += max(-delta, 0.0)
    avg_gain = gains / period
    avg_loss = losses / period
    out[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    for i in range(period + 1, len(values)):
        delta = values[i] - values[i - 1]
        gain = max(delta, 0.0)
        loss = max(-delta, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    return out


def macd(
    values: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[list[float | None], list[float | None]]:
    fast_line = ema(values, fast)
    slow_line = ema(values, slow)
    line: list[float | None] = [
        (f - s) if f is not None and s is not None else None
        for f, s in zip(fast_line, slow_line)
    ]
    # EMA of a series that starts with None: compress to the defined prefix.
    start = next((i for i, v in enumerate(line) if v is not None), None)
    sig: list[float | None] = [None] * len(values)
    if start is None:
        return line, sig
    defined = [v for v in line[start:] if v is not None]
    sig_defined = ema(defined, signal)
    for offset, value in enumerate(sig_defined):
        sig[start + offset] = value
    return line, sig


def true_range(bars: Sequence[dict]) -> list[float]:
    out: list[float] = []
    prev_close: float | None = None
    for bar in bars:
        high, low, close = bar["high"], bar["low"], bar["close"]
        if prev_close is None:
            out.append(high - low)
        else:
            out.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
        prev_close = close
    return out


def atr(bars: Sequence[dict], period: int = 14) -> list[float | None]:
    tr = true_range(bars)
    out: list[float | None] = [None] * len(tr)
    if len(tr) < period:
        return out
    value = sum(tr[:period]) / period
    out[period - 1] = value
    for i in range(period, len(tr)):
        value = (value * (period - 1) + tr[i]) / period
        out[i] = value
    return out


def bollinger(
    values: Sequence[float], period: int = 20, mult: float = 2.0
) -> tuple[list[float | None], list[float | None], list[float | None]]:
    mid = sma(values, period)
    upper: list[float | None] = [None] * len(values)
    lower: list[float | None] = [None] * len(values)
    if period <= 0:
        return mid, upper, lower
    for i in range(period - 1, len(values)):
        window = values[i - period + 1 : i + 1]
        mean = mid[i]
        if mean is None:
            continue
        variance = sum((v - mean) ** 2 for v in window) / period
        sd = variance**0.5
        upper[i] = mean + mult * sd
        lower[i] = mean - mult * sd
    return mid, upper, lower


def rolling_high(bars: Sequence[dict], lookback: int, index: int) -> float | None:
    """Highest high of the `lookback` bars strictly before `index`."""
    if index < lookback or lookback <= 0:
        return None
    window = bars[index - lookback : index]
    return max(bar["high"] for bar in window)


def rolling_low(bars: Sequence[dict], lookback: int, index: int) -> float | None:
    if index < lookback or lookback <= 0:
        return None
    window = bars[index - lookback : index]
    return min(bar["low"] for bar in window)

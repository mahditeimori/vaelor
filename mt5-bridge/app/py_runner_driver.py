"""Isolated runner for sandboxed Python strategies.

Started by ``python_backtest.run_python_backtest`` as
``python -I py_runner_driver.py``. It reads one JSON request on stdin and
writes one JSON result on stdout. Nothing else is imported from the bridge and
the strategy gets a restricted builtins namespace, so a bad strategy can fail
but cannot read the machine, the network or the environment.

The execution model matches the DSL backtester: signals are evaluated on closed
bars and filled at the next bar's open, stops are checked before targets inside
a candle, and position sizing is risk-based with a leverage cap.
"""

from __future__ import annotations

import json
import math
import sys

MAX_LOGS = 200

# Mirrors app.python_strategies.ALLOWED_IMPORTS. The driver enforces it again so
# the sandbox does not depend on analysis having run.
ALLOWED_MODULES = {
    "math",
    "statistics",
    "datetime",
    "typing",
    "dataclasses",
    "enum",
    "collections",
    "itertools",
    "functools",
    "decimal",
    "json",
    "re",
    "random",
}


# --------------------------------------------------------------------------
# Indicators (pure Python, computed once per period)
# --------------------------------------------------------------------------

def _sma(values, period):
    out = [None] * len(values)
    if period <= 0:
        return out
    running = 0.0
    for i, value in enumerate(values):
        running += value
        if i >= period:
            running -= values[i - period]
        if i >= period - 1:
            out[i] = running / period
    return out


def _ema(values, period):
    out = [None] * len(values)
    if period <= 0 or not values:
        return out
    alpha = 2.0 / (period + 1)
    ema_value = None
    for i, value in enumerate(values):
        if i + 1 < period:
            continue
        if ema_value is None:
            seed = sum(values[i + 1 - period : i + 1]) / period
            ema_value = seed
            out[i] = seed
            continue
        ema_value = value * alpha + ema_value * (1 - alpha)
        out[i] = ema_value
    return out


def _rsi(values, period):
    out = [None] * len(values)
    if period <= 1 or len(values) <= period:
        return out
    gains = 0.0
    losses = 0.0
    for i in range(1, period + 1):
        change = values[i] - values[i - 1]
        gains += max(change, 0.0)
        losses += max(-change, 0.0)
    avg_gain = gains / period
    avg_loss = losses / period
    out[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1 + avg_gain / avg_loss)
    for i in range(period + 1, len(values)):
        change = values[i] - values[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0.0)) / period
        out[i] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1 + avg_gain / avg_loss)
    return out


def _atr(bars, period):
    out = [None] * len(bars)
    if period <= 0 or len(bars) < 2:
        return out
    ranges = []
    for i, bar in enumerate(bars):
        if i == 0:
            ranges.append(float(bar["high"]) - float(bar["low"]))
        else:
            prev_close = float(bars[i - 1]["close"])
            ranges.append(
                max(
                    float(bar["high"]) - float(bar["low"]),
                    abs(float(bar["high"]) - prev_close),
                    abs(float(bar["low"]) - prev_close),
                )
            )
    running = 0.0
    for i, value in enumerate(ranges):
        running += value
        if i >= period:
            running -= ranges[i - period]
        if i >= period - 1:
            out[i] = running / period
    return out


# --------------------------------------------------------------------------
# Strategy-facing context
# --------------------------------------------------------------------------

class Context:
    __slots__ = (
        "bars",
        "index",
        "position",
        "equity",
        "initial_balance",
        "symbol",
        "timeframe",
        "digits",
        "pip",
        "contract",
        "_closes",
        "_highs",
        "_lows",
        "_cache",
        "_logs",
    )

    def __init__(self, request, bars, index, position, equity, cache, logs):
        self.bars = bars
        self.index = index
        self.position = position
        self.equity = equity
        self.initial_balance = request["initialBalance"]
        self.symbol = request["symbol"]["symbol"]
        self.timeframe = request["timeframe"]
        self.digits = request["symbol"]["digits"]
        self.pip = request["symbol"]["pip"]
        self.contract = request["symbol"]["contract"]
        self._closes = request["_closes"]
        self._highs = request["_highs"]
        self._lows = request["_lows"]
        self._cache = cache
        self._logs = logs

    # current bar -----------------------------------------------------------
    @property
    def bar(self):
        return self.bars[self.index]

    @property
    def time(self):
        return int(self.bars[self.index]["time"])

    @property
    def open(self):
        return float(self.bars[self.index]["open"])

    @property
    def high(self):
        return float(self.bars[self.index]["high"])

    @property
    def low(self):
        return float(self.bars[self.index]["low"])

    @property
    def close(self):
        return float(self.bars[self.index]["close"])

    @property
    def volume(self):
        return float(self.bars[self.index].get("volume") or 0.0)

    @property
    def has_position(self):
        return self.position is not None

    # indicators ------------------------------------------------------------
    def _series(self, key, builder):
        series = self._cache.get(key)
        if series is None:
            series = builder()
            self._cache[key] = series
        return series

    def sma(self, period):
        period = int(period)
        return self._series(("sma", period), lambda: _sma(self._closes, period))

    def ema(self, period):
        period = int(period)
        return self._series(("ema", period), lambda: _ema(self._closes, period))

    def rsi(self, period):
        period = int(period)
        return self._series(("rsi", period), lambda: _rsi(self._closes, period))

    def atr(self, period=14):
        period = int(period)
        return self._series(("atr", period), lambda: _atr(self.bars, period))

    def value(self, series, offset=0):
        index = self.index + int(offset)
        if 0 <= index < len(series):
            return series[index]
        return None

    def crossover(self, fast, slow):
        now_fast = self.value(fast)
        now_slow = self.value(slow)
        prev_fast = self.value(fast, -1)
        prev_slow = self.value(slow, -1)
        if None in (now_fast, now_slow):
            return False
        if prev_fast is None or prev_slow is None:
            return False
        return prev_fast <= prev_slow and now_fast > now_slow

    def crossunder(self, fast, slow):
        now_fast = self.value(fast)
        now_slow = self.value(slow)
        prev_fast = self.value(fast, -1)
        prev_slow = self.value(slow, -1)
        if None in (now_fast, now_slow):
            return False
        if prev_fast is None or prev_slow is None:
            return False
        return prev_fast >= prev_slow and now_fast < now_slow

    def highest(self, period):
        start = max(0, self.index + 1 - int(period))
        return max(self._highs[start : self.index + 1])

    def lowest(self, period):
        start = max(0, self.index + 1 - int(period))
        return min(self._lows[start : self.index + 1])

    def highest_close(self, period):
        start = max(0, self.index + 1 - int(period))
        return max(self._closes[start : self.index + 1])

    def lowest_close(self, period):
        start = max(0, self.index + 1 - int(period))
        return min(self._closes[start : self.index + 1])

    def bars_since_entry(self):
        if not self.position:
            return 0
        return self.index - int(self.position.get("entry_index", self.index))

    def log(self, message):
        if len(self._logs) < MAX_LOGS:
            self._logs.append(str(message)[:400])


# --------------------------------------------------------------------------
# Execution engine
# --------------------------------------------------------------------------

def _round_lots(lots):
    return max(0.01, math.floor(lots / 0.01) * 0.01)


def _as_float(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    return None


def _normalize_signal(signal):
    if signal is None:
        return None
    if isinstance(signal, str):
        action = signal.strip().lower()
        return {"action": action} if action else None
    if isinstance(signal, dict):
        action = signal.get("action") or signal.get("side") or signal.get("signal")
        if not isinstance(action, str):
            return None
        normalized = dict(signal)
        normalized["action"] = action.strip().lower()
        return normalized
    return None


def run(request):
    code = request["code"]
    bars = request["bars"]
    symbol = request["symbol"]
    spread = max(0.0, float(request.get("spreadPips") or 0.0)) * float(symbol["pip"])
    commission = max(0.0, float(request.get("commissionPerLot") or 0.0))
    leverage = max(1, int(request.get("leverage") or 100))
    risk_pct = request.get("riskPct")
    if risk_pct is None:
        risk_pct = request.get("defaultRiskPct") or 1.0
    risk_pct = max(0.05, min(10.0, float(risk_pct)))
    max_lots = min(100.0, float(request.get("maxLots") or 100.0))
    stop_atr = max(0.1, float(request.get("stopAtr") or 2.0))
    target_atr = max(0.1, float(request.get("targetAtr") or 4.0))

    logs = []
    namespace = {"__name__": "vaelor_strategy", "__builtins__": _safe_builtins(logs)}
    try:
        exec(compile(code, "<strategy>", "exec"), namespace)  # noqa: S102 - sandboxed namespace
        on_bar = namespace.get("on_bar")
        if not callable(on_bar):
            return {"ok": False, "error": "strategy did not define on_bar(ctx)"}
        meta = namespace.get("META")
        meta = meta if isinstance(meta, dict) else {}
    except Exception as exc:  # noqa: BLE001 - report strategy errors verbatim
        return {"ok": False, "error": f"strategy failed while loading: {exc}"}

    warmup = meta.get("warmup")
    warmup = int(warmup) if isinstance(warmup, (int, float)) and warmup > 0 else 30
    warmup = max(2, min(warmup, max(2, len(bars) - 2)))

    if len(bars) < warmup + 5:
        return {"ok": False, "error": "not enough bars for this strategy's warm-up"}

    cache = {}
    state = {
        "positions": [],
        "closes": [float(b["close"]) for b in bars],
        "highs": [float(b["high"]) for b in bars],
        "lows": [float(b["low"]) for b in bars],
    }

    class Req(dict):
        pass

    req = Req(request)
    req["_closes"] = state["closes"]
    req["_highs"] = state["highs"]
    req["_lows"] = state["lows"]

    equity = float(request["initialBalance"])
    peak = equity
    position = None
    pending = None
    trades = []
    curve = []

    def atr_at(index, period=14):
        series = cache.get(("atr", period))
        if series is None:
            series = _atr(bars, period)
            cache[("atr", period)] = series
        value = series[index] if 0 <= index < len(series) else None
        return value

    def open_position(side, index, base_price, signal, signal_atr):
        nonlocal equity, position, peak
        fill = base_price + (spread / 2 if side == "buy" else -spread / 2)
        direction = 1 if side == "buy" else -1

        requested_sl = _as_float(signal.get("sl") or signal.get("stop"))
        requested_tp = _as_float(signal.get("tp") or signal.get("target"))
        requested_lots = _as_float(signal.get("lots") or signal.get("volume"))

        stop_distance = None
        target_distance = None
        if requested_sl is not None:
            stop_distance = (fill - requested_sl) * direction
        elif _as_float(signal.get("stop_pips")) is not None:
            stop_distance = float(signal["stop_pips"]) * float(symbol["pip"])
        elif _as_float(signal.get("stop_atr")) is not None:
            stop_distance = (_as_float(signal.get("stop_atr")) or stop_atr) * (
                signal_atr or fill * 0.005
            )
        elif signal_atr:
            stop_distance = stop_atr * signal_atr
        else:
            stop_distance = fill * 0.005

        if requested_tp is not None:
            target_distance = (requested_tp - fill) * direction
        elif _as_float(signal.get("target_pips")) is not None:
            target_distance = float(signal["target_pips"]) * float(symbol["pip"])
        elif _as_float(signal.get("target_atr")) is not None:
            target_distance = (_as_float(signal.get("target_atr")) or target_atr) * (
                signal_atr or fill * 0.005
            )
        elif signal_atr:
            target_distance = target_atr * signal_atr
        else:
            target_distance = stop_distance * 2

        if not stop_distance or stop_distance <= 0:
            stop_distance = fill * 0.005
        if target_distance is not None and target_distance <= 0:
            target_distance = None

        risk_amount = equity * risk_pct / 100.0
        if requested_lots is not None and requested_lots > 0:
            lots = requested_lots
        else:
            lots = risk_amount / (stop_distance * float(symbol["contract"]))
        lots = _round_lots(min(lots, max_lots))

        notional = lots * float(symbol["contract"]) * fill
        max_notional = equity * leverage
        if max_notional > 0 and notional > max_notional:
            lots = _round_lots(max(0.01, lots * max_notional / notional))
        if lots <= 0:
            return

        trail_distance = None
        if _as_float(signal.get("trail")) is not None:
            trail_distance = abs(float(signal["trail"]))
        elif _as_float(signal.get("trail_atr")) is not None and signal_atr:
            trail_distance = abs(float(signal["trail_atr"])) * signal_atr

        position = {
            "side": side,
            "entry": fill,
            "lots": lots,
            "sl": fill - stop_distance if side == "buy" else fill + stop_distance,
            "tp": (
                fill + target_distance
                if direction == 1 and target_distance
                else fill - target_distance
                if target_distance
                else None
            ),
            "entry_index": index,
            "entry_time": bars[index]["time"],
            "best": fill,
            "risk": risk_amount,
            "trail": trail_distance,
            "exit_pending": False,
        }

    def close_position(index, base_price, reason):
        nonlocal equity, position
        if position is None:
            return
        side = position["side"]
        price = base_price - (spread / 2 if side == "buy" else -spread / 2)
        direction = 1 if side == "buy" else -1
        pnl = (price - position["entry"]) * direction * position["lots"] * float(
            symbol["contract"]
        )
        pnl -= commission * position["lots"]
        equity += pnl
        trades.append(
            {
                "side": side,
                "entry": round(position["entry"], int(symbol["digits"])),
                "exit": round(price, int(symbol["digits"])),
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

        if position is None and pending is not None:
            open_position(
                pending["side"], i, float(bar["open"]), pending["signal"], pending["atr"]
            )
            pending = None

        if position is not None:
            if position["exit_pending"]:
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
                elif position.get("trail"):
                    if position["side"] == "buy":
                        position["best"] = max(position["best"], bar["high"])
                        candidate = position["best"] - position["trail"]
                        if candidate > position["sl"]:
                            position["sl"] = candidate
                    else:
                        position["best"] = min(position["best"], bar["low"])
                        candidate = position["best"] + position["trail"]
                        if candidate < position["sl"]:
                            position["sl"] = candidate

        ctx = Context(req, bars, i, position, equity, cache, logs)
        try:
            signal = _normalize_signal(on_bar(ctx))
        except Exception as exc:  # noqa: BLE001 - report the strategy's own error
            return {
                "ok": False,
                "error": f"on_bar failed at bar {i} ({ctx.time}): {exc}",
                "logs": logs,
            }

        if signal:
            action = signal.get("action")
            if position is not None:
                if action in {"close", "exit", "flat", "sell_close", "buy_close"}:
                    position["exit_pending"] = True
            elif action in {"buy", "long"}:
                pending = {"side": "buy", "signal": signal, "atr": atr_at(i)}
            elif action in {"sell", "short"}:
                pending = {"side": "sell", "signal": signal, "atr": atr_at(i)}

        floating = 0.0
        if position is not None:
            direction = 1 if position["side"] == "buy" else -1
            floating = (
                (float(bar["close"]) - position["entry"])
                * direction
                * position["lots"]
                * float(symbol["contract"])
            )
        marked = equity + floating
        peak = max(peak, marked)
        curve.append({"time": bar["time"], "equity": round(marked, 2)})

    if position is not None:
        close_position(len(bars) - 1, float(bars[-1]["close"]), "end_of_data")
        curve.append({"time": bars[-1]["time"], "equity": round(equity, 2)})

    return {
        "ok": True,
        "trades": trades,
        "curve": curve,
        "warmup": warmup,
        "logs": logs,
        "meta": {"name": meta.get("name"), "id": meta.get("id")},
    }


def _safe_builtins(logs):
    """A deliberately small builtins table for strategy code."""
    import builtins as _builtins

    def _print(*args, sep=" ", end="\n"):
        text = sep.join(str(a) for a in args)
        if len(logs) < MAX_LOGS:
            logs.append(text[:400])
        return None

    def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002
        root = str(name).split(".")[0]
        if root not in ALLOWED_MODULES:
            raise ImportError(
                f"import '{name}' is not available inside a strategy "
                f"(allowed: {', '.join(sorted(ALLOWED_MODULES))})"
            )
        return _builtins.__import__(name, globals, locals, fromlist, level)

    table = {
        "abs": abs,
        "all": all,
        "any": any,
        "bool": bool,
        "chr": chr,
        "dict": dict,
        "divmod": divmod,
        "enumerate": enumerate,
        "filter": filter,
        "float": float,
        "format": format,
        "frozenset": frozenset,
        "int": int,
        "isinstance": isinstance,
        "issubclass": issubclass,
        "len": len,
        "list": list,
        "map": map,
        "max": max,
        "min": min,
        "next": next,
        "ord": ord,
        "pow": pow,
        "print": _print,
        "range": range,
        "reversed": reversed,
        "round": round,
        "set": set,
        "slice": slice,
        "sorted": sorted,
        "str": str,
        "sum": sum,
        "tuple": tuple,
        "zip": zip,
        "True": True,
        "False": False,
        "None": None,
        "Exception": Exception,
        "ValueError": ValueError,
        "TypeError": TypeError,
        "ZeroDivisionError": ZeroDivisionError,
        "KeyError": KeyError,
        "IndexError": IndexError,
        "ArithmeticError": ArithmeticError,
        "__build_class__": __build_class__,
        "__import__": _safe_import,
    }
    return table


def main():
    try:
        raw = sys.stdin.read()
        request = json.loads(raw)
        result = run(request)
    except Exception as exc:  # noqa: BLE001 - always answer the parent
        result = {"ok": False, "error": f"runner failed: {exc}"}
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()

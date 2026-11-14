"""Broker providers: a real MetaTrader 5 terminal and a simulation broker.

Both expose the same normalized interface, so the strategy engine, the
backtester and the browser UI never care which one is active. The simulation
broker is explicit about being virtual and is the only one used when MT5 is
not authorized on the machine.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from .config import SETTINGS
from .models import TF_MINUTES
from .store import Store

try:  # MetaTrader5 is Windows-only; keep the bridge importable everywhere.
    import MetaTrader5 as mt5  # type: ignore
except Exception:  # pragma: no cover - non-Windows / package missing
    mt5 = None


# --------------------------------------------------------------------------
# Symbol catalogue
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class SymbolSpec:
    symbol: str
    description: str
    digits: int
    pip: float
    contract: float
    base: float
    vol: float
    spread_pips: float = 1.0
    min_lot: float = 0.01
    max_lot: float = 100.0
    lot_step: float = 0.01

    def as_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "description": self.description,
            "digits": self.digits,
            "pip": self.pip,
            "contract": self.contract,
            "minLot": self.min_lot,
            "maxLot": self.max_lot,
            "lotStep": self.lot_step,
            "spreadPips": self.spread_pips,
        }


SIM_SYMBOLS: dict[str, SymbolSpec] = {
    "XAUUSD": SymbolSpec("XAUUSD", "Gold vs US Dollar", 2, 0.1, 100, 2650.0, 0.0012, 2.5),
    "XAGUSD": SymbolSpec("XAGUSD", "Silver vs US Dollar", 3, 0.01, 5000, 31.0, 0.0016, 3.0),
    "EURUSD": SymbolSpec("EURUSD", "Euro vs US Dollar", 5, 0.0001, 100000, 1.085, 0.00055, 1.0),
    "GBPUSD": SymbolSpec("GBPUSD", "British Pound vs US Dollar", 5, 0.0001, 100000, 1.272, 0.0006, 1.2),
    "USDJPY": SymbolSpec("USDJPY", "US Dollar vs Japanese Yen", 3, 0.01, 100000, 152.4, 0.0006, 1.1),
    "US30": SymbolSpec("US30", "Dow Jones 30 index", 1, 1.0, 1, 44250.0, 0.0009, 2.0),
    "NAS100": SymbolSpec("NAS100", "Nasdaq 100 index", 1, 1.0, 1, 21150.0, 0.0011, 1.8),
    "SPX500": SymbolSpec("SPX500", "S&P 500 index", 1, 1.0, 1, 6050.0, 0.0008, 1.5),
    "BTCUSD": SymbolSpec("BTCUSD", "Bitcoin vs US Dollar", 2, 1.0, 1, 96500.0, 0.0038, 15.0),
}

# Worker instrument ids used for real historical data in simulation mode.
CLOUD_SERIES = {
    "XAUUSD": "gold",
    "XAGUSD": "silver",
    "NAS100": "nasdaq",
    "US30": "dow",
    "SPX500": "sp500",
    "BTCUSD": "bitcoin",
}

CLOUD_INTERVALS = {
    "M1": ("5d", "1m"),
    "M5": ("1mo", "5m"),
    "M15": ("3mo", "15m"),
    "M30": ("3mo", "30m"),
    "H1": ("2y", "1h"),
    "D1": ("2y", "1d"),
    "W1": ("2y", "1wk"),
}


def spec_for(symbol: str) -> SymbolSpec:
    sym = symbol.upper()
    if sym in SIM_SYMBOLS:
        return SIM_SYMBOLS[sym]
    # Broker-specific names for the index contracts, so sizing and P/L use the
    # same numbers as the canonical symbol (FOREX.com uses DJIUSD/NDXUSD).
    alias = {
        "DJIUSD": "US30",
        "US30CASH": "US30",
        "NDXUSD": "NAS100",
        "NAS100CASH": "NAS100",
        "SPXUSD": "SPX500",
        "US500": "SPX500",
    }.get(sym)
    if alias:
        return SIM_SYMBOLS[alias]
    # Unknown symbols (custom MT5 broker names) get conservative FX defaults.
    return SymbolSpec(sym, sym, 5, 0.0001, 100000, 1.0, 0.0006, 1.5)


def strategy_magic(strategy_id: str) -> int:
    digest = hashlib.sha1(strategy_id.encode("utf-8")).hexdigest()[:8]
    return int(digest, 16) % 2_000_000_000 + 1


# --------------------------------------------------------------------------
# Base provider
# --------------------------------------------------------------------------

class Provider:
    name = "base"
    mode = "simulation"
    connected = False
    reason = ""

    def status(self) -> dict:
        return {"provider": self.name, "mode": self.mode, "connected": self.connected,
                "reason": self.reason}

    def account(self) -> dict:  # pragma: no cover - interface
        raise NotImplementedError

    def symbols(self) -> list[dict]:  # pragma: no cover
        raise NotImplementedError

    def quote(self, symbol: str) -> dict:  # pragma: no cover
        raise NotImplementedError

    def min_stop_distance(self, symbol: str) -> float:  # pragma: no cover - interface
        """Smallest distance from price at which a stop is accepted.

        Zero means the venue has no minimum, so a break-even stop at the entry
        price is always valid.
        """
        return 0.0

    def positions(self) -> list[dict]:  # pragma: no cover
        raise NotImplementedError

    def orders(self) -> list[dict]:  # pragma: no cover
        raise NotImplementedError

    def history(self, days: int = 30) -> list[dict]:  # pragma: no cover
        raise NotImplementedError

    def place_market(self, symbol: str, side: str, volume: float, *, sl: float | None,
                     tp: float | None, comment: str, magic: int,
                     strategy_id: str | None) -> dict:  # pragma: no cover
        raise NotImplementedError

    def place_limit(self, symbol: str, side: str, volume: float, price: float, *,
                    sl: float | None, tp: float | None, comment: str, magic: int,
                    strategy_id: str | None) -> dict:  # pragma: no cover
        raise NotImplementedError

    def modify(self, ticket: int, *, sl: float | None, tp: float | None) -> dict:  # pragma: no cover
        raise NotImplementedError

    def close_position(self, ticket: int, volume: float | None = None, *,
                       price: float | None = None, reason: str = "manual") -> dict:  # pragma: no cover
        raise NotImplementedError

    def rates(self, symbol: str, timeframe: str, start: int, end: int) -> list[dict]:  # pragma: no cover
        raise NotImplementedError

    def update_quotes(self) -> None:
        return None

    def poll(self) -> dict:
        return {"fills": [], "triggers": []}

    def resolve_symbol(self, symbol: str) -> str:
        return symbol.upper()


# --------------------------------------------------------------------------
# Simulation provider
# --------------------------------------------------------------------------

class SimProvider(Provider):
    name = "simulation"
    mode = "simulation"

    def __init__(self, store: Store) -> None:
        self.store = store
        self.connected = True
        self.reason = "MT5 terminal not available — virtual broker with live-style quotes"
        self._rng = random.Random(0xC0FFEE)
        self._prices: dict[str, float] = {}
        self._anchors: dict[str, float] = {}
        self._day_open: dict[str, float] = {}
        self._last_tick = time.time()
        self._cloud_cache: dict[tuple, list[dict]] = {}
        self._lock = threading.Lock()
        balance = self.store.get_kv("sim_balance")
        self.balance = float(balance) if balance else SETTINGS.sim_balance
        self.leverage = SETTINGS.sim_leverage
        for sym, spec in SIM_SYMBOLS.items():
            phase = (int(hashlib.sha1(sym.encode()).hexdigest()[:6], 16) % 1000) / 1000
            anchor = spec.base * (1 + (phase - 0.5) * 0.08)
            self._anchors[sym] = anchor
            self._prices[sym] = anchor
            self._day_open[sym] = anchor

    # ------------------------------------------------------------- quotes
    def _spread(self, symbol: str) -> float:
        spec = spec_for(symbol)
        return spec.spread_pips * spec.pip

    def update_quotes(self) -> None:
        now = time.time()
        dt = min(max(now - self._last_tick, 0.1), 5.0)
        self._last_tick = now
        with self._lock:
            for sym, spec in SIM_SYMBOLS.items():
                price = self._prices[sym]
                anchor = self._anchors[sym]
                drift = 0.02 * math.log(anchor / price) * dt
                shock = self._rng.gauss(0, spec.vol) * math.sqrt(dt / 60.0)
                price *= math.exp(drift + shock)
                self._prices[sym] = max(price, spec.base * 0.25)

    def _price(self, symbol: str) -> float:
        sym = symbol.upper()
        if sym not in self._prices:
            self._prices[sym] = spec_for(sym).base
            self._anchors[sym] = self._prices[sym]
        return self._prices[sym]

    def quote(self, symbol: str) -> dict:
        sym = self.resolve_symbol(symbol)
        mid = self._price(sym)
        half = self._spread(sym) / 2
        spec = spec_for(sym)
        day = self._day_open.get(sym, mid)
        return {
            "symbol": sym,
            "bid": round(mid - half, spec.digits),
            "ask": round(mid + half, spec.digits),
            "mid": round(mid, spec.digits),
            "time": int(time.time()),
            "changePct": round((mid / day - 1) * 100, 3) if day else 0.0,
        }

    # ------------------------------------------------------------ symbols
    def symbols(self) -> list[dict]:
        out = []
        for spec in SIM_SYMBOLS.values():
            item = spec.as_dict()
            item["price"] = self.quote(spec.symbol)["mid"]
            out.append(item)
        return out

    def resolve_symbol(self, symbol: str) -> str:
        sym = symbol.upper()
        return sym if sym in SIM_SYMBOLS else sym

    # ----------------------------------------------------------- account
    def account(self) -> dict:
        positions = self.positions()
        floating = sum(p["profit"] for p in positions)
        margin = sum(
            abs(p["volume"]) * spec_for(p["symbol"]).contract * (p.get("currentPrice") or p["openPrice"]) / self.leverage
            for p in positions
        )
        equity = self.balance + floating
        return {
            "login": 900001,
            "server": "Vaelor Simulation",
            "currency": "USD",
            "balance": round(self.balance, 2),
            "equity": round(equity, 2),
            "margin": round(margin, 2),
            "freeMargin": round(equity - margin, 2),
            "marginLevel": round(equity / margin * 100, 2) if margin > 0 else 0.0,
            "leverage": self.leverage,
            "profit": round(floating, 2),
            "mode": "simulation",
        }

    # ---------------------------------------------------------- positions
    def positions(self) -> list[dict]:
        rows = self.store.list_paper_positions()
        out = []
        for p in rows:
            spec = spec_for(p["symbol"])
            quote = self.quote(p["symbol"])
            close = quote["bid"] if p["side"] == "buy" else quote["ask"]
            direction = 1 if p["side"] == "buy" else -1
            profit = (close - p["open_price"]) * direction * p["volume"] * spec.contract
            out.append(
                {
                    "ticket": p["ticket"],
                    "symbol": p["symbol"],
                    "side": p["side"],
                    "volume": p["volume"],
                    "openPrice": round(p["open_price"], spec.digits),
                    "currentPrice": round(close, spec.digits),
                    "sl": p["sl"],
                    "tp": p["tp"],
                    "profit": round(profit, 2),
                    "swap": 0.0,
                    "commission": 0.0,
                    "magic": p["magic"],
                    "comment": p["comment"],
                    "strategyId": p["strategyId"],
                    "opened": p["opened"],
                }
            )
        return out

    def orders(self) -> list[dict]:
        return self.store.list_paper_orders()

    def history(self, days: int = 30) -> list[dict]:
        deals = self.store.list_paper_deals()
        cutoff = time.time() - days * 86400
        out = []
        for d in deals:
            try:
                ts = datetime.strptime(d["closed"], "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=timezone.utc
                ).timestamp()
            except Exception:
                ts = time.time()
            if ts >= cutoff:
                out.append(d)
        return out

    # ------------------------------------------------------------- orders
    def _validate_volume(self, symbol: str, volume: float) -> tuple[float, str | None]:
        spec = spec_for(symbol)
        step = spec.lot_step
        if volume < spec.min_lot:
            return 0.0, f"volume below min lot ({spec.min_lot})"
        if volume > spec.max_lot:
            return 0.0, f"volume above max lot ({spec.max_lot})"
        return round(round(volume / step) * step, 2), None

    def place_market(self, symbol, side, volume, *, sl, tp, comment, magic, strategy_id) -> dict:
        sym = self.resolve_symbol(symbol)
        spec = spec_for(sym)
        volume, error = self._validate_volume(sym, volume)
        if error:
            raise ValueError(error)
        quote = self.quote(sym)
        price = quote["ask"] if side == "buy" else quote["bid"]
        if sl is not None:
            if side == "buy" and sl >= price:
                raise ValueError("stop loss must be below the entry for a buy")
            if side == "sell" and sl <= price:
                raise ValueError("stop loss must be above the entry for a sell")
        if tp is not None:
            if side == "buy" and tp <= price:
                raise ValueError("take profit must be above the entry for a buy")
            if side == "sell" and tp >= price:
                raise ValueError("take profit must be below the entry for a sell")
        ticket = self.store.next_ticket()
        self.store.insert_paper_position(
            {
                "ticket": ticket,
                "symbol": sym,
                "side": side,
                "volume": volume,
                "open_price": price,
                "sl": sl,
                "tp": tp,
                "magic": magic,
                "comment": comment,
                "strategyId": strategy_id,
            }
        )
        return {
            "ticket": ticket, "symbol": sym, "side": side, "volume": volume,
            "price": round(price, spec.digits), "sl": sl, "tp": tp,
            "status": "filled", "comment": comment, "strategyId": strategy_id,
        }

    def place_limit(self, symbol, side, volume, price, *, sl, tp, comment, magic, strategy_id) -> dict:
        sym = self.resolve_symbol(symbol)
        spec = spec_for(sym)
        volume, error = self._validate_volume(sym, volume)
        if error:
            raise ValueError(error)
        quote = self.quote(sym)
        if side == "buy" and price >= quote["ask"]:
            raise ValueError("buy limit must be below the current ask")
        if side == "sell" and price <= quote["bid"]:
            raise ValueError("sell limit must be above the current bid")
        ticket = self.store.next_ticket()
        self.store.insert_paper_order(
            {
                "ticket": ticket, "symbol": sym, "side": side, "volume": volume,
                "type": "limit", "price": round(price, spec.digits), "sl": sl, "tp": tp,
                "comment": comment, "strategyId": strategy_id,
            }
        )
        return {
            "ticket": ticket, "symbol": sym, "side": side, "volume": volume,
            "price": round(price, spec.digits), "sl": sl, "tp": tp,
            "status": "pending", "comment": comment, "strategyId": strategy_id,
        }

    def modify(self, ticket: int, *, sl: float | None, tp: float | None) -> dict:
        rows = {p["ticket"]: p for p in self.store.list_paper_positions()}
        if ticket not in rows:
            raise ValueError("position not found")
        fields = {}
        if sl is not None:
            fields["sl"] = sl if sl > 0 else None
        if tp is not None:
            fields["tp"] = tp if tp > 0 else None
        self.store.update_paper_position(ticket, **fields)
        return {"ticket": ticket, "sl": fields.get("sl"), "tp": fields.get("tp"), "status": "modified"}

    def close_position(self, ticket: int, volume: float | None = None, *,
                       price: float | None = None, reason: str = "manual") -> dict:
        rows = {p["ticket"]: p for p in self.store.list_paper_positions()}
        pos = rows.get(ticket)
        if not pos:
            raise ValueError("position not found")
        spec = spec_for(pos["symbol"])
        quote = self.quote(pos["symbol"])
        close_price = price if price is not None else (
            quote["bid"] if pos["side"] == "buy" else quote["ask"]
        )
        close_volume = pos["volume"] if volume is None else min(volume, pos["volume"])
        if close_volume < spec.min_lot:
            close_volume = pos["volume"]
        direction = 1 if pos["side"] == "buy" else -1
        pnl = (close_price - pos["open_price"]) * direction * close_volume * spec.contract
        self.balance += pnl
        self.store.set_kv("sim_balance", str(round(self.balance, 6)))
        remaining = round(pos["volume"] - close_volume, 2)
        if remaining < spec.min_lot:
            self.store.delete_paper_position(ticket)
            remaining = 0.0
        else:
            self.store.update_paper_position(ticket, volume=remaining)
        self.store.insert_paper_deal(
            {
                "ticket": ticket, "symbol": pos["symbol"], "side": pos["side"],
                "volume": close_volume, "open_price": pos["open_price"],
                "close_price": close_price, "pnl": round(pnl, 2),
                "magic": pos["magic"], "comment": pos["comment"],
                "strategyId": pos["strategyId"], "opened": pos["opened"],
            }
        )
        return {
            "ticket": ticket, "symbol": pos["symbol"], "closedVolume": close_volume,
            "remainingVolume": remaining, "closePrice": round(close_price, spec.digits),
            "pnl": round(pnl, 2), "reason": reason, "status": "closed",
        }

    def poll(self) -> dict:
        """Fill resting limits and trigger stops/targets for simulation."""
        fills = []
        for order in self.store.list_paper_orders():
            quote = self.quote(order["symbol"])
            fill = (order["side"] == "buy" and quote["ask"] <= order["price"]) or (
                order["side"] == "sell" and quote["bid"] >= order["price"]
            )
            if not fill:
                continue
            self.store.delete_paper_order(order["ticket"])
            ticket = order["ticket"]
            self.store.insert_paper_position(
                {
                    "ticket": ticket,
                    "symbol": order["symbol"],
                    "side": order["side"],
                    "volume": order["volume"],
                    "open_price": order["price"],
                    "sl": order["sl"],
                    "tp": order["tp"],
                    "magic": strategy_magic(order.get("strategyId") or "manual") if order.get("strategyId") else 0,
                    "comment": order.get("comment", ""),
                    "strategyId": order.get("strategyId"),
                }
            )
            fills.append({"ticket": ticket, "symbol": order["symbol"], "price": order["price"]})

        triggers = []
        for pos in self.store.list_paper_positions():
            quote = self.quote(pos["symbol"])
            if pos["side"] == "buy":
                if pos["sl"] is not None and quote["bid"] <= pos["sl"]:
                    triggers.append({"ticket": pos["ticket"], "price": pos["sl"], "reason": "stop"})
                elif pos["tp"] is not None and quote["bid"] >= pos["tp"]:
                    triggers.append({"ticket": pos["ticket"], "price": pos["tp"], "reason": "target"})
            else:
                if pos["sl"] is not None and quote["ask"] >= pos["sl"]:
                    triggers.append({"ticket": pos["ticket"], "price": pos["sl"], "reason": "stop"})
                elif pos["tp"] is not None and quote["ask"] <= pos["tp"]:
                    triggers.append({"ticket": pos["ticket"], "price": pos["tp"], "reason": "target"})
        return {"fills": fills, "triggers": triggers}

    # -------------------------------------------------------- historical
    def rates(self, symbol: str, timeframe: str, start: int, end: int) -> list[dict]:
        sym = symbol.upper()
        if SETTINGS.sim_data != "synthetic":
            bars = self._cloud_rates(sym, timeframe, start, end)
            if bars:
                return [b for b in bars if start <= b["time"] <= end]
        return synthetic_bars(sym, timeframe, start, end)

    def _cloud_rates(self, symbol: str, timeframe: str, start: int, end: int) -> list[dict] | None:
        series = CLOUD_SERIES.get(symbol)
        mapping = CLOUD_INTERVALS.get(timeframe)
        if not series or not mapping:
            return None
        key = (series, timeframe)
        if key in self._cloud_cache:
            return [b for b in self._cloud_cache[key] if start <= b["time"] <= end]
        range_, interval = mapping
        query = urllib.parse.urlencode({"id": series, "range": range_, "interval": interval})
        url = f"{SETTINGS.cloud_url}/api/chart?{query}"
        try:
            req = urllib.request.Request(url, headers={"accept": "application/json"})
            with urllib.request.urlopen(req, timeout=8) as res:
                payload = json.loads(res.read().decode("utf-8"))
            bars = payload.get("bars") or []
            if len(bars) < 60:
                return None
            self._cloud_cache[key] = bars
            return [b for b in bars if start <= b["time"] <= end]
        except Exception:
            return None


# --------------------------------------------------------------------------
# Synthetic history
# --------------------------------------------------------------------------

def synthetic_bars(symbol: str, timeframe: str, start: int, end: int) -> list[dict]:
    """Deterministic multi-regime random walk, seeded by symbol + timeframe."""
    step = TF_MINUTES.get(timeframe.upper(), 60) * 60
    if step <= 0 or end <= start:
        return []
    start = int(start // step * step)
    count = int((end - start) // step) + 1
    if count < 10:
        return []
    count = min(count, 60_000)

    spec = spec_for(symbol)
    seed = int(hashlib.sha256(f"{symbol}:{timeframe}:{start}".encode()).hexdigest()[:16], 16)
    rng = random.Random(seed)
    phase = (seed % 10_000) / 10_000 * math.tau
    price = spec.base
    bars: list[dict] = []
    for i in range(count):
        ts = start + i * step
        regime = math.sin(ts / 86400 / 55 + phase) * spec.vol * 0.22
        shock = rng.gauss(0, spec.vol)
        drift = 0.0006 * math.log(spec.base / price)
        open_price = price
        price = max(price * math.exp(regime + shock + drift), spec.base * 0.2)
        high = max(open_price, price) * (1 + abs(rng.gauss(0, spec.vol * 0.35)))
        low = min(open_price, price) * (1 - abs(rng.gauss(0, spec.vol * 0.35)))
        bars.append(
            {
                "time": ts,
                "open": round(open_price, spec.digits),
                "high": round(high, spec.digits),
                "low": round(low, spec.digits),
                "close": round(price, spec.digits),
                "volume": int(abs(rng.gauss(1000, 350)) + 50),
            }
        )
    return bars


# --------------------------------------------------------------------------
# Factory
# --------------------------------------------------------------------------

def build_provider(store: Store) -> tuple[Provider, str]:
    """Return (provider, requested_mode).

    ``auto`` and ``live`` try a real MetaTrader 5 terminal first. If the package
    is missing, no terminal is installed, no account is logged in or the user
    has not connected a terminal yet, the bridge falls back to the simulation
    broker and reports exactly why.
    """
    from .mt5_provider import MT5Provider
    from .mt5ctl import MT5Session, installed_terminals_hint

    requested = SETTINGS.mode if SETTINGS.mode in {"auto", "simulation", "live"} else "auto"

    if requested == "simulation":
        provider = SimProvider(store)
        provider.reason = "simulation mode selected in .env (BRIDGE_MODE=simulation)"
        return provider, requested

    connected_to = store.get_kv("mt5_connected_path")
    terminal = installed_terminals_hint()

    if mt5 is None:
        provider = SimProvider(store)
        provider.reason = "MetaTrader5 Python package is not installed"
        return provider, requested

    if not (connected_to or terminal):
        provider = SimProvider(store)
        provider.reason = "no MetaTrader 5 terminal found on this machine"
        return provider, requested

    session = MT5Session()
    info = session.connect(
        SETTINGS.mt5_terminal if SETTINGS.mt5_terminal else (connected_to or terminal),
        login=SETTINGS.mt5_login,
        password=SETTINGS.mt5_password,
        server=SETTINGS.mt5_server,
    )
    if not info.get("ok"):
        provider = SimProvider(store)
        provider.reason = info.get("hint") or info.get("error") or "MT5 unavailable"
        provider.mt5_error = info.get("error")
        return provider, requested

    store.set_kv("mt5_connected_path", session.path or "")
    provider = MT5Provider(
        store,
        session,
        allow_live=SETTINGS.allow_live_trades or store.get_kv("allow_live") == "1",
    )
    return provider, requested

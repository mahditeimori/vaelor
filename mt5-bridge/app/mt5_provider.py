"""MetaTrader 5 broker provider.

Wraps :class:`app.mt5ctl.MT5Session` in the normalized broker interface used by
the engine, the backtester and the browser desk. Every broker-specific quirk
(filling modes, stop validation, symbol suffixes, retcodes) is handled here so
the rest of the bridge stays broker agnostic.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import SETTINGS
from .mt5ctl import MT5Session, explain, package_info
from .providers import Provider, spec_for, strategy_magic

try:  # pragma: no cover - Windows only
    import MetaTrader5 as mt5  # type: ignore
except Exception:  # pragma: no cover
    mt5 = None

MT5_TIMEFRAMES = {}
if mt5 is not None:  # pragma: no cover - depends on the package
    MT5_TIMEFRAMES = {
        "M1": mt5.TIMEFRAME_M1,
        "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15,
        "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
        "W1": mt5.TIMEFRAME_W1,
    }

# Common index names -> the cash symbols brokers actually use. FOREX.com, for
# example, lists the Dow as DJIUSD and the Nasdaq 100 as NDXUSD.
SYMBOL_ALIASES: dict[str, tuple[str, ...]] = {
    "US30": ("DJIUSD", "US30", "DJ30", "WS30"),
    "DJIUSD": ("DJIUSD", "US30"),
    "NAS100": ("NDXUSD", "NAS100", "USTEC", "US100"),
    "NDXUSD": ("NDXUSD", "NAS100"),
    "SPX500": ("SPXUSD", "SPX500", "US500"),
    "SPXUSD": ("SPXUSD", "SPX500"),
}


class BrokerError(RuntimeError):
    """A broker call was rejected; the message is safe to show to the user."""

    def __init__(self, message: str, *, retcode: int | None = None, hint: str | None = None):
        super().__init__(message)
        self.retcode = retcode
        self.hint = hint or explain(retcode)

    def as_dict(self) -> dict[str, Any]:
        return {"error": str(self), "retcode": self.retcode, "hint": self.hint}


class MT5Provider(Provider):
    name = "mt5"
    mode = "live"

    def __init__(self, store, session: MT5Session, *, allow_live: bool) -> None:
        self.store = store
        self.session = session
        self.allow_live = allow_live
        self._symbol_cache: dict[str, str] = {}
        self._day_open: dict[str, tuple[float, float]] = {}
        self._last_fill_error: str | None = None

    # ------------------------------------------------------------- meta/status
    @property
    def connected(self) -> bool:  # type: ignore[override]
        return self.session.connected

    @property
    def reason(self) -> str:  # type: ignore[override]
        return self.session.last_error or ""

    def status(self) -> dict:
        healthy = self.session.check()
        account = self.session.status().get("account")
        terminal = self.session.status().get("terminal")
        return {
            "provider": self.name,
            "mode": self.mode,
            "connected": bool(healthy),
            "reason": self.session.last_error or "",
            "tradeAllowed": bool(terminal and terminal.get("tradeAllowed")),
            "autotrading": bool(terminal and terminal.get("tradeAllowed")),
            "accountChanged": self.session.account_changed,
            "liveAllowed": self.allow_live,
            "account": account,
            "terminal": terminal,
            "terminalPath": self.session.path,
            "package": package_info(),
            "hint": None
            if terminal and terminal.get("tradeAllowed")
            else (
                "AutoTrading is off in the terminal. Press the AutoTrading button "
                "and enable Tools > Options > Expert Advisors > Allow algorithmic trading."
            ),
        }

    def ensure(self) -> None:
        if not self.session.check():
            raise BrokerError(
                self.session.last_error or "MetaTrader 5 is not connected",
                hint="Reconnect the terminal from the Execution page.",
            )

    # ------------------------------------------------------------------ symbols
    def resolve_symbol(self, symbol: str) -> str:
        self.ensure()
        raw = symbol.upper()
        if raw in self._symbol_cache:
            return self._symbol_cache[raw]
        info = mt5.symbol_info(raw)
        candidates = SYMBOL_ALIASES.get(raw, (raw,))
        for candidate in candidates:
            info = mt5.symbol_info(candidate)
            if info is not None:
                break
        if info is None:
            for candidate in candidates:
                found = mt5.symbols_get(f"*{candidate}*") or []
                exact = [c for c in found if c.name.upper() == candidate]
                info = exact[0] if exact else (found[0] if found else None)
                if info is not None:
                    break
        if info is None:
            raise BrokerError(
                f"symbol {symbol} does not exist on this broker",
                hint="Pick a symbol from the ticker list — brokers often add suffixes such as .a or _m.",
            )
        if not info.visible:
            mt5.symbol_select(info.name, True)
        self._symbol_cache[raw] = info.name
        return info.name

    def symbols(self) -> list[dict]:
        self.ensure()
        out = []
        for info in mt5.symbols_get() or []:
            tradable = info.trade_mode == mt5.SYMBOL_TRADE_MODE_FULL
            if not tradable and not info.visible:
                continue
            point = info.point or 0.0
            digits = info.digits
            pip = point * (10 if digits in (3, 5) else 1)
            spread = (info.ask - info.bid) / pip if pip and info.ask and info.bid else 0.0
            out.append(
                {
                    "symbol": info.name,
                    "description": info.description,
                    "digits": digits,
                    "pip": pip,
                    "contract": info.trade_contract_size,
                    "minLot": info.volume_min,
                    "maxLot": info.volume_max,
                    "lotStep": info.volume_step,
                    "spreadPips": round(spread, 2),
                    "price": round((info.bid + info.ask) / 2, digits) if info.bid else 0.0,
                    "tradable": bool(tradable),
                    "marketOpen": bool(getattr(info, "trade_mode", 0)) and bool(info.bid),
                    "strategySymbol": next(
                        (k for k in ("XAUUSD", "XAGUSD") if info.name.upper().startswith(k)),
                        None,
                    ),
                }
            )
        out.sort(key=lambda s: (not s["tradable"], s["symbol"]))
        return out[:600]

    def quote(self, symbol: str) -> dict:
        name = self.resolve_symbol(symbol)
        tick = mt5.symbol_info_tick(name)
        info = mt5.symbol_info(name)
        if tick is None or info is None or not tick.bid:
            raise BrokerError(f"no live quote for {symbol} — the market may be closed")
        mid = (tick.bid + tick.ask) / 2
        change = 0.0
        cached = self._day_open.get(name)
        now = time.time()
        if cached and now - cached[0] < 120:
            day_open = cached[1]
        else:
            bars = mt5.copy_rates_from_pos(name, mt5.TIMEFRAME_D1, 0, 1)
            day_open = float(bars[0]["open"]) if bars is not None and len(bars) else mid
            self._day_open[name] = (now, day_open)
        if day_open:
            change = (mid / day_open - 1) * 100
        return {
            "symbol": name,
            "bid": float(tick.bid),
            "ask": float(tick.ask),
            "mid": round(mid, info.digits),
            "time": int(tick.time),
            "changePct": round(change, 3),
            "spreadPips": round((tick.ask - tick.bid) / (info.point or 1) / (10 if info.digits in (3, 5) else 1), 2),
        }

    def min_stop_distance(self, symbol: str) -> float:
        """Stop distance the broker will accept, including the current spread.

        A break-even stop sits at the entry price, which was the ask for a long.
        For the stop to be valid it must clear both the spread and the broker's
        `trade_stops_level`, so this returns the sum of the two.
        """
        self.ensure()
        name = self.resolve_symbol(symbol)
        info = mt5.symbol_info(name)
        if info is None:
            raise BrokerError(f"unknown symbol: {symbol}")
        point = info.point or 0.0
        spread = max(0.0, float(info.ask or 0.0) - float(info.bid or 0.0))
        return max(float(info.trade_stops_level or 0) * point, point * 5) + spread

    # ---------------------------------------------------------------- account
    def account(self) -> dict:
        self.ensure()
        info = mt5.account_info()
        if info is None:
            raise BrokerError("MT5 account unavailable", hint="Reconnect the terminal.")
        return {
            "login": info.login,
            "server": info.server,
            "name": info.name,
            "company": getattr(info, "company", ""),
            "currency": info.currency,
            "balance": round(info.balance, 2),
            "equity": round(info.equity, 2),
            "margin": round(info.margin, 2),
            "freeMargin": round(info.margin_free, 2),
            "marginLevel": round(info.margin_level, 2),
            "leverage": info.leverage,
            "profit": round(info.profit, 2),
            "tradeAllowed": bool(info.trade_allowed),
            "mode": "live",
        }

    # -------------------------------------------------------------- positions
    def positions(self) -> list[dict]:
        if not self.session.check():
            return []
        out = []
        for p in mt5.positions_get() or []:
            out.append(
                {
                    "ticket": p.ticket,
                    "symbol": p.symbol,
                    "side": "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell",
                    "volume": p.volume,
                    "openPrice": p.price_open,
                    "currentPrice": p.price_current,
                    "sl": p.sl or None,
                    "tp": p.tp or None,
                    "profit": round(p.profit, 2),
                    "swap": round(p.swap, 2),
                    "commission": 0.0,
                    "magic": p.magic,
                    "comment": p.comment,
                    "strategyId": self.store.get_kv(f"magic:{p.magic}"),
                    "opened": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(
                        timespec="seconds"
                    ),
                }
            )
        return out

    def orders(self) -> list[dict]:
        if not self.session.check():
            return []
        out = []
        for o in mt5.orders_get() or []:
            out.append(
                {
                    "ticket": o.ticket,
                    "symbol": o.symbol,
                    "side": "buy"
                    if o.type in (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_BUY_STOP)
                    else "sell",
                    "volume": o.volume_current,
                    "type": "limit"
                    if o.type in (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_SELL_LIMIT)
                    else "stop",
                    "price": o.price_open,
                    "sl": o.sl or None,
                    "tp": o.tp or None,
                    "comment": o.comment,
                    "strategyId": self.store.get_kv(f"magic:{o.magic}"),
                    "created": datetime.fromtimestamp(o.time_setup, tz=timezone.utc).isoformat(
                        timespec="seconds"
                    ),
                }
            )
        return out

    def history(self, days: int = 30) -> list[dict]:
        if not self.session.check():
            return []
        # MT5 reads these datetimes in the terminal's server time zone, which
        # can be ahead of UTC. Widen the window by a day on each side so a deal
        # closed minutes ago is never excluded because "now" is still in the
        # terminal's past.
        now = datetime.now(tz=timezone.utc)
        margin = timedelta(days=1)
        start = now - timedelta(days=days) - margin
        deals = mt5.history_deals_get(start, now + margin)
        entries: dict[int, Any] = {}
        out = []
        for deal in deals or []:
            if deal.entry == mt5.DEAL_ENTRY_IN:
                entries[deal.position_id] = deal
            elif deal.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY):
                entry = entries.get(deal.position_id)
                # A closing sell closes a long position.
                side = "buy" if deal.type == mt5.DEAL_TYPE_SELL else "sell"
                out.append(
                    {
                        "ticket": deal.position_id,
                        "symbol": deal.symbol,
                        "side": side,
                        "volume": deal.volume,
                        "openPrice": entry.price if entry else deal.price,
                        "closePrice": deal.price,
                        "pnl": round(deal.profit + deal.swap + deal.commission, 2),
                        "commission": round(deal.commission, 2),
                        "swap": round(deal.swap, 2),
                        "magic": deal.magic,
                        "comment": deal.comment,
                        "strategyId": self.store.get_kv(f"magic:{deal.magic}"),
                        "opened": datetime.fromtimestamp(entry.time, tz=timezone.utc).isoformat(
                            timespec="seconds"
                        )
                        if entry
                        else None,
                        "closed": datetime.fromtimestamp(deal.time, tz=timezone.utc).isoformat(
                            timespec="seconds"
                        ),
                    }
                )
        out.sort(key=lambda d: d["closed"], reverse=True)
        return out

    # ----------------------------------------------------------------- orders
    def _fillings(self, symbol: str) -> list[int]:
        info = mt5.symbol_info(symbol)
        mask = int(getattr(info, "filling_mode", 0)) if info else 0
        modes = []
        if mask & 1:
            modes.append(mt5.ORDER_FILLING_FOK)
        if mask & 2:
            modes.append(mt5.ORDER_FILLING_IOC)
        modes.append(mt5.ORDER_FILLING_RETURN)
        # De-duplicate while keeping order.
        seen = set()
        return [m for m in modes if not (m in seen or seen.add(m))]

    def _stops_valid(self, symbol: str, side: str, price: float, sl: float | None, tp: float | None) -> None:
        info = mt5.symbol_info(symbol)
        if info is None:
            return
        point = info.point or 0.0
        min_dist = max(info.trade_stops_level * point, point * 5)
        if sl:
            if side == "buy" and sl > price - min_dist:
                raise BrokerError(
                    f"stop loss is inside the broker's minimum distance ({info.trade_stops_level} points)"
                )
            if side == "sell" and sl < price + min_dist:
                raise BrokerError(
                    f"stop loss is inside the broker's minimum distance ({info.trade_stops_level} points)"
                )
        if tp:
            if side == "buy" and tp < price + min_dist:
                raise BrokerError(
                    f"take profit is inside the broker's minimum distance ({info.trade_stops_level} points)"
                )
            if side == "sell" and tp > price - min_dist:
                raise BrokerError(
                    f"take profit is inside the broker's minimum distance ({info.trade_stops_level} points)"
                )

    def _send(self, request: dict, *, attempts: int = 3) -> dict:
        self.ensure()
        if not self.allow_live:
            raise BrokerError(
                "live trading is locked in the bridge",
                hint="Press 'Enable live trading' in the Safety section of the Execution page.",
            )
        if self.session.account_changed:
            raise BrokerError(
                "the MT5 account changed since the bridge connected",
                hint="Reconnect from the Execution page so the account is confirmed.",
            )
        last: BrokerError | None = None
        for _ in range(attempts):
            result = mt5.order_send(request)
            if result is None:
                code, message = mt5.last_error()
                raise BrokerError(f"order_send returned no result ({code}: {message})")
            if result.retcode == mt5.TRADE_RETCODE_DONE:
                return {
                    "ticket": result.order,
                    "deal": result.deal,
                    "volume": result.volume,
                    "price": result.price,
                    "status": "filled" if result.deal else "pending",
                }
            if result.retcode == mt5.TRADE_RETCODE_REQUOTE:
                last = BrokerError("requote", retcode=result.retcode)
                time.sleep(0.3)
                tick = mt5.symbol_info_tick(request["symbol"])
                if tick is not None:
                    request["price"] = (
                        tick.ask if request["type"] == mt5.ORDER_TYPE_BUY else tick.bid
                    )
                continue
            if result.retcode == 10030 and "type_filling" in request:
                # Filling mode unsupported: try the next one the symbol allows.
                modes = [m for m in self._fillings(request["symbol"]) if m != request["type_filling"]]
                if modes:
                    request["type_filling"] = modes[0]
                    continue
            raise BrokerError(
                f"order rejected ({result.retcode}): {result.comment or 'no comment'}",
                retcode=result.retcode,
            )
        raise last or BrokerError("order was not accepted after retries")

    def place_market(self, symbol, side, volume, *, sl, tp, comment, magic, strategy_id) -> dict:
        name = self.resolve_symbol(symbol)
        tick = mt5.symbol_info_tick(name)
        if tick is None or not tick.ask:
            raise BrokerError(f"no price for {name}; the market may be closed")
        price = tick.ask if side == "buy" else tick.bid
        self._stops_valid(name, side, price, sl, tp)
        info = mt5.symbol_info(name)
        volume = round(round(volume / info.volume_step) * info.volume_step, 8)
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": name,
            "volume": float(volume),
            "type": mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
            "price": float(price),
            "sl": float(sl or 0.0),
            "tp": float(tp or 0.0),
            "deviation": 20,
            "magic": magic,
            "comment": (comment or "")[:31],
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self._fillings(name)[0],
        }
        result = self._send(request)
        if strategy_id:
            self.store.set_kv(f"magic:{magic}", strategy_id)
        return {
            **result,
            "symbol": name,
            "side": side,
            "sl": sl,
            "tp": tp,
            "comment": comment,
            "strategyId": strategy_id,
        }

    def place_limit(self, symbol, side, volume, price, *, sl, tp, comment, magic, strategy_id) -> dict:
        name = self.resolve_symbol(symbol)
        self._stops_valid(name, side, price, sl, tp)
        info = mt5.symbol_info(name)
        tick = mt5.symbol_info_tick(name)
        if tick is not None:
            if side == "buy" and price >= tick.ask:
                raise BrokerError("a buy limit must be placed below the current ask")
            if side == "sell" and price <= tick.bid:
                raise BrokerError("a sell limit must be placed above the current bid")
        volume = round(round(volume / info.volume_step) * info.volume_step, 8)
        request = {
            "action": mt5.TRADE_ACTION_PENDING,
            "symbol": name,
            "volume": float(volume),
            "type": mt5.ORDER_TYPE_BUY_LIMIT if side == "buy" else mt5.ORDER_TYPE_SELL_LIMIT,
            "price": float(price),
            "sl": float(sl or 0.0),
            "tp": float(tp or 0.0),
            "magic": magic,
            "comment": (comment or "")[:31],
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self._fillings(name)[0],
        }
        result = self._send(request)
        if strategy_id:
            self.store.set_kv(f"magic:{magic}", strategy_id)
        return {
            **result,
            "symbol": name,
            "side": side,
            "sl": sl,
            "tp": tp,
            "comment": comment,
            "strategyId": strategy_id,
        }

    def modify(self, ticket: int, *, sl: float | None, tp: float | None) -> dict:
        self.ensure()
        found = mt5.positions_get(ticket=ticket)
        if not found:
            raise BrokerError("position not found — it may already be closed")
        pos = found[0]
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": pos.symbol,
            "position": ticket,
            "sl": float(sl if sl is not None else pos.sl),
            "tp": float(tp if tp is not None else pos.tp),
            "magic": pos.magic,
        }
        result = self._send(request)
        return {"ticket": ticket, "sl": request["sl"], "tp": request["tp"], **result, "status": "modified"}

    def close_position(self, ticket: int, volume: float | None = None, *, price=None, reason="manual") -> dict:
        self.ensure()
        found = mt5.positions_get(ticket=ticket)
        if not found:
            raise BrokerError("position not found — it may already be closed")
        pos = found[0]
        tick = mt5.symbol_info_tick(pos.symbol)
        if tick is None:
            raise BrokerError("no price available to close the position")
        closing_long = pos.type == mt5.POSITION_TYPE_BUY
        close_volume = min(float(volume or pos.volume), pos.volume)
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": pos.symbol,
            "position": ticket,
            "volume": close_volume,
            "type": mt5.ORDER_TYPE_SELL if closing_long else mt5.ORDER_TYPE_BUY,
            "price": tick.bid if closing_long else tick.ask,
            "deviation": 20,
            "magic": pos.magic,
            "comment": f"close:{reason}"[:31],
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": self._fillings(pos.symbol)[0],
        }
        result = self._send(request)
        remaining = round(pos.volume - close_volume, 8)
        return {
            **result,
            "ticket": ticket,
            "symbol": pos.symbol,
            "closedVolume": close_volume,
            "remainingVolume": 0.0 if remaining <= 0 else remaining,
            "closePrice": request["price"],
            "reason": reason,
            "status": "closed",
        }

    # ------------------------------------------------------------- historical
    def rates(self, symbol: str, timeframe: str, start: int, end: int) -> list[dict]:
        name = self.resolve_symbol(symbol)
        tf = MT5_TIMEFRAMES.get(timeframe.upper(), mt5.TIMEFRAME_H1)
        rates = mt5.copy_rates_range(
            name,
            tf,
            datetime.fromtimestamp(start, tz=timezone.utc),
            datetime.fromtimestamp(end, tz=timezone.utc),
        )
        if rates is None or len(rates) == 0:
            # Fall back to the most recent available history for that timeframe.
            rates = mt5.copy_rates_from_pos(name, tf, 0, 5000)
        if rates is None:
            return []
        lo, hi = int(start), int(end)
        bars = [
            {
                "time": int(row["time"]),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["tick_volume"]),
            }
            for row in rates
        ]
        # The fallback above returns whatever the terminal has, which may be a
        # different span than the one the user asked for. Never let bars from
        # outside the requested window into the report.
        return [bar for bar in bars if lo <= bar["time"] <= hi]

    def poll(self) -> dict:
        # The terminal owns stop/target execution; nothing to simulate.
        return {"fills": [], "triggers": []}

    def trailing_candidates(self) -> list[dict]:
        """Positions whose stops the engine should trail (used by strategy autopilot)."""
        return [p for p in self.positions() if p.get("strategyId")]

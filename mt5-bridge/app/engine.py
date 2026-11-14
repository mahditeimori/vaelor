"""Trading engine: risk gates, order routing, signals, performance and backtests."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from .backtest import SymbolCtx, run_backtest
from .config import SETTINGS, VERSION
from .models import (
    BacktestRequest,
    KillRequest,
    ModeRequest,
    ModifyRequest,
    OrderRequest,
    RiskConfig,
    SignalIn,
    StrategyManifest,
    TF_MINUTES,
)
from .performance import summarise, trade_stats, wilson_lower
from .providers import Provider, SimProvider, build_provider, spec_for, strategy_magic
from .python_backtest import run_python_backtest
from .signal_feed import SignalFeed
from .store import Store
from .strategies import StrategyError, validate_strategy


class RiskError(ValueError):
    """A risk gate rejected the request."""


# Bars per backtest window. M1 needs the most because a trading day is 1440
# of them; a year of M1 is deliberately not attempted (it would be 375k bars).
BACKTEST_BAR_CAPS: dict[str, int] = {
    "M1": 60_000,
    "M5": 40_000,
    "M15": 30_000,
    "M30": 30_000,
}


class TradingEngine:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.provider, self.requested_mode = build_provider(store)
        self.started_at = time.time()
        self.last_tick: str | None = None
        self.last_error: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._tick_lock = threading.Lock()
        self._last_signal_scan = 0.0
        self.prop_safe = bool(self.store.get_json("prop_safe") or False)
        self._load_risk()

    # ------------------------------------------------------ MetaTrader link
    def mt5_diagnostics(self) -> dict:
        """Everything the browser needs to help a user attach their terminal."""
        from . import mt5ctl
        from .mt5_provider import MT5Provider

        active = None
        if isinstance(self.provider, MT5Provider):
            active = self.provider.status()
        return {
            "package": mt5ctl.package_info(),
            "terminals": mt5ctl.discover_terminals(),
            "suggestedPath": mt5ctl.installed_terminals_hint(),
            "active": active,
            "mode": self.provider.mode,
            "connected": self.provider.connected,
            "allowLiveTrades": self.live_allowed(),
        }

    def live_allowed(self) -> bool:
        """Live routing is unlocked by the env interlock OR by the website button.

        The website unlock is stored in the bridge database, so it survives
        restarts without the user ever touching .env.
        """
        return SETTINGS.allow_live_trades or self.store.get_kv("allow_live") == "1"

    def set_live_allowed(self, enabled: bool) -> dict:
        """Website control for the live-trading interlock (audited)."""
        self.store.set_kv("allow_live", "1" if enabled else "0")
        if hasattr(self.provider, "allow_live"):
            self.provider.allow_live = enabled
        self.store.audit("safety.live_interlock", {"allowed": enabled, "source": "website"})
        return {"ok": True, "allowLiveTrades": self.live_allowed()}

    def connect_mt5(
        self,
        *,
        path: str | None = None,
        login: int | None = None,
        password: str | None = None,
        server: str | None = None,
        portable: bool = False,
    ) -> dict:
        """Attach the engine to a user-selected MetaTrader 5 terminal."""
        from .mt5_provider import MT5Provider
        from .mt5ctl import MT5Session

        session = MT5Session()
        info = session.connect(
            path, login=login, password=password, server=server, portable=portable
        )
        if not info.get("ok"):
            reason = info.get("hint") or info.get("error") or "MT5 connection failed"
            self.store.audit(
                "mt5.connect_failed",
                {"path": path, "login": login, "server": server, "error": info.get("error"),
                 "retcode": info.get("retcode")},
                ok=False,
            )
            raise RiskError(reason)

        previous_allow = self.live_allowed()
        self.provider = MT5Provider(self.store, session, allow_live=previous_allow)
        account = info.get("account") or {}
        self.store.set_kv("mt5_connected_path", session.path or path or "")
        self.store.set_json(
            "mt5_account",
            {
                "login": account.get("login"),
                "server": account.get("server"),
                "name": account.get("name"),
                "company": account.get("company"),
                "currency": account.get("currency"),
                "demo": account.get("demo"),
                "connectedAt": _now(),
            },
        )
        self.store.audit(
            "mt5.connected",
            {
                "login": account.get("login"),
                "server": account.get("server"),
                "demo": account.get("demo"),
                "path": session.path,
                "autotrading": info.get("autotrading"),
            },
        )
        self.last_error = None
        return {"ok": True, "provider": self.provider.status()}

    def disconnect_mt5(self) -> dict:
        from .mt5_provider import MT5Provider

        if isinstance(self.provider, MT5Provider):
            self.provider.session.disconnect()
        self.provider = SimProvider(self.store)
        self.provider.reason = "MetaTrader 5 disconnected — simulation broker active"
        self.store.set_kv("mt5_connected_path", "")
        self.store.audit("mt5.disconnected", {"mode": "simulation"})
        return {"ok": True, "provider": self.provider.status()}

    def reconnect_mt5(self) -> dict:
        """Re-attach to the terminal the user last chose (no credentials needed)."""
        from .mt5_provider import MT5Provider

        if isinstance(self.provider, MT5Provider):
            self.provider.session.disconnect()
        path = self.store.get_kv("mt5_connected_path") or None
        if not path:
            from .mt5ctl import installed_terminals_hint

            path = installed_terminals_hint()
        if not path:
            raise RiskError("no MetaTrader 5 terminal found on this machine")
        return self.connect_mt5(path=path)

    # ------------------------------------------------------------- lifecycle
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="engine-tick", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as exc:  # keep the loop alive, surface the error
                self.last_error = str(exc)
            self._stop.wait(1.0)

    def tick(self) -> None:
        if not self._tick_lock.acquire(blocking=False):
            return
        try:
            self.provider.update_quotes()
            events = self.provider.poll()
            for fill in events.get("fills", []):
                self.store.audit("order.filled", fill)
            for trigger in events.get("triggers", []):
                try:
                    result = self.provider.close_position(
                        trigger["ticket"], price=trigger["price"], reason=trigger["reason"]
                    )
                    self.store.audit(f"position.{trigger['reason']}", result)
                except Exception as exc:
                    self.store.audit("position.auto_close_failed", str(exc), ok=False)
            self._auto_execute_signals()
            self._scan_live_signals()
            self.last_tick = _now()
        finally:
            self._tick_lock.release()

    # ------------------------------------------------------------------ risk
    def _load_risk(self) -> None:
        raw = self.store.get_json("risk")
        self.risk = RiskConfig(**raw) if raw else RiskConfig()
        if not self.risk.symbolWhitelist:
            self.risk.symbolWhitelist = []

    def get_risk(self) -> dict:
        return self.risk.model_dump()

    def set_risk(self, config: RiskConfig) -> dict:
        self.risk = config
        self.store.set_json("risk", config.model_dump())
        self.store.audit("risk.updated", config.model_dump())
        return self.get_risk()

    # ---------------------------------------------------------------- status
    def status(self) -> dict:
        provider_status = self.provider.status()
        account = None
        account_error = None
        try:
            account = self.provider.account()
        except Exception as exc:
            account_error = str(exc)
        try:
            positions = self.provider.positions()
            orders = self.provider.orders()
        except Exception:
            positions, orders = [], []
        cloud = self.store.get_json("cloud_status") or {}
        return {
            "ok": True,
            "service": "vaelor-mt5-bridge",
            "version": VERSION,
            "startedAt": _iso(self.started_at),
            "lastTick": self.last_tick,
            "lastError": self.last_error,
            "mode": self.provider.mode,
            "tradingEnabled": self.provider.mode == "live" and self.live_allowed(),
            "provider": provider_status,
            "account": account,
            "accountError": account_error,
            "risk": self.get_risk(),
            "safety": {
                "allowLiveTrades": self.live_allowed(),
                "liveReady": self.provider.mode == "live" and self.live_allowed(),
                "killSwitch": self.risk.killSwitch,
                "propSafe": self.prop_safe,
                "maxLotPerTrade": self.risk.maxLotPerTrade,
                "maxOpenPositions": self.risk.maxOpenPositions,
                "maxDailyLossPct": self.risk.maxDailyLossPct,
                "cloudSync": SETTINGS.cloud_sync,
            },
            "cloud": cloud,
            "counts": {
                "positions": len(positions),
                "orders": len(orders),
                "strategies": len(self.store.list_strategies()),
                "pendingSignals": len(self.store.list_signals("pending", 500)),
            },
            "server": {
                "host": SETTINGS.host,
                "port": SETTINGS.port,
                "cloudUrl": SETTINGS.cloud_url,
            },
        }

    def symbols(self) -> list[dict]:
        try:
            return self.provider.symbols()
        except Exception:
            return SimProvider(self.store).symbols()

    def quote(self, symbol: str) -> dict:
        return self.provider.quote(symbol)

    def snapshot(self) -> dict:
        return {
            "status": self.status(),
            "positions": self.provider.positions(),
            "orders": self.provider.orders(),
            "quotes": {},
        }

    # --------------------------------------------------------------- orders
    def _risk_gate(self, *, symbol: str, volume: float, market: bool) -> None:
        if self.provider.mode == "live":
            from .mt5_provider import BrokerError

            try:
                self.provider.ensure()
            except BrokerError as exc:
                raise RiskError(str(exc) if not exc.hint else f"{exc} — {exc.hint}") from exc
        if self.risk.killSwitch:
            raise RiskError("kill switch is active — trading is halted")
        if not self.risk.allowMarketOrders and market:
            raise RiskError("market orders are disabled in the risk settings")
        if volume > self.risk.maxLotPerTrade:
            raise RiskError(
                f"volume {volume} exceeds the per-trade cap ({self.risk.maxLotPerTrade} lots)"
            )
        if self.risk.symbolWhitelist and symbol.upper() not in self.risk.symbolWhitelist:
            raise RiskError(f"{symbol} is not in the symbol whitelist")
        positions = self.provider.positions()
        if len(positions) >= self.risk.maxOpenPositions:
            raise RiskError(
                f"max open positions reached ({self.risk.maxOpenPositions})"
            )
        # Daily loss guard, measured on closed deals since midnight UTC.
        try:
            deals = self.provider.history(1)
            today = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
            pnl_today = sum(
                float(d.get("pnl", 0)) for d in deals if str(d.get("closed", "")).startswith(today)
            )
            account = self.provider.account()
            if account and account["balance"] > 0:
                loss_pct = -pnl_today / account["balance"] * 100
                if loss_pct >= self.risk.maxDailyLossPct:
                    raise RiskError(
                        f"daily loss limit reached ({loss_pct:.2f}% >= {self.risk.maxDailyLossPct}%)"
                    )
        except RiskError:
            raise
        except Exception:
            pass

    def _magic_for(self, strategy_id: str | None) -> int:
        if not strategy_id:
            return 0
        magic = strategy_magic(strategy_id)
        self.store.set_kv(f"magic:{magic}", strategy_id)
        return magic

    def place_order(self, request: OrderRequest) -> dict:
        if self.prop_safe:
            raise RiskError(
                "Prop-firm signal-only mode is on. The bridge will not send opening orders: "
                "use the signal ticket and place it manually in MetaTrader 5, or turn the lock "
                "off in Safety if this is not a prop account."
            )
        if request.idempotencyKey:
            cached = self.store.get_idempotent(request.idempotencyKey)
            if cached:
                return cached

        symbol = self.provider.resolve_symbol(request.symbol)
        spec = spec_for(symbol)
        volume = max(spec.min_lot, round(round(request.volume / spec.lot_step) * spec.lot_step, 2))
        market = request.type == "market"
        try:
            self._risk_gate(symbol=symbol, volume=volume, market=market)
        except RiskError as exc:
            self.store.audit("order.rejected", {"request": request.model_dump(), "error": str(exc)}, ok=False)
            raise

        if self.provider.mode == "live" and not request.confirm:
            raise RiskError("live orders require explicit confirmation (confirm=true)")

        magic = self._magic_for(request.strategyId)
        comment = request.comment or (request.strategyId or "manual")
        try:
            if market:
                result = self.provider.place_market(
                    symbol,
                    request.side,
                    volume,
                    sl=request.sl,
                    tp=request.tp,
                    comment=comment,
                    magic=magic,
                    strategy_id=request.strategyId,
                )
            else:
                result = self.provider.place_limit(
                    symbol,
                    request.side,
                    volume,
                    float(request.price or 0),
                    sl=request.sl,
                    tp=request.tp,
                    comment=comment,
                    magic=magic,
                    strategy_id=request.strategyId,
                )
        except Exception as exc:
            self.store.audit("order.failed", {"request": request.model_dump(), "error": str(exc)}, ok=False)
            raise

        response = {"ok": True, "order": result, "mode": self.provider.mode}
        if request.idempotencyKey:
            self.store.set_idempotent(request.idempotencyKey, response)
        self.store.audit("order.placed", {"request": request.model_dump(), "result": result})
        return response

    def modify_position(self, ticket: int, request: ModifyRequest) -> dict:
        result = self.provider.modify(ticket, sl=request.sl, tp=request.tp)
        self.store.audit("position.modified", result)
        return {"ok": True, "position": result}

    def close_position(self, ticket: int, volume: float | None = None, reason: str = "manual") -> dict:
        result = self.provider.close_position(ticket, volume=volume, reason=reason)
        self.store.audit("position.closed", result)
        return {"ok": True, "position": result}

    def breakeven(self, ticket: int) -> dict:
        positions = {p["ticket"]: p for p in self.provider.positions()}
        pos = positions.get(ticket)
        if not pos:
            raise ValueError("position not found")
        spec = spec_for(pos["symbol"])
        pip = spec.pip or 0.0
        # A break-even stop sits at the entry price. On a real venue the stop
        # must clear the spread plus the broker's minimum stop distance, so it
        # is only valid once the trade has moved that far into profit.
        min_dist = self.provider.min_stop_distance(pos["symbol"])
        quote = self.provider.quote(pos["symbol"])
        moved = (
            quote["bid"] - pos["openPrice"]
            if pos["side"] == "buy"
            else pos["openPrice"] - quote["ask"]
        )
        if min_dist > 0 and moved < min_dist:
            raise RiskError(
                "break-even is not possible yet: the trade must clear the spread first "
                f"(needs about {min_dist / pip:.1f} pips, currently {max(moved, 0.0) / pip:.1f}). "
                "Wait for the price to move further into profit, then try again."
            )
        return self.modify_position(ticket, ModifyRequest(sl=pos["openPrice"], tp=pos["tp"]))

    def trail(self, ticket: int, distance_pips: float) -> dict:
        positions = {p["ticket"]: p for p in self.provider.positions()}
        pos = positions.get(ticket)
        if not pos:
            raise ValueError("position not found")
        spec = spec_for(pos["symbol"])
        distance = distance_pips * spec.pip
        # Never place a stop inside the broker's minimum distance.
        distance = max(distance, self.provider.min_stop_distance(pos["symbol"]))
        quote = self.provider.quote(pos["symbol"])
        if pos["side"] == "buy":
            new_sl = quote["bid"] - distance
            if new_sl <= (pos["sl"] or 0):
                raise RiskError(
                    "trailing stop would move the stop backwards: the price has not "
                    "advanced enough for this distance"
                )
        else:
            new_sl = quote["ask"] + distance
            if pos["sl"] and new_sl >= pos["sl"]:
                raise RiskError(
                    "trailing stop would move the stop backwards: the price has not "
                    "advanced enough for this distance"
                )
        return self.modify_position(ticket, ModifyRequest(sl=round(new_sl, spec.digits), tp=pos["tp"]))

    def close_all(self, strategy_id: str | None = None) -> dict:
        positions = self.provider.positions()
        closed = []
        for pos in positions:
            if strategy_id and pos.get("strategyId") != strategy_id:
                continue
            try:
                closed.append(self.provider.close_position(pos["ticket"], reason="close_all"))
            except Exception as exc:
                closed.append({"ticket": pos["ticket"], "error": str(exc)})
        self.store.audit("positions.close_all", {"count": len(closed), "strategyId": strategy_id})
        return {"ok": True, "closed": closed}

    def kill(self, request: KillRequest) -> dict:
        if request.active and request.confirm != "KILL":
            raise RiskError('kill switch requires confirm="KILL"')
        self.risk.killSwitch = request.active
        self.store.set_json("risk", self.risk.model_dump())
        closed = []
        if request.active and request.closePositions:
            closed = self.close_all()["closed"]
        self.store.audit("safety.kill_switch", {"active": request.active, "closed": len(closed)})
        return {"ok": True, "killSwitch": self.risk.killSwitch, "closed": closed}

    def set_mode(self, request: ModeRequest) -> dict:
        """Switch between the simulation broker and a connected MT5 terminal.

        Going live always needs the env interlock *and* a typed confirmation.
        Going back to simulation is always allowed and closes nothing.
        """
        if request.mode == "simulation":
            if self.provider.mode == "simulation":
                return {"ok": True, "mode": "simulation"}
            return self.disconnect_mt5()

        if self.provider.mode == "live":
            return {
                "ok": True,
                "mode": "live",
                "tradingEnabled": self.live_allowed(),
            }
        if not self.live_allowed():
            raise RiskError(
                "live trading is locked: press 'Enable live trading' in the Safety section "
                "of the Execution page (or set ALLOW_LIVE_TRADES=1 in mt5-bridge/.env), "
                "then confirm again"
            )
        if request.confirm != "LIVE":
            raise RiskError('switching to live requires the typed confirmation "LIVE"')
        self.reconnect_mt5()
        if self.provider.mode != "live":
            raise RiskError(
                "live mode is unavailable: no MetaTrader 5 terminal is connected "
                f"({self.provider.reason or 'no terminal'})"
            )
        return {"ok": True, "mode": "live", "tradingEnabled": True}

    # ------------------------------------------------------------ strategies
    def list_strategies(self) -> list[dict]:
        strategies = self.store.list_strategies()
        perf = {row["id"]: row for row in self.performance()["strategies"]}
        for strategy in strategies:
            # The source code can be hundreds of kilobytes; the desk only needs
            # to know that it exists. Backtests load it from the store directly.
            strategy["hasCode"] = bool(strategy.get("code"))
            strategy.pop("code", None)
            strategy["performance"] = perf.get(strategy["id"], {})
        return strategies

    def sync_strategy(self, manifest: StrategyManifest, *, source: str = "local") -> dict:
        validate_strategy(manifest)
        saved = self.store.upsert_strategy(manifest.model_dump(), source=source)
        self.store.audit("strategy.registered", {"id": manifest.id, "source": source})
        return saved

    def set_strategy_enabled(self, sid: str, enabled: bool, auto: bool | None = None) -> dict:
        row = self.store.set_strategy_enabled(sid, enabled, auto)
        if not row:
            raise ValueError("strategy not found")
        self.store.audit("strategy.toggled", {"id": sid, "enabled": enabled, "autoExecute": row["autoExecute"]})
        return row

    # -------------------------------------------------------------- signals
    def list_signals(self, status: str | None = None) -> list[dict]:
        return self.store.list_signals(status)

    def add_signal(self, signal: SignalIn) -> dict:
        strategy = self.store.get_strategy(signal.strategyId)
        if not strategy:
            raise ValueError(f"unknown strategy: {signal.strategyId}")
        row = self.store.add_signal(signal.model_dump(), cloud_id=signal.id)
        self.store.audit("signal.received", {"id": row["id"], "strategy": signal.strategyId})
        return row

    def _size_from_risk(self, symbol: str, entry: float, sl: float | None, risk_pct: float) -> float:
        spec = spec_for(symbol)
        account = self.provider.account()
        equity = account["equity"] if account else 10_000
        if not sl or sl == entry:
            lots = self.risk.maxLotPerTrade
        else:
            distance = abs(entry - sl)
            if distance <= 0:
                lots = spec.min_lot
            else:
                lots = (equity * risk_pct / 100) / (distance * spec.contract)
        lots = min(lots, self.risk.maxLotPerTrade)
        return max(spec.min_lot, round(round(lots / spec.lot_step) * spec.lot_step, 2))

    def approve_signal(self, sid: str, volume: float | None, note: str = "") -> dict:
        signal = self.store.get_signal(sid)
        if not signal:
            raise ValueError("signal not found")
        if signal["status"] != "pending":
            raise ValueError(f"signal is already {signal['status']}")
        strategy = self.store.get_strategy(signal["strategyId"])
        if not strategy:
            raise ValueError("strategy for this signal no longer exists")
        quote = self.provider.quote(signal["symbol"])
        entry = quote["ask"] if signal["side"] == "buy" else quote["bid"]
        lots = volume or self._size_from_risk(
            signal["symbol"], entry, signal.get("sl"), strategy["risk"]["riskPct"]
        )
        order = self.place_order(
            OrderRequest(
                symbol=signal["symbol"],
                side=signal["side"],
                volume=lots,
                type="market",
                sl=signal.get("sl"),
                tp=signal.get("tp"),
                comment=f"signal:{sid[:16]}",
                strategyId=signal["strategyId"],
                idempotencyKey=f"signal:{sid}",
                confirm=True,
            )
        )
        ticket = order["order"].get("ticket")
        updated = self.store.decide_signal(sid, "executed", note or "approved in the execution desk", ticket)
        return {"ok": True, "signal": updated, "order": order["order"]}

    def reject_signal(self, sid: str, note: str = "") -> dict:
        signal = self.store.get_signal(sid)
        if not signal:
            raise ValueError("signal not found")
        if signal["status"] != "pending":
            raise ValueError(f"signal is already {signal['status']}")
        updated = self.store.decide_signal(sid, "rejected", note or "rejected in the execution desk")
        self.store.audit("signal.rejected", {"id": sid})
        return {"ok": True, "signal": updated}

    # ---------------------------------------------------------- signal feed
    def set_prop_safe(self, enabled: bool) -> dict:
        """Signal-only lock for prop-firm accounts.

        When on, the bridge refuses every opening order (manual, approved or
        auto-executed) and keeps only the signal/indicator workflow. Closes and
        stop changes stay available because reducing risk is always allowed.
        """
        self.prop_safe = bool(enabled)
        self.store.set_json("prop_safe", self.prop_safe)
        self.store.audit("safety.prop_safe", {"enabled": self.prop_safe})
        return {"ok": True, "propSafe": self.prop_safe}

    def scan_signals(self) -> list[dict]:
        """Evaluate enabled rule strategies now and queue any fresh signal."""
        rows = [row for row in self.store.list_strategies() if row.get("enabled")]
        generated = SignalFeed(self.provider).scan(rows)
        created: list[dict] = []
        for signal in generated:
            sid = _signal_id(signal["strategyId"], signal["symbol"], signal["barTime"])
            if self.store.get_signal(sid):
                # Same closed bar: the ticket already exists, so nothing is new.
                continue
            row = self.store.add_signal({**signal, "id": sid})
            if row.get("id") == sid and row.get("status") == "pending" and not row.get("decided"):
                created.append(row)
                self.store.audit(
                    "signal.generated",
                    {
                        "id": row["id"],
                        "strategy": signal["strategyId"],
                        "symbol": signal["symbol"],
                        "side": signal["side"],
                        "barTime": signal["barTime"],
                    },
                )
        self._expire_signals()
        return created

    def _scan_live_signals(self) -> None:
        now = time.time()
        if now - self._last_signal_scan < 15:
            return
        self._last_signal_scan = now
        try:
            self.scan_signals()
        except Exception as exc:
            self.store.audit("signal.scan_failed", str(exc), ok=False)

    def _expire_signals(self) -> None:
        """Pending strategy signals stop being actionable after two bars."""
        now = int(time.time())
        for signal in self.store.list_signals("pending", 200):
            if signal.get("source") != "strategy":
                continue
            bar_time = int(signal.get("barTime") or 0)
            step = TF_MINUTES.get(str(signal.get("timeframe") or "H1"), 60) * 60
            if bar_time and now > bar_time + max(3600, 2 * step):
                self.store.decide_signal(
                    signal["id"], "expired", "expired: older than two bars"
                )

    def _auto_execute_signals(self) -> None:
        if self.risk.killSwitch or self.prop_safe:
            return
        for signal in self.store.list_signals("pending", 50):
            strategy = self.store.get_strategy(signal["strategyId"])
            if not strategy or not strategy.get("enabled") or not strategy.get("autoExecute"):
                continue
            # Only act on fresh signals (one hour) to avoid surprise fills.
            try:
                created = datetime.fromisoformat(signal["createdAt"].replace("Z", "+00:00"))
                if (datetime.now(tz=timezone.utc) - created).total_seconds() > 3600:
                    continue
                self.approve_signal(signal["id"], None, "auto-executed by strategy policy")
                self.store.audit("signal.auto_executed", {"id": signal["id"], "strategy": strategy["id"]})
            except Exception as exc:
                self.store.audit("signal.auto_execute_failed", {"id": signal["id"], "error": str(exc)}, ok=False)

    # ----------------------------------------------------------- performance
    def performance(self) -> dict:
        deals = self.provider.history(365)
        groups: dict[str, list[dict]] = {}
        for deal in deals:
            key = deal.get("strategyId") or "manual"
            groups.setdefault(key, []).append(deal)

        strategies = []
        backtests = self.store.list_backtests(50)
        for strategy in self.store.list_strategies():
            trades = groups.get(strategy["id"], [])
            if trades:
                avg_loss = abs(
                    sum(t["pnl"] for t in trades if t["pnl"] < 0)
                    / max(1, len([t for t in trades if t["pnl"] < 0]))
                )
                for trade in trades:
                    trade["r"] = round(trade["pnl"] / avg_loss, 3) if avg_loss else 0.0
            live = summarise(trades)
            latest_bt = next(
                (bt for bt in backtests if bt["strategyId"] == strategy["id"]), None
            )
            bt_stats = latest_bt["stats"] if latest_bt else None
            # Prefer live evidence once there is enough of it.
            primary = live if live["trades"] >= 10 or not bt_stats else bt_stats
            # Never label an empty sample as live evidence: a strategy with no
            # closed trades yet is "none", not a 0% win rate.
            if primary is live:
                evidence = "live" if live["trades"] else "none"
            else:
                evidence = "backtest"
            strategies.append(
                {
                    "id": strategy["id"],
                    "name": strategy["name"],
                    "enabled": strategy["enabled"],
                    "autoExecute": strategy["autoExecute"],
                    "source": strategy.get("source", "local"),
                    "live": live,
                    "backtest": bt_stats,
                    "backtestId": latest_bt["id"] if latest_bt else None,
                    "successRate": primary.get("winRate", 0.0),
                    "profitFactor": primary.get("profitFactor"),
                    "score": primary.get("score", 0.0),
                    "confidence": primary.get("confidence", "insufficient"),
                    "sample": primary.get("trades", 0),
                    "expectancyR": primary.get("expectancyR"),
                    "maxDrawdownPct": primary.get("maxDrawdownPct"),
                    "evidence": evidence,
                }
            )

        manual = groups.get("manual", [])
        strategies.sort(key=lambda row: row["score"], reverse=True)
        return {
            "generatedAt": _now(),
            "mode": self.provider.mode,
            "overall": summarise([d for d in deals]),
            "manual": summarise(manual),
            "strategies": strategies,
        }

    # ------------------------------------------------------------- backtests
    def backtest(self, request: BacktestRequest) -> dict:
        manifest: StrategyManifest
        if request.strategy:
            manifest = validate_strategy(request.strategy)
        else:
            row = self.store.get_strategy(request.strategyId or "")
            if not row:
                raise ValueError("strategy not found")
            row = {k: v for k, v in row.items() if k not in {"source", "createdAt", "updatedAt"}}
            manifest = validate_strategy(StrategyManifest(**row))

        timeframe = request.timeframe or manifest.timeframe
        end_ts = _parse_time(request.end) if request.end else int(time.time())
        requested_start = (
            _parse_time(request.start)
            if request.start
            else end_ts - 365 * 2 * 86400
        )
        if requested_start >= end_ts:
            raise ValueError("start must be before end")

        # Cap the number of bars so one request stays responsive. M1 gets the
        # most bars because a day is 1440 of them; higher timeframes need far
        # fewer. When the requested window is longer we shorten the start and
        # say so in the result instead of silently pretending otherwise.
        step = TF_MINUTES.get(timeframe, 60) * 60
        max_bars = BACKTEST_BAR_CAPS.get(timeframe, 20_000)
        requested_bars = int((end_ts - requested_start) / step) + 1
        start_ts = requested_start
        window_capped = False
        if requested_bars > max_bars:
            start_ts = end_ts - max_bars * step
            window_capped = True

        bars = self.provider.rates(request.symbol, timeframe, start_ts, end_ts)
        if len(bars) < 60:
            raise ValueError("not enough historical bars for this symbol/timeframe")

        symbol_ctx = SymbolCtx(
            symbol=request.symbol,
            contract=spec_for(request.symbol).contract,
            pip=spec_for(request.symbol).pip,
            digits=spec_for(request.symbol).digits,
        )
        if manifest.runtime == "external":
            raise ValueError(
                "This strategy is an external MetaTrader 5 driver: it places its own orders, "
                "so the bridge cannot replay it on bar history. Register a JSON manifest or a "
                "Python on_bar strategy to run backtests."
            )
        run_kwargs = {
            "initial_balance": request.initialBalance,
            "risk_pct": request.riskPct,
            "spread_pips": request.spreadPips,
            "commission_per_lot": request.commissionPerLot,
            "leverage": request.leverage,
        }
        if manifest.runtime == "python":
            result = run_python_backtest(
                manifest, bars, symbol_ctx, timeframe=timeframe, **run_kwargs
            )
        else:
            result = run_backtest(manifest, bars, symbol_ctx, **run_kwargs)
        params = {
            "symbol": request.symbol,
            "timeframe": timeframe,
            "start": start_ts,
            "end": end_ts,
            "requestedStart": requested_start,
            "requestedBars": requested_bars,
            "windowCapped": window_capped,
            "maxBars": max_bars,
            "initialBalance": request.initialBalance,
            "riskPct": request.riskPct,
            "spreadPips": request.spreadPips,
            "commissionPerLot": request.commissionPerLot,
            "leverage": request.leverage,
            "mode": self.provider.mode,
        }
        result["stats"].update(
            {
                "requestedStart": requested_start,
                "requestedBars": requested_bars,
                "windowCapped": window_capped,
                "maxBars": max_bars,
                "barsAvailable": len(bars),
            }
        )
        record = self.store.save_backtest(manifest.id, request.symbol, timeframe, params, result)
        self.store.audit(
            "backtest.completed",
            {"id": record["id"], "strategy": manifest.id, "trades": result["stats"]["trades"]},
        )
        return {
            "id": record["id"],
            "strategyId": manifest.id,
            "strategyName": manifest.name,
            "symbol": request.symbol,
            "timeframe": timeframe,
            "params": params,
            "result": result,
        }

    def list_backtests(self) -> list[dict]:
        return self.store.list_backtests(30)

    def get_backtest(self, bid: str) -> dict:
        row = self.store.get_backtest(bid)
        if not row:
            raise ValueError("backtest not found")
        return row


def _now() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def _signal_id(strategy_id: str, symbol: str, bar_time: int) -> str:
    import hashlib

    digest = hashlib.sha1(f"{strategy_id}|{symbol}|{bar_time}".encode()).hexdigest()[:12]
    return f"sig_gen_{digest}"


def _parse_time(value: str) -> int:
    raw = str(value).strip()
    if raw.isdigit():
        return int(raw)
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return int(datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    try:
        return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp())
    except Exception as exc:
        raise ValueError(f"invalid date: {value}") from exc

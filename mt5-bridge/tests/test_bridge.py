"""Unit and integration tests for the MT5 bridge (simulation broker).

Run from mt5-bridge/:
    .venv\\Scripts\\python.exe -m unittest discover -s tests -v
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("BRIDGE_MODE", "simulation")
os.environ.setdefault("CLOUD_SYNC", "0")

from app.backtest import SymbolCtx, run_backtest  # noqa: E402
from app.engine import RiskError, TradingEngine  # noqa: E402
from app.models import (  # noqa: E402
    Condition,
    Group,
    OrderRequest,
    RiskConfig,
    SignalIn,
    StrategyManifest,
)
from app.performance import max_drawdown, summarise, trade_stats, wilson_lower  # noqa: E402
from app.mql5_export import generate_indicator  # noqa: E402
from app.providers import SimProvider, spec_for, synthetic_bars  # noqa: E402
from app.python_backtest import run_python_backtest  # noqa: E402
from app.python_strategies import AnalysisError, analyze_python, extract_python  # noqa: E402
from app.store import Store  # noqa: E402
from app.strategies import StrategyError, validate_strategy  # noqa: E402


def trend_bars(count: int = 400, start_price: float = 2000.0) -> list[dict]:
    bars = []
    price = start_price
    for i in range(count):
        drift = 0.0015 if (i // 60) % 2 == 0 else -0.0012
        open_price = price
        price *= 1 + drift
        high = max(open_price, price) * 1.0008
        low = min(open_price, price) * 0.9992
        bars.append(
            {
                "time": 1_700_000_000 + i * 3600,
                "open": open_price,
                "high": high,
                "low": low,
                "close": price,
                "volume": 1000,
            }
        )
    return bars


def always_long(stop=20.0, target=40.0) -> StrategyManifest:
    return StrategyManifest(
        id="test-always-long",
        name="Always long",
        symbols=["XAUUSD"],
        timeframe="H1",
        direction="long",
        entry=Group(all=[Condition(type="always")]),
        stop={"type": "pips", "pips": stop},
        target={"type": "pips", "pips": target},
        risk={"riskPct": 1.0},
    )


class ReportTests(unittest.TestCase):
    def test_period_aggregates_and_reasons(self) -> None:
        from app.report import build_report

        # Two days of trades, deliberately out of order, with a cross-month
        # boundary so day/week/month grouping each gets exercised.
        def ts(day: int, hour: int = 10) -> int:
            return int(datetime(2026, 1, day, hour, tzinfo=timezone.utc).timestamp())

        trades = [
            {"pnl": 120.0, "r": 2.0, "reason": "target", "entryTime": ts(2), "exitTime": ts(2, 11)},
            {"pnl": -40.0, "r": -1.0, "reason": "stop", "entryTime": ts(2), "exitTime": ts(2, 15)},
            {"pnl": -60.0, "r": -1.0, "reason": "stop", "entryTime": ts(1), "exitTime": ts(1, 12)},
            {"pnl": 200.0, "r": 2.0, "reason": "signal", "entryTime": ts(30), "exitTime": ts(30, 13)},
        ]
        report = build_report(trades, initial_balance=10_000)

        self.assertEqual(report["totals"]["trades"], 4)
        self.assertEqual(report["totals"]["wins"], 2)
        self.assertEqual(report["totals"]["netPnl"], 220.0)

        self.assertEqual(len(report["days"]), 3)
        self.assertEqual(report["bestDay"]["key"], "2026-01-30")
        self.assertEqual(report["worstDay"]["key"], "2026-01-01")

        # Jan 1 and Jan 2 are in ISO week 1, Jan 30 in week 5.
        self.assertEqual(len(report["weeks"]), 2)
        self.assertEqual(len(report["months"]), 1)

        reasons = {row["reason"]: row for row in report["reasons"]}
        self.assertEqual(reasons["stop"]["count"], 2)
        self.assertEqual(reasons["stop"]["pnl"], -100.0)
        # Reasons are sorted worst-first, which is how losses are surfaced.
        self.assertEqual(report["reasons"][0]["reason"], "stop")
        # Equity start/end are carried per bucket.
        self.assertEqual(report["days"][0]["equityStart"], 10_000)
        self.assertEqual(report["days"][-1]["equityEnd"], 10_220)

    def test_m1_backtest_is_supported(self) -> None:
        manifest = validate_strategy(always_long())
        bars = trend_bars()
        result = run_backtest(
            manifest,
            bars,
            SymbolCtx("NAS100", contract=1, pip=1.0, digits=1),
            initial_balance=10_000,
            spread_pips=1.0,
        )
        self.assertIn("report", result)
        self.assertEqual(
            sum(day["trades"] for day in result["report"]["days"]),
            len(result["trades"]),
        )


class PythonStrategyTests(unittest.TestCase):
    RUNNABLE = """
META = {"id": "py-ema", "name": "Python EMA", "symbols": ["XAUUSD"], "timeframe": "M1", "warmup": 30}
import math

def on_bar(ctx):
    fast, slow = ctx.ema(9), ctx.ema(21)
    if ctx.crossover(fast, slow):
        return {"action": "buy", "stop_atr": 2, "target_atr": 4}
    if ctx.crossunder(fast, slow):
        return {"action": "sell", "stop_atr": 2, "target_atr": 4}
    return None
"""

    def test_runnable_manifest_and_backtest(self) -> None:
        analysis = analyze_python(self.RUNNABLE, filename="py_ema.py")
        self.assertEqual(analysis["mode"], "python")
        self.assertEqual(analysis["manifest"]["id"], "py-ema")
        self.assertIn("on_bar", analysis["hooks"])
        self.assertEqual(analysis["manifest"]["symbols"], ["XAUUSD"])

        manifest = validate_strategy(StrategyManifest(**analysis["manifest"]))
        bars = synthetic_bars("XAUUSD", "M1", 1_760_000_000, 1_760_000_000 + 5 * 86400)
        spec = spec_for("XAUUSD")
        ctx = SymbolCtx("XAUUSD", contract=spec.contract, pip=spec.pip, digits=spec.digits)
        result = run_python_backtest(
            manifest, bars, ctx, timeframe="M1", initial_balance=10_000, spread_pips=2
        )
        self.assertGreater(result["stats"]["trades"], 0)
        self.assertIn("report", result)
        self.assertEqual(
            sum(day["trades"] for day in result["report"]["days"]),
            len(result["trades"]),
        )
        # Every trade has the same shape the DSL engine emits.
        trade = result["trades"][0]
        for key in ("side", "entry", "exit", "lots", "pnl", "r", "entryTime", "exitTime", "reason"):
            self.assertIn(key, trade)

    def test_external_driver_is_detected_and_not_backtested(self) -> None:
        code = (
            "import MetaTrader5 as mt5\n"
            "SYMBOL = 'XAUUSD'\n"
            "def run_bot():\n"
            "    mt5.initialize()\n"
            "    mt5.order_send({'symbol': SYMBOL})\n"
        )
        analysis = analyze_python(code, filename="xauusd ea.py")
        self.assertEqual(analysis["mode"], "external")
        self.assertEqual(analysis["manifest"]["symbols"], ["XAUUSD"])
        self.assertEqual(analysis["manifest"]["runtime"], "external")
        self.assertTrue(analysis["warnings"])

        manifest = validate_strategy(StrategyManifest(**analysis["manifest"]))
        spec = spec_for("XAUUSD")
        ctx = SymbolCtx("XAUUSD", contract=spec.contract, pip=spec.pip, digits=spec.digits)
        bars = synthetic_bars("XAUUSD", "M1", 1_760_000_000, 1_760_000_000 + 3 * 86400)
        with self.assertRaises(ValueError):
            run_python_backtest(manifest, bars, ctx)

    def test_json_bundle_accepts_python_source(self) -> None:
        payload = {
            "metadata": {"source_file": "bundle_strategy.py", "language": "python"},
            "source": self.RUNNABLE,
        }
        code, filename = extract_python(payload)
        self.assertIn("def on_bar", code)
        self.assertEqual(filename, "bundle_strategy.py")
        analysis = analyze_python(payload)
        self.assertEqual(analysis["manifest"]["sourceFile"], "bundle_strategy.py")
        self.assertEqual(analysis["mode"], "python")

    def test_sandbox_rejects_filesystem_imports(self) -> None:
        code = (
            "import os\n"
            "def on_bar(ctx):\n"
            "    return None\n"
        )
        with self.assertRaises(AnalysisError) as caught:
            analyze_python(code, filename="bad.py")
        message = str(caught.exception)
        self.assertIn("os", message)

    def test_missing_on_bar_is_reported(self) -> None:
        with self.assertRaises(AnalysisError) as caught:
            analyze_python("META = {'name': 'No hook'}\n", filename="nohook.py")
        self.assertIn("on_bar", str(caught.exception))


class BacktestTests(unittest.TestCase):
    def test_runs_and_has_trades(self) -> None:
        manifest = validate_strategy(always_long())
        result = run_backtest(
            manifest,
            trend_bars(),
            SymbolCtx("XAUUSD", contract=100, pip=0.1, digits=2),
            initial_balance=10_000,
            spread_pips=1.0,
        )
        stats = result["stats"]
        self.assertGreater(stats["trades"], 0)
        self.assertEqual(stats["initialBalance"], 10_000)
        self.assertIn("winRate", stats)
        self.assertGreaterEqual(len(result["equity"]), 2)
        # Every trade must have an entry before its exit and a finite PnL.
        for trade in result["trades"]:
            self.assertLessEqual(trade["entryTime"], trade["exitTime"])
            self.assertIsInstance(trade["pnl"], float)
            self.assertIn(trade["reason"], {"stop", "target", "signal", "end_of_data"})

    def test_respects_stop_and_target(self) -> None:
        manifest = validate_strategy(always_long(stop=50.0, target=50.0))
        bars = trend_bars()
        result = run_backtest(
            manifest,
            bars,
            SymbolCtx("XAUUSD", contract=100, pip=0.1, digits=2),
            initial_balance=10_000,
            spread_pips=0.0,
        )
        risk_distance = 50 * 0.1
        for trade in result["trades"]:
            entry, exit_ = trade["entry"], trade["exit"]
            if trade["side"] == "buy":
                self.assertGreaterEqual(exit_, entry - risk_distance - 1e-6)
        self.assertTrue(all(t["lots"] > 0 for t in result["trades"]))

    def test_ema_strategy_uses_indicators(self) -> None:
        manifest = StrategyManifest(
            id="test-ema",
            name="EMA cross",
            symbols=["XAUUSD"],
            timeframe="H1",
            direction="both",
            entryLong=Group(
                all=[Condition(type="ema_cross", fast=10, slow=30, direction="up")]
            ),
            entryShort=Group(
                all=[Condition(type="ema_cross", fast=10, slow=30, direction="down")]
            ),
            stop={"type": "atr", "mult": 2},
            target={"type": "atr", "mult": 4},
        )
        result = run_backtest(
            manifest,
            trend_bars(),
            SymbolCtx("XAUUSD", 100, 0.1, 2),
            initial_balance=10_000,
        )
        self.assertGreater(result["stats"]["trades"], 0)
        self.assertGreater(result["stats"]["bars"], 300)


class MetricsTests(unittest.TestCase):
    def test_trade_stats(self) -> None:
        trades = [
            {"pnl": 100, "r": 1.0, "bars": 5},
            {"pnl": -50, "r": -0.5, "bars": 3},
            {"pnl": 200, "r": 2.0, "bars": 7},
            {"pnl": -100, "r": -1.0, "bars": 2},
        ]
        stats = trade_stats(trades)
        self.assertEqual(stats["trades"], 4)
        self.assertEqual(stats["wins"], 2)
        self.assertAlmostEqual(stats["winRate"], 50.0)
        self.assertAlmostEqual(stats["profitFactor"], 2.0)
        self.assertAlmostEqual(stats["expectancy"], 37.5)
        self.assertGreater(stats["wilsonLower"], 0)

    def test_empty_and_drawdown(self) -> None:
        self.assertEqual(trade_stats([])["trades"], 0)
        absolute, pct = max_drawdown([100, 120, 90, 130])
        self.assertAlmostEqual(absolute, 30)
        self.assertAlmostEqual(pct, 25.0)
        self.assertIsNone(wilson_lower(0, 0))

    def test_score_penalises_small_samples(self) -> None:
        small = summarise([{"pnl": 10, "r": 1}] * 5, [100] * 5)
        large = summarise([{"pnl": 10, "r": 1}] * 200, [100] * 200)
        self.assertLess(small["score"], large["score"])
        self.assertEqual(small["confidence"], "insufficient")
        self.assertEqual(large["confidence"], "high")


class EngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.store = Store(Path(self.tmp.name) / "test.db")
        self.engine = TradingEngine(self.store)
        # Force the deterministic simulation broker, no background thread.
        self.engine.provider = SimProvider(self.store)
        self.engine.risk = RiskConfig(maxLotPerTrade=5, maxOpenPositions=5)

    def tearDown(self) -> None:
        self.store.close()
        self.tmp.cleanup()

    def test_live_interlock_toggle(self) -> None:
        """The website unlock persists in the store, survives a new engine, and
        can be revoked — without ever touching SETTINGS.allow_live_trades."""
        from app.engine import TradingEngine

        self.assertFalse(self.engine.live_allowed())
        self.engine.set_live_allowed(True)
        self.assertTrue(self.engine.live_allowed())
        self.assertEqual(self.store.get_kv("allow_live"), "1")

        # A fresh engine over the same database sees the unlock (restart-proof).
        engine2 = TradingEngine(self.store)
        self.assertTrue(engine2.live_allowed())

        self.engine.set_live_allowed(False)
        self.assertFalse(self.engine.live_allowed())
        self.assertEqual(self.store.get_kv("allow_live"), "0")

    def test_order_lifecycle(self) -> None:
        quote = self.engine.provider.quote("XAUUSD")
        order = self.engine.place_order(
            OrderRequest(
                symbol="XAUUSD",
                side="buy",
                volume=0.2,
                sl=round(quote["bid"] - 20, 2),
                tp=round(quote["bid"] + 40, 2),
                confirm=True,
                strategyId=None,
            )
        )
        ticket = order["order"]["ticket"]
        positions = self.engine.provider.positions()
        self.assertEqual(len(positions), 1)
        self.assertEqual(positions[0]["ticket"], ticket)

        modified = self.engine.modify_position(
            ticket, __import__("app.models", fromlist=["ModifyRequest"]).ModifyRequest(sl=round(quote["bid"] - 10, 2), tp=None)
        )
        self.assertTrue(modified["ok"])

        partial = self.engine.close_position(ticket, volume=0.1)
        self.assertEqual(partial["position"]["closedVolume"], 0.1)
        remaining = self.engine.provider.positions()
        self.assertEqual(len(remaining), 1)
        self.assertAlmostEqual(remaining[0]["volume"], 0.1, places=2)

        self.engine.close_position(ticket)
        self.assertEqual(self.engine.provider.positions(), [])
        history = self.engine.provider.history(30)
        self.assertEqual(len(history), 2)
        self.assertTrue(all(t["ticket"] == ticket for t in history))

    def test_risk_caps(self) -> None:
        with self.assertRaises(RiskError):
            self.engine.place_order(
                OrderRequest(symbol="XAUUSD", side="buy", volume=50, confirm=True)
            )
        self.engine.risk.killSwitch = True
        with self.assertRaises(RiskError):
            self.engine.place_order(
                OrderRequest(symbol="XAUUSD", side="buy", volume=0.1, confirm=True)
            )
        self.engine.risk.killSwitch = False

        self.engine.risk.symbolWhitelist = ["EURUSD"]
        with self.assertRaises(RiskError):
            self.engine.place_order(
                OrderRequest(symbol="XAUUSD", side="buy", volume=0.1, confirm=True)
            )

    def test_idempotency(self) -> None:
        request = OrderRequest(
            symbol="XAUUSD", side="buy", volume=0.1, confirm=True, idempotencyKey="abc-123"
        )
        first = self.engine.place_order(request)
        second = self.engine.place_order(request)
        self.assertEqual(first["order"]["ticket"], second["order"]["ticket"])
        self.assertEqual(len(self.engine.provider.positions()), 1)

    def test_signals_and_performance(self) -> None:
        self.engine.sync_strategy(
            StrategyManifest(
                id="signal-strategy",
                name="Signal strategy",
                symbols=["XAUUSD"],
                timeframe="H1",
                direction="long",
                entry=Group(all=[Condition(type="always")]),
                risk={"riskPct": 1.0},
            )
        )
        signal = self.engine.add_signal(
            SignalIn(
                strategyId="signal-strategy",
                symbol="XAUUSD",
                side="buy",
                sl=round(self.engine.provider.quote("XAUUSD")["bid"] - 30, 2),
                confidence=0.72,
            )
        )
        approved = self.engine.approve_signal(signal["id"], 0.1, "test")
        self.assertEqual(approved["signal"]["status"], "executed")
        self.assertTrue(approved["order"]["ticket"])
        perf = self.engine.performance()
        self.assertTrue(any(row["id"] == "signal-strategy" for row in perf["strategies"]))

    def test_backtest_via_engine(self) -> None:
        self.engine.sync_strategy(
            StrategyManifest(
                id="bt-strategy",
                name="Backtest strategy",
                symbols=["XAUUSD"],
                timeframe="H1",
                direction="long",
                entry=Group(all=[Condition(type="ema_cross", fast=10, slow=30, direction="up")]),
                stop={"type": "atr", "mult": 2},
                target={"type": "atr", "mult": 4},
            )
        )
        now = 1_750_000_000
        # SimProvider.rates falls back to deterministic synthetic bars.
        result = self.engine.backtest(
            __import__("app.models", fromlist=["BacktestRequest"]).BacktestRequest(
                strategyId="bt-strategy",
                symbol="XAUUSD",
                start=str(now - 400 * 3600),
                end=str(now),
                initialBalance=10_000,
            )
        )
        self.assertTrue(result["id"].startswith("bt_"))
        self.assertGreater(result["result"]["stats"]["bars"], 100)
        self.assertTrue(self.store.list_backtests())

    def test_synthetic_bars_are_deterministic(self) -> None:
        a = synthetic_bars("XAUUSD", "H1", 1_700_000_000, 1_700_200_000)
        b = synthetic_bars("XAUUSD", "H1", 1_700_000_000, 1_700_200_000)
        self.assertEqual(a, b)
        self.assertTrue(all(bar["low"] <= bar["close"] <= bar["high"] for bar in a))


class StrategyValidationTests(unittest.TestCase):
    """The editor on /execution validates manifests through these helpers."""

    def test_valid_editor_manifest_reports_warmup(self) -> None:
        from app.strategies import warmup_bars

        manifest = StrategyManifest(
            id="my-gold-cross",
            name="My Gold EMA cross",
            symbols=["XAUUSD"],
            entryLong=Group(
                all=[
                    Condition(type="ema_cross", fast=20, slow=50, direction="up"),
                    Condition(type="rsi", period=14, op="above", value=50),
                ]
            ),
            stop={"type": "atr", "mult": 2},
            target={"type": "atr", "mult": 4},
        )
        validated = validate_strategy(manifest)
        self.assertEqual(validated.id, "my-gold-cross")
        self.assertEqual(warmup_bars(validated), 53)

    def test_editor_manifest_errors_are_explained(self) -> None:
        with self.assertRaises(StrategyError) as ctx:
            validate_strategy(
                StrategyManifest(
                    id="bad-cross",
                    name="Bad cross",
                    symbols=["XAUUSD"],
                    entry=Group(all=[Condition(type="ema_cross", fast=50, slow=20, direction="up")]),
                )
            )
        self.assertIn("fast must be smaller than slow", str(ctx.exception))

        with self.assertRaises(StrategyError) as ctx:
            validate_strategy(
                StrategyManifest(
                    id="bad-type",
                    name="Bad type",
                    symbols=["XAUUSD"],
                    entry=Group(all=[Condition(type="ichimoku", period=9)]),
                )
            )
        self.assertIn("unknown condition type", str(ctx.exception))


class SignalFeedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.store = Store(Path(self.tmp.name) / "test.db")
        self.engine = TradingEngine(self.store)
        self.engine.provider = SimProvider(self.store)
        self.engine.risk = RiskConfig(maxLotPerTrade=5, maxOpenPositions=5)

    def tearDown(self) -> None:
        self.store.close()
        self.tmp.cleanup()

    def _manifest(self) -> StrategyManifest:
        return StrategyManifest(
            id="signal-always",
            name="Signal always long",
            symbols=["XAUUSD"],
            timeframe="H1",
            direction="long",
            entry=Group(all=[Condition(type="always")]),
            stop={"type": "atr", "mult": 2},
            target={"type": "atr", "mult": 4},
        )

    def test_enabled_strategy_publishes_ticket_with_plan(self) -> None:
        self.engine.sync_strategy(self._manifest())
        self.engine.set_strategy_enabled("signal-always", True)
        created = self.engine.scan_signals()
        self.assertEqual(len(created), 1)
        signal = created[0]
        self.assertEqual(signal["side"], "buy")
        self.assertGreater(signal["entry"], 0)
        self.assertGreater(signal["sl"], 0)
        self.assertGreater(signal["tp"], 0)
        self.assertGreater(signal["lots"], 0)
        self.assertEqual(signal["source"], "strategy")
        self.assertTrue(signal["signalOnly"])
        self.assertEqual(signal["management"]["breakevenAtR"], 1.0)
        self.assertIn("breakeven", " ".join(signal["management"]["steps"]).lower())
        self.assertEqual(signal["status"], "pending")
        # Same closed bar twice must not duplicate the ticket.
        self.assertEqual(self.engine.scan_signals(), [])

    def test_disabled_strategy_does_not_publish(self) -> None:
        self.engine.sync_strategy(self._manifest())
        self.assertEqual(self.engine.scan_signals(), [])


class PropSafeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.store = Store(Path(self.tmp.name) / "test.db")
        self.engine = TradingEngine(self.store)
        self.engine.provider = SimProvider(self.store)
        self.engine.risk = RiskConfig(maxLotPerTrade=5, maxOpenPositions=5)

    def tearDown(self) -> None:
        self.store.close()
        self.tmp.cleanup()

    def test_signal_only_lock_refuses_orders_and_survives_restart(self) -> None:
        self.engine.set_prop_safe(True)
        self.assertTrue(self.engine.prop_safe)
        with self.assertRaises(RiskError) as ctx:
            self.engine.place_order(
                OrderRequest(symbol="XAUUSD", side="buy", volume=0.1, confirm=True)
            )
        self.assertIn("signal-only", str(ctx.exception).lower())

        # A fresh engine over the same database still refuses orders.
        engine2 = TradingEngine(self.store)
        engine2.provider = SimProvider(self.store)
        self.assertTrue(engine2.prop_safe)
        with self.assertRaises(RiskError):
            engine2.place_order(
                OrderRequest(symbol="XAUUSD", side="buy", volume=0.1, confirm=True)
            )

        # Unlocking restores normal (interlock-respecting) routing.
        engine2.set_prop_safe(False)
        order = engine2.place_order(
            OrderRequest(symbol="XAUUSD", side="buy", volume=0.1, confirm=True)
        )
        self.assertTrue(order["ok"])


class Mql5ExportTests(unittest.TestCase):
    def _manifest(self) -> StrategyManifest:
        return StrategyManifest(
            id="export-test",
            name="Export test",
            symbols=["XAUUSD"],
            timeframe="H1",
            entryLong=Group(
                all=[Condition(type="ema_cross", fast=20, slow=50, direction="up")]
            ),
            entryShort=Group(
                all=[Condition(type="rsi", period=14, op="above", value=70)]
            ),
            stop={"type": "atr", "mult": 2},
            target={"type": "pips", "pips": 500},
            trail={"type": "atr", "mult": 1.5},
        )

    def test_indicator_is_signal_only_and_contains_rules(self) -> None:
        source = generate_indicator(self._manifest())
        self.assertIn("#property indicator_chart_window", source)
        self.assertIn("C_EMA_CROSS", source)
        self.assertIn("C_RSI", source)
        self.assertIn("STRAT_RISK", source)
        self.assertIn("breakeven", source.lower())
        # Prop-firm safe: no trading calls in the generated file.
        for forbidden in ("OrderSend(", "#include <Trade\\\\Trade.mqh>", "PositionOpen("):
            self.assertNotIn(forbidden, source)

    def test_python_and_external_cannot_be_exported(self) -> None:
        manifest = self._manifest()
        manifest.runtime = "python"
        with self.assertRaises(ValueError):
            generate_indicator(manifest)
        manifest.runtime = "external"
        with self.assertRaises(ValueError):
            generate_indicator(manifest)


if __name__ == "__main__":
    unittest.main()


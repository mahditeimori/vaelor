"""Unit and integration tests for the MT5 bridge (simulation broker).

Run from mt5-bridge/:
    .venv\\Scripts\\python.exe -m unittest discover -s tests -v
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
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
from app.providers import SimProvider, synthetic_bars  # noqa: E402
from app.store import Store  # noqa: E402
from app.strategies import validate_strategy  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()

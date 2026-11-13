"""SQLite persistence for strategies, signals, backtests, paper book and audit."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  manifest TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local',
  enabled INTEGER NOT NULL DEFAULT 0,
  auto_execute INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  cloud_id TEXT UNIQUE,
  strategy_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created TEXT NOT NULL,
  decided TEXT,
  note TEXT,
  ticket INTEGER
);
CREATE TABLE IF NOT EXISTS backtests (
  id TEXT PRIMARY KEY,
  strategy_id TEXT,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  created TEXT NOT NULL,
  params TEXT NOT NULL,
  result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_positions (
  ticket INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  volume REAL NOT NULL,
  open_price REAL NOT NULL,
  sl REAL,
  tp REAL,
  magic INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  strategy_id TEXT,
  opened TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_orders (
  ticket INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  volume REAL NOT NULL,
  type TEXT NOT NULL,
  price REAL NOT NULL,
  sl REAL,
  tp REAL,
  comment TEXT,
  strategy_id TEXT,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  volume REAL NOT NULL,
  open_price REAL NOT NULL,
  close_price REAL NOT NULL,
  pnl REAL NOT NULL,
  commission REAL NOT NULL DEFAULT 0,
  magic INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  strategy_id TEXT,
  opened TEXT,
  closed TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  ts TEXT NOT NULL
);
"""


class Store:
    def __init__(self, path: Path | str) -> None:
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    # ------------------------------------------------------------------ utils
    def _exec(self, sql: str, params: tuple | list = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def _rows(self, sql: str, params: tuple | list = ()) -> list[dict]:
        with self._lock:
            cur = self._conn.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def _row(self, sql: str, params: tuple | list = ()) -> dict | None:
        rows = self._rows(sql, params)
        return rows[0] if rows else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ----------------------------------------------------------- strategies
    def upsert_strategy(
        self,
        manifest: dict,
        *,
        source: str = "local",
        enabled: bool | None = None,
        auto_execute: bool | None = None,
    ) -> dict:
        sid = manifest["id"]
        existing = self.get_strategy(sid)
        if existing:
            keep_enabled = existing["enabled"] if enabled is None else int(enabled)
            keep_auto = existing["autoExecute"] if auto_execute is None else int(auto_execute)
            self._exec(
                "UPDATE strategies SET manifest=?, source=?, enabled=?, auto_execute=?, updated=? WHERE id=?",
                (json.dumps(manifest), source, keep_enabled, keep_auto, _now(), sid),
            )
        else:
            self._exec(
                "INSERT INTO strategies (id, manifest, source, enabled, auto_execute, created, updated)"
                " VALUES (?,?,?,?,?,?,?)",
                (
                    sid,
                    json.dumps(manifest),
                    source,
                    int(bool(enabled)),
                    int(bool(auto_execute)),
                    _now(),
                    _now(),
                ),
            )
        return self.get_strategy(sid)  # type: ignore[return-value]

    def get_strategy(self, sid: str) -> dict | None:
        row = self._row("SELECT * FROM strategies WHERE id=?", (sid,))
        return _decode_strategy(row) if row else None

    def list_strategies(self) -> list[dict]:
        return [_decode_strategy(row) for row in self._rows("SELECT * FROM strategies ORDER BY id")]

    def set_strategy_enabled(self, sid: str, enabled: bool, auto_execute: bool | None = None) -> dict | None:
        row = self.get_strategy(sid)
        if not row:
            return None
        auto = row["autoExecute"] if auto_execute is None else auto_execute
        self._exec(
            "UPDATE strategies SET enabled=?, auto_execute=?, updated=? WHERE id=?",
            (int(enabled), int(bool(auto)), _now(), sid),
        )
        return self.get_strategy(sid)

    # -------------------------------------------------------------- signals
    def add_signal(self, signal: dict, cloud_id: str | None = None) -> dict:
        sid = signal.get("id") or f"sig_{uuid.uuid4().hex[:12]}"
        existing = self._row(
            "SELECT * FROM signals WHERE id=? OR (cloud_id IS NOT NULL AND cloud_id=?)",
            (sid, cloud_id or sid),
        )
        if existing:
            return _decode_signal(existing)
        self._exec(
            "INSERT INTO signals (id, cloud_id, strategy_id, payload, status, created)"
            " VALUES (?,?,?,?,?,?)",
            (
                sid,
                cloud_id or sid,
                signal.get("strategyId", ""),
                json.dumps(signal),
                signal.get("status", "pending"),
                signal.get("createdAt") or _now(),
            ),
        )
        return _decode_signal(self._row("SELECT * FROM signals WHERE id=?", (sid,)))  # type: ignore[arg-type]

    def list_signals(self, status: str | None = None, limit: int = 100) -> list[dict]:
        if status:
            rows = self._rows(
                "SELECT * FROM signals WHERE status=? ORDER BY created DESC LIMIT ?",
                (status, limit),
            )
        else:
            rows = self._rows("SELECT * FROM signals ORDER BY created DESC LIMIT ?", (limit,))
        return [_decode_signal(row) for row in rows]

    def get_signal(self, sid: str) -> dict | None:
        row = self._row("SELECT * FROM signals WHERE id=?", (sid,))
        return _decode_signal(row) if row else None

    def decide_signal(
        self, sid: str, status: str, note: str = "", ticket: int | None = None
    ) -> dict | None:
        self._exec(
            "UPDATE signals SET status=?, note=?, decided=?, ticket=? WHERE id=?",
            (status, note, _now(), ticket, sid),
        )
        return self.get_signal(sid)

    # ------------------------------------------------------------ backtests
    def save_backtest(
        self, strategy_id: str | None, symbol: str, timeframe: str, params: dict, result: dict
    ) -> dict:
        bid = f"bt_{uuid.uuid4().hex[:12]}"
        self._exec(
            "INSERT INTO backtests (id, strategy_id, symbol, timeframe, created, params, result)"
            " VALUES (?,?,?,?,?,?,?)",
            (bid, strategy_id, symbol, timeframe, _now(), json.dumps(params), json.dumps(result)),
        )
        return {"id": bid, "strategyId": strategy_id, "symbol": symbol, "timeframe": timeframe,
                "created": _now(), "result": result}

    def list_backtests(self, limit: int = 25) -> list[dict]:
        rows = self._rows("SELECT * FROM backtests ORDER BY created DESC LIMIT ?", (limit,))
        return [
            {
                "id": row["id"],
                "strategyId": row["strategy_id"],
                "symbol": row["symbol"],
                "timeframe": row["timeframe"],
                "created": row["created"],
                "params": json.loads(row["params"]),
                "stats": json.loads(row["result"]).get("stats", {}),
            }
            for row in rows
        ]

    def get_backtest(self, bid: str) -> dict | None:
        row = self._row("SELECT * FROM backtests WHERE id=?", (bid,))
        if not row:
            return None
        return {
            "id": row["id"],
            "strategyId": row["strategy_id"],
            "symbol": row["symbol"],
            "timeframe": row["timeframe"],
            "created": row["created"],
            "params": json.loads(row["params"]),
            "result": json.loads(row["result"]),
        }

    # ---------------------------------------------------------- paper book
    def next_ticket(self) -> int:
        raw = self.get_kv("ticket_seq") or "100000"
        nxt = int(float(raw)) + 1
        self.set_kv("ticket_seq", str(nxt))
        return nxt

    def insert_paper_order(self, order: dict) -> None:
        self._exec(
            "INSERT INTO paper_orders (ticket, symbol, side, volume, type, price, sl, tp, comment, strategy_id, created)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                order["ticket"], order["symbol"], order["side"], order["volume"],
                order["type"], order["price"], order.get("sl"), order.get("tp"),
                order.get("comment", ""), order.get("strategyId"), _now(),
            ),
        )

    def delete_paper_order(self, ticket: int) -> None:
        self._exec("DELETE FROM paper_orders WHERE ticket=?", (ticket,))

    def list_paper_orders(self) -> list[dict]:
        return [
            {
                "ticket": r["ticket"], "symbol": r["symbol"], "side": r["side"],
                "volume": r["volume"], "type": r["type"], "price": r["price"],
                "sl": r["sl"], "tp": r["tp"], "comment": r["comment"],
                "strategyId": r["strategy_id"], "created": r["created"],
            }
            for r in self._rows("SELECT * FROM paper_orders ORDER BY ticket")
        ]

    def insert_paper_position(self, pos: dict) -> None:
        self._exec(
            "INSERT INTO paper_positions (ticket, symbol, side, volume, open_price, sl, tp, magic, comment, strategy_id, opened)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                pos["ticket"], pos["symbol"], pos["side"], pos["volume"], pos["open_price"],
                pos.get("sl"), pos.get("tp"), pos.get("magic", 0), pos.get("comment", ""),
                pos.get("strategyId"), _now(),
            ),
        )

    def update_paper_position(self, ticket: int, **fields: Any) -> None:
        if not fields:
            return
        columns = ", ".join(f"{key}=?" for key in fields)
        self._exec(
            f"UPDATE paper_positions SET {columns} WHERE ticket=?",
            (*fields.values(), ticket),
        )

    def delete_paper_position(self, ticket: int) -> None:
        self._exec("DELETE FROM paper_positions WHERE ticket=?", (ticket,))

    def list_paper_positions(self) -> list[dict]:
        return [
            {
                "ticket": r["ticket"], "symbol": r["symbol"], "side": r["side"],
                "volume": r["volume"], "open_price": r["open_price"], "sl": r["sl"],
                "tp": r["tp"], "magic": r["magic"], "comment": r["comment"],
                "strategyId": r["strategy_id"], "opened": r["opened"],
            }
            for r in self._rows("SELECT * FROM paper_positions ORDER BY ticket")
        ]

    def insert_paper_deal(self, deal: dict) -> None:
        self._exec(
            "INSERT INTO paper_deals (ticket, symbol, side, volume, open_price, close_price, pnl,"
            " commission, magic, comment, strategy_id, opened, closed)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                deal["ticket"], deal["symbol"], deal["side"], deal["volume"],
                deal["open_price"], deal["close_price"], deal["pnl"],
                deal.get("commission", 0.0), deal.get("magic", 0),
                deal.get("comment", ""), deal.get("strategyId"), deal.get("opened"), _now(),
            ),
        )

    def list_paper_deals(self) -> list[dict]:
        return [
            {
                "ticket": r["ticket"], "symbol": r["symbol"], "side": r["side"],
                "volume": r["volume"], "openPrice": r["open_price"],
                "closePrice": r["close_price"], "pnl": r["pnl"],
                "commission": r["commission"], "magic": r["magic"],
                "comment": r["comment"], "strategyId": r["strategy_id"],
                "opened": r["opened"], "closed": r["closed"],
            }
            for r in self._rows("SELECT * FROM paper_deals ORDER BY id DESC")
        ]

    # ---------------------------------------------------------------- audit
    def audit(self, action: str, detail: dict | str, *, ok: bool = True, actor: str = "bridge") -> None:
        text = detail if isinstance(detail, str) else json.dumps(detail, default=str)
        self._exec(
            "INSERT INTO audit (ts, actor, action, ok, detail) VALUES (?,?,?,?,?)",
            (_now(), actor, action, int(ok), text[:4000]),
        )

    def list_audit(self, limit: int = 100) -> list[dict]:
        return [
            {
                "id": r["id"], "ts": r["ts"], "actor": r["actor"],
                "action": r["action"], "ok": bool(r["ok"]), "detail": r["detail"],
            }
            for r in self._rows("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))
        ]

    # ------------------------------------------------------------------- kv
    def get_kv(self, key: str) -> str | None:
        row = self._row("SELECT value FROM kv WHERE key=?", (key,))
        return row["value"] if row else None

    def set_kv(self, key: str, value: str) -> None:
        self._exec(
            "INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def get_json(self, key: str) -> Any | None:
        raw = self.get_kv(key)
        return json.loads(raw) if raw else None

    def set_json(self, key: str, value: Any) -> None:
        self.set_kv(key, json.dumps(value))

    # ---------------------------------------------------------- idempotency
    def get_idempotent(self, key: str) -> dict | None:
        row = self._row("SELECT * FROM idempotency WHERE key=?", (key,))
        return json.loads(row["response"]) if row else None

    def set_idempotent(self, key: str, response: dict) -> None:
        self._exec(
            "INSERT OR REPLACE INTO idempotency (key, response, ts) VALUES (?,?,?)",
            (key, json.dumps(response), _now()),
        )


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _decode_strategy(row: dict) -> dict:
    manifest = json.loads(row["manifest"])
    manifest["enabled"] = bool(row["enabled"])
    manifest["autoExecute"] = bool(row["auto_execute"])
    manifest["source"] = row["source"]
    manifest["createdAt"] = row["created"]
    manifest["updatedAt"] = row["updated"]
    return manifest


def _decode_signal(row: dict) -> dict:
    payload = json.loads(row["payload"])
    payload["id"] = row["id"]
    payload["cloudId"] = row["cloud_id"]
    payload["status"] = row["status"]
    payload["decided"] = row["decided"]
    payload["note"] = row["note"] or payload.get("note", "")
    payload["ticket"] = row["ticket"]
    return payload

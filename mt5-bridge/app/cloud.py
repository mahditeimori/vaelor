"""Sync with the Vaelor Worker: AI-authored strategies, signal queue, results.

The bridge is the execution authority; the cloud is the collaboration layer.
Cloud strategies always arrive disabled and require an explicit local switch-on,
so an AI cannot start trading by publishing a manifest.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .config import SETTINGS
from .models import StrategyManifest
from .store import Store
from .strategies import StrategyError, validate_strategy


class CloudSync:
    def __init__(self, store: Store, engine: Any) -> None:
        self.store = store
        self.engine = engine
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ http
    def _request(self, method: str, path: str, payload: dict | None = None) -> Any:
        url = f"{SETTINGS.cloud_url}{path}"
        data = None
        headers = {"accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=12) as res:
            raw = res.read().decode("utf-8")
        return json.loads(raw) if raw else None

    # ----------------------------------------------------------------- state
    def status(self) -> dict:
        return self.store.get_json("cloud_status") or {
            "enabled": SETTINGS.cloud_sync,
            "url": SETTINGS.cloud_url,
            "lastSync": None,
            "lastError": None,
            "strategies": 0,
            "signals": 0,
            "ok": False,
        }

    def _save(self, status: dict) -> None:
        self.store.set_json("cloud_status", status)

    # ------------------------------------------------------------------ sync
    def sync_once(self) -> dict:
        status = {
            "enabled": SETTINGS.cloud_sync,
            "url": SETTINGS.cloud_url,
            "lastSync": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "lastError": None,
            "strategies": 0,
            "signals": 0,
            "ok": False,
        }
        if not SETTINGS.cloud_sync:
            self._save(status)
            return status

        try:
            registry = self._request("GET", "/api/strategies") or {}
            manifests = registry.get("strategies") or []
            imported = 0
            for raw in manifests:
                try:
                    manifest = StrategyManifest(**raw)
                    validate_strategy(manifest)
                except Exception as exc:
                    self.store.audit(
                        "cloud.strategy_rejected",
                        {"id": raw.get("id"), "error": str(exc)},
                        ok=False,
                    )
                    continue
                if raw.get("retired"):
                    existing = self.store.get_strategy(manifest.id)
                    if existing:
                        self.store.set_strategy_enabled(manifest.id, False, False)
                    self.store.audit("cloud.strategy_retired", {"id": manifest.id})
                    continue
                self.store.upsert_strategy(manifest.model_dump(), source="cloud")
                imported += 1
            status["strategies"] = imported

            signals = self._request("GET", "/api/signals?status=pending") or {}
            fresh = 0
            for raw in signals.get("signals") or []:
                sid = raw.get("id")
                if not sid:
                    continue
                try:
                    self.store.add_signal(
                        {
                            "id": sid,
                            "strategyId": raw.get("strategyId"),
                            "symbol": raw.get("symbol"),
                            "side": raw.get("side"),
                            "entry": raw.get("entry"),
                            "sl": raw.get("sl"),
                            "tp": raw.get("tp"),
                            "confidence": raw.get("confidence"),
                            "note": raw.get("note", ""),
                            "createdAt": raw.get("createdAt"),
                        },
                        cloud_id=sid,
                    )
                    fresh += 1
                except Exception as exc:
                    self.store.audit("cloud.signal_rejected", {"id": sid, "error": str(exc)}, ok=False)
            status["signals"] = fresh

            # Close the loop: tell the cloud what the desk decided.
            pushed = 0
            for signal in self.store.list_signals(None, 300):
                if signal["status"] not in {"executed", "rejected", "cancelled"}:
                    continue
                cloud_id = signal.get("cloudId")
                if not cloud_id:
                    continue
                marker = f"signal_push:{signal['id']}:{signal['status']}"
                if self.store.get_kv(marker):
                    continue
                try:
                    self._request(
                        "POST",
                        f"/api/signals/{cloud_id}/status",
                        {
                            "status": signal["status"],
                            "note": signal.get("note") or "",
                            "ticket": signal.get("ticket"),
                            "actor": "mt5-bridge",
                        },
                    )
                    self.store.set_kv(marker, "1")
                    pushed += 1
                except Exception:
                    break
            status["decisions"] = pushed

            # Push measured performance back so the site/MCP see success rates.
            performance = self.engine.performance()
            payload = {
                "generatedAt": performance["generatedAt"],
                "mode": performance["mode"],
                "strategies": [
                    {
                        "id": row["id"],
                        "successRate": row["successRate"],
                        "profitFactor": row["profitFactor"],
                        "score": row["score"],
                        "trades": row["sample"],
                        "confidence": row["confidence"],
                        "evidence": row["evidence"],
                        "expectancyR": row.get("expectancyR"),
                        "maxDrawdownPct": row.get("maxDrawdownPct"),
                    }
                    for row in performance["strategies"]
                ],
                "overall": performance["overall"],
            }
            self._request("POST", "/api/performance", payload)
            status["ok"] = True
        except Exception as exc:
            status["lastError"] = str(exc)
            self.store.audit("cloud.sync_failed", str(exc), ok=False)

        self._save(status)
        return status

    # --------------------------------------------------------------- runner
    def start(self) -> None:
        if not SETTINGS.cloud_sync:
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="cloud-sync", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _loop(self) -> None:
        # Give the engine a moment to settle, then sync on the configured cadence.
        self._stop.wait(3)
        while not self._stop.is_set():
            try:
                self.sync_once()
            except Exception:
                pass
            self._stop.wait(max(15, SETTINGS.cloud_interval))

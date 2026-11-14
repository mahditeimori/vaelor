"""Bridge configuration.

Everything is env-driven so the same bridge can run in three modes:

  simulation  – virtual broker, no MT5 terminal required (default fallback)
  live        – real MetaTrader 5 terminal, real orders (requires ALLOW_LIVE=1)
  auto        – try MT5, fall back to simulation and say why

The bridge always binds to loopback only. The token is generated on first run
and written to `data/bridge-token` so the browser can pair with it.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

BRIDGE_ROOT = Path(__file__).resolve().parent.parent

try:  # optional, but installed with uvicorn[standard]
    from dotenv import load_dotenv

    load_dotenv(BRIDGE_ROOT / ".env")
except Exception:  # pragma: no cover
    pass

DATA_DIR = Path(os.environ.get("BRIDGE_DATA_DIR", BRIDGE_ROOT / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

VERSION = "1.1.0"


def _bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _token() -> str:
    env = os.environ.get("BRIDGE_TOKEN")
    if env:
        return env.strip()
    token_file = DATA_DIR / "bridge-token"
    if token_file.exists():
        value = token_file.read_text(encoding="utf-8").strip()
        if value:
            return value
    value = secrets.token_urlsafe(24)
    token_file.write_text(value, encoding="utf-8")
    return value


@dataclass(frozen=True)
class Settings:
    host: str = os.environ.get("BRIDGE_HOST", "127.0.0.1")
    port: int = int(os.environ.get("BRIDGE_PORT", "8899"))
    site_url: str = os.environ.get("VAELOR_SITE", "https://vaelor.pages.dev").rstrip("/")
    token: str = field(default_factory=_token)

    # auto | simulation | live
    mode: str = os.environ.get("BRIDGE_MODE", "auto").strip().lower()
    allow_live_trades: bool = _bool("ALLOW_LIVE_TRADES", False)

    mt5_terminal: str = os.environ.get(
        "MT5_TERMINAL_PATH", r"C:\Program Files\MetaTrader 5\terminal64.exe"
    )
    mt5_login: int | None = int(os.environ["MT5_LOGIN"]) if os.environ.get("MT5_LOGIN") else None
    mt5_password: str | None = os.environ.get("MT5_PASSWORD")
    mt5_server: str | None = os.environ.get("MT5_SERVER")

    db_path: Path = Path(os.environ.get("BRIDGE_DB", DATA_DIR / "bridge.db"))

    # Cloud registry (the Vaelor Worker). Used to pull AI-authored strategies
    # and signals, and to push measured performance back to the site.
    cloud_url: str = os.environ.get(
        "VAELOR_API", "https://trading-llc-mcp.mahdi-t8256.workers.dev"
    ).rstrip("/")
    cloud_sync: bool = _bool("CLOUD_SYNC", True)
    cloud_interval: int = int(os.environ.get("CLOUD_SYNC_SECONDS", "60"))

    sim_balance: float = float(os.environ.get("SIM_BALANCE", "100000"))
    sim_leverage: int = int(os.environ.get("SIM_LEVERAGE", "100"))
    sim_data: str = os.environ.get("SIM_DATA", "auto").strip().lower()  # auto|cloud|synthetic

    allowed_origins: tuple[str, ...] = (
        "http://localhost:4321",
        "http://127.0.0.1:4321",
        "http://localhost:4319",
        "http://127.0.0.1:4319",
        "https://vaelor.pages.dev",
    )


SETTINGS = Settings()

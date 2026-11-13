"""MetaTrader 5 discovery and connection control.

The bridge must work on any machine, not just the one it was written on. This
module finds every MetaTrader 5 terminal installed for the current Windows
user, reports whether it is running and which account it is logged into, and
connects the trading engine to the one the user picks.

Credentials are used for a single ``mt5.initialize`` call and kept in memory
only. Nothing secret is written to SQLite, the audit log or the cloud.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

try:  # Windows-only, like the MetaTrader5 package itself.
    import MetaTrader5 as mt5  # type: ignore
except Exception:  # pragma: no cover - importable on non-Windows for tests
    mt5 = None

TERMINAL_EXE = "terminal64.exe"

# Install locations worth scanning even when no profile has been created yet.
COMMON_ROOTS = [
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs"),
    os.path.expandvars(r"%PROGRAMFILES%"),
]

# Broker-supplied folder names are noisy on purpose; keep them visible so the
# user can recognise their own terminal.
INSTALL_HINT = re.compile(r"(meta\s*trader|mt5|terminal)", re.IGNORECASE)


# --------------------------------------------------------------------------
# Running processes (no third-party dependency)
# --------------------------------------------------------------------------

def _running_terminal_paths() -> list[str]:
    """Full paths of every running terminal64.exe, via the Win32 API."""
    if os.name != "nt":
        return []
    try:
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        psapi.EnumProcesses.restype = wintypes.BOOL

        count = 4096
        pid_array = (wintypes.DWORD * count)()
        needed = wintypes.DWORD()
        if not psapi.EnumProcesses(pid_array, ctypes.sizeof(pid_array), ctypes.byref(needed)):
            return []
        total = needed.value // ctypes.sizeof(wintypes.DWORD)

        found: list[str] = []
        for i in range(min(total, count)):
            pid = pid_array[i]
            if not pid:
                continue
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                continue
            try:
                size = wintypes.DWORD(32768)
                buf = ctypes.create_unicode_buffer(size.value)
                if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                    path = buf.value
                    if path.lower().endswith(TERMINAL_EXE):
                        found.append(path)
            finally:
                kernel32.CloseHandle(handle)
        return found
    except Exception:  # pragma: no cover - defensive
        return []


# --------------------------------------------------------------------------
# Install discovery
# --------------------------------------------------------------------------

def _profile_dirs() -> list[Path]:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return []
    root = Path(appdata) / "MetaQuotes" / "Terminal"
    if not root.exists():
        return []
    return [p for p in root.iterdir() if p.is_dir()]


def _origin(profile: Path) -> str | None:
    origin = profile / "origin.txt"
    if not origin.exists():
        return None
    try:
        text = origin.read_text(encoding="utf-16", errors="ignore").strip("\ufeff").strip()
        return text or None
    except Exception:
        return None


def _scan_roots() -> list[Path]:
    seen: set[str] = set()
    out: list[Path] = []
    for root in COMMON_ROOTS:
        base = Path(root)
        if not base.exists():
            continue
        try:
            entries = list(base.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.is_dir():
                continue
            exe = entry / TERMINAL_EXE
            if exe.exists() and str(exe).lower() not in seen:
                seen.add(str(exe).lower())
                out.append(entry)
    return out


def discover_terminals() -> list[dict[str, Any]]:
    """Every MT5 terminal we can see, newest-used first.

    Values come from three independent sources so a freshly installed terminal
    without a profile still shows up, and a portable copy is not hidden.
    """
    running = {p.lower() for p in _running_terminal_paths()}
    terminals: dict[str, dict[str, Any]] = {}

    def add(install: Path, profile: Path | None = None, portable: bool = False) -> None:
        exe = (install / TERMINAL_EXE) if install.is_dir() else install
        key = str(exe).lower()
        if key in terminals:
            if profile and not terminals[key].get("dataDir"):
                terminals[key]["dataDir"] = str(profile)
            if any(p.lower() == key for p in running):
                terminals[key]["running"] = True
            return
        last_used = 0.0
        if profile:
            try:
                last_used = profile.stat().st_mtime
            except OSError:
                pass
        if exe.exists():
            try:
                last_used = max(last_used, exe.stat().st_mtime)
            except OSError:
                pass
        terminals[key] = {
            "path": str(exe),
            "installDir": str(install if install.is_dir() else install.parent),
            "name": install.name if install.is_dir() else install.parent.name,
            "dataDir": str(profile) if profile else None,
            "portable": portable,
            "running": any(p.lower() == key for p in running),
            "lastUsed": int(last_used) if last_used else None,
            "installed": exe.exists(),
        }

    # 1. Profiles: the authoritative origin of every terminal that has run.
    for profile in _profile_dirs():
        origin = _origin(profile)
        if not origin:
            continue
        install = Path(origin)
        if not install.exists():
            continue
        exe = install / TERMINAL_EXE
        if not exe.exists():
            continue
        portable = str(profile).lower().startswith(str(install).lower())
        add(install, profile, portable)

    # 2. Running processes, including portable copies with no profile.
    for raw in _running_terminal_paths():
        exe = Path(raw)
        if exe.exists():
            add(exe.parent)

    # 3. Install roots, so a never-launched terminal is still listed.
    for install in _scan_roots():
        add(install)

    items = list(terminals.values())
    items.sort(key=lambda t: (not t["running"], -(t["lastUsed"] or 0), t["name"].lower()))
    return items


def installed_terminals_hint() -> str | None:
    """A ready-to-paste MT5_TERMINAL_PATH for the most recently used terminal."""
    items = discover_terminals()
    for item in items:
        if item.get("running") and item.get("installed"):
            return item["path"]
    for item in items:
        if item.get("installed"):
            return item["path"]
    return None


# --------------------------------------------------------------------------
# Probing and connecting
# --------------------------------------------------------------------------

class MT5Unavailable(RuntimeError):
    """MT5 cannot be used on this machine."""


# Human explanations for the retcodes brokers and the terminal produce most.
RETCODES: dict[int, str] = {
    10004: "Requote — the price moved before the broker filled the order.",
    10006: "Request rejected by the broker.",
    10007: "Request cancelled by the trader.",
    10008: "Order state changed while it was being processed.",
    10009: "Done.",
    10010: "Only part of the request was completed.",
    10011: "Request processing error.",
    10012: "Request timed out.",
    10013: "Invalid request — check symbol, volume and price.",
    10014: "Invalid volume for this symbol (min/max/step).",
    10015: "Invalid price for this symbol.",
    10016: "Invalid stops — stop loss or take profit is too close to the price.",
    10017: "Trading is disabled for this account.",
    10018: "The market is closed.",
    10019: "Not enough money to place this order.",
    10020: "Prices are not available right now.",
    10021: "No quotes to process the request.",
    10022: "Invalid order expiration.",
    10023: "Order state changed.",
    10024: "Too many requests — the broker is throttling.",
    10025: "No changes in the request.",
    10026: "Autotrading is disabled by the server.",
    10027: "Autotrading is disabled in the terminal. Press the AutoTrading button and enable Tools > Options > Expert Advisors > Allow algorithmic trading.",
    10028: "The terminal is locked, close it and try again.",
    10029: "The order or position is frozen.",
    10030: "Unsupported filling mode for this symbol.",
    10031: "No connection to the trade server.",
    10033: "Pending order limit reached.",
    10034: "Volume limit for this symbol reached.",
    10036: "The position is already closed.",
    10038: "Close-by is forbidden for this symbol.",
    10039: "A close-by position already exists.",
}


def explain(retcode: int | None) -> str | None:
    if retcode is None:
        return None
    return RETCODES.get(int(retcode))


def _shutdown() -> None:
    if mt5 is not None:
        try:
            mt5.shutdown()
        except Exception:
            pass


def _initialize(
    path: str | None,
    *,
    login: int | None = None,
    password: str | None = None,
    server: str | None = None,
    portable: bool = False,
    timeout_ms: int = 90_000,
) -> tuple[bool, dict[str, Any]]:
    if mt5 is None:
        return False, {
            "ok": False,
            "error": "MetaTrader5 Python package is not installed",
            "hint": "Install it with: pip install MetaTrader5 (Windows only).",
            "retcode": None,
        }
    kwargs: dict[str, Any] = {"timeout": timeout_ms, "portable": bool(portable)}
    if login:
        kwargs["login"] = int(login)
    if password:
        kwargs["password"] = password
    if server:
        kwargs["server"] = server
    target = path or installed_terminals_hint()
    try:
        ok = mt5.initialize(target, **kwargs) if target else mt5.initialize(**kwargs)
    except Exception as exc:  # pragma: no cover - rare ctypes failures
        return False, {"ok": False, "error": str(exc), "retcode": None, "hint": None}
    if not ok:
        code, message = mt5.last_error()
        hint = explain(code if isinstance(code, int) else None)
        if not hint:
            if code == -6 or "Authorization" in str(message):
                hint = (
                    "The terminal is installed but no account is logged in. Open "
                    "MetaTrader 5, sign in to your broker account (demo or live), "
                    "then connect again."
                )
            elif code == -2 or "Invalid params" in str(message):
                hint = "The terminal path or login details are invalid."
            elif code == -4:
                hint = "MetaTrader 5 rejected the connection; check the terminal is not blocked."
        return False, {
            "ok": False,
            "error": f"initialize failed ({code}): {message}",
            "retcode": code if isinstance(code, int) else None,
            "hint": hint,
        }

    account = mt5.account_info()
    terminal = mt5.terminal_info()
    if account is None:
        _shutdown()
        return False, {
            "ok": False,
            "error": "the terminal started but no account is logged in",
            "retcode": None,
            "hint": (
                "Log in inside MetaTrader 5 (File > Login to Trade Account) and "
                "connect again. The bridge never stores your password."
            ),
        }
    return True, {
        "ok": True,
        "account": {
            "login": account.login,
            "server": account.server,
            "name": account.name,
            "company": getattr(account, "company", ""),
            "currency": account.currency,
            "balance": round(account.balance, 2),
            "equity": round(account.equity, 2),
            "leverage": account.leverage,
            "marginMode": getattr(account, "margin_mode", None),
            "tradeAllowed": bool(account.trade_allowed),
            "tradeExpert": bool(getattr(account, "trade_expert", False)),
            # ACCOUNT_TRADE_MODE_DEMO = 0, CONTEST = 1, REAL = 2
            "tradeMode": int(getattr(account, "trade_mode", 2)),
            "demo": int(getattr(account, "trade_mode", 2)) != 2,
        },
        "terminal": None
        if terminal is None
        else {
            "name": terminal.name,
            "company": terminal.company,
            "path": terminal.path,
            "dataPath": terminal.data_path,
            "build": terminal.build,
            "connected": bool(terminal.connected),
            "tradeAllowed": bool(terminal.trade_allowed),
            "communityAccount": bool(getattr(terminal, "community_account", False)),
            "maxBars": getattr(terminal, "maxbars", None),
        },
        "autotrading": bool(terminal.trade_allowed) if terminal else False,
        "hint": None
        if terminal is not None and terminal.trade_allowed
        else (
            "Connected, but AutoTrading is off in the terminal. Turn on the "
            "AutoTrading toolbar button and enable Tools > Options > Expert "
            "Advisors > Allow algorithmic trading before sending live orders."
        ),
    }


def probe(path: str, *, portable: bool = False, keep: bool = False) -> dict[str, Any]:
    """Connect just long enough to read the account, then release the API."""
    ok, info = _initialize(path, portable=portable)
    if not keep:
        _shutdown()
    info["path"] = path
    return info


class MT5Session:
    """One live link to a terminal, with reconnect and account-change guards."""

    def __init__(self) -> None:
        self.path: str | None = None
        self.login: int | None = None
        self.server: str | None = None
        self.portable = False
        self.password: str | None = None  # memory only, never persisted
        self.connected = False
        self.last_error: str | None = None
        self.last_attempt = 0.0
        self._retry_after = 0.0
        self._lock = threading.RLock()
        self.account_login: int | None = None
        self.account_changed = False
        self.info: dict[str, Any] = {}

    # ------------------------------------------------------------------ connect
    def connect(
        self,
        path: str | None,
        *,
        login: int | None = None,
        password: str | None = None,
        server: str | None = None,
        portable: bool = False,
    ) -> dict[str, Any]:
        with self._lock:
            _shutdown()
            ok, info = _initialize(
                path, login=login, password=password, server=server, portable=portable
            )
            self.path = path or (info.get("terminal") or {}).get("path")
            self.login = login
            self.server = server
            self.portable = portable
            self.password = password or None
            self.last_attempt = time.time()
            self.info = info
            if not ok:
                self.connected = False
                self.last_error = info.get("error")
                return info
            account = info["account"]
            if self.account_login is not None and account["login"] != self.account_login:
                self.account_changed = True
            self.account_login = account["login"]
            self.connected = True
            self.last_error = None
            self._retry_after = 0.0
            return info

    def disconnect(self) -> None:
        with self._lock:
            _shutdown()
            self.connected = False
            self.password = None

    # ------------------------------------------------------------------ health
    def check(self) -> bool:
        """Verify the link; reconnect at most every 10s if it dropped."""
        if mt5 is None:
            self.connected = False
            return False
        with self._lock:
            if self.connected:
                account = mt5.account_info()
                terminal = mt5.terminal_info()
                if account is not None and terminal is not None and terminal.connected:
                    if self.account_login is not None and account.login != self.account_login:
                        self.account_changed = True
                    return True
                self.connected = False
                self.last_error = "terminal connection lost"
            now = time.time()
            if now < self._retry_after or now - self.last_attempt < 5:
                return False
            self.last_attempt = now
            ok, info = _initialize(
                self.path,
                login=self.login,
                password=self.password,
                server=self.server,
                portable=self.portable,
                timeout_ms=15_000,
            )
            self.info = info
            if ok:
                self.connected = True
                self.last_error = None
                self._retry_after = 0.0
                account = info["account"]
                if self.account_login is not None and account["login"] != self.account_login:
                    self.account_changed = True
                self.account_login = account["login"]
                return True
            self.last_error = info.get("error")
            self._retry_after = now + min(60.0, 5.0 + (now - self.last_attempt))
            return False

    def status(self) -> dict[str, Any]:
        account = None
        terminal = None
        if self.connected and mt5 is not None:
            try:
                account = mt5.account_info()
                terminal = mt5.terminal_info()
            except Exception:
                account, terminal = None, None
        return {
            "connected": self.connected,
            "path": self.path,
            "login": self.account_login or self.login,
            "server": self.server,
            "accountChanged": self.account_changed,
            "lastError": self.last_error,
            "account": None
            if account is None
            else {
                "login": account.login,
                "server": account.server,
                "name": account.name,
                "company": getattr(account, "company", ""),
                "currency": account.currency,
                "balance": round(account.balance, 2),
                "equity": round(account.equity, 2),
                "leverage": account.leverage,
                "tradeAllowed": bool(account.trade_allowed),
                "tradeMode": int(getattr(account, "trade_mode", 2)),
                "demo": int(getattr(account, "trade_mode", 2)) != 2,
            },
            "terminal": None
            if terminal is None
            else {
                "name": terminal.name,
                "company": terminal.company,
                "path": terminal.path,
                "build": terminal.build,
                "connected": bool(terminal.connected),
                "tradeAllowed": bool(terminal.trade_allowed),
            },
        }


def package_info() -> dict[str, Any]:
    return {
        "installed": mt5 is not None,
        "version": getattr(mt5, "__version__", None) if mt5 else None,
        "platform": os.name,
        "terminals": len(discover_terminals()),
    }

"""FastAPI surface for the browser execution desk and the local MCP bridge."""

from __future__ import annotations

import hmac
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from .cloud import CloudSync
from .config import SETTINGS, VERSION
from .engine import RiskError, TradingEngine
from .models import (
    BacktestRequest,
    CloseRequest,
    KillRequest,
    ModeRequest,
    ModifyRequest,
    OrderRequest,
    RiskConfig,
    SignalDecision,
    SignalIn,
    StrategyManifest,
    TrailRequest,
)
from .mt5_provider import BrokerError
from .seed import seed
from .store import Store
from .strategies import validate_strategy, warmup_bars


class StrategyToggle(BaseModel):
    enabled: bool = True
    autoExecute: bool | None = None


class LiveToggle(BaseModel):
    """Website control for the live-trading interlock.

    Enabling needs the typed confirmation ``ENABLE LIVE``; disabling is
    always allowed and never closes positions.
    """

    enabled: bool = True
    confirm: str = ""


class StrategyRegistration(BaseModel):
    strategy: StrategyManifest


class SignalRegistration(BaseModel):
    signal: SignalIn


class MT5ConnectRequest(BaseModel):
    """Terminal selection and optional auto-login.

    ``password`` is forwarded to ``mt5.initialize`` for one call and never
    persisted — not in SQLite, not in the audit log, not in the cloud payload.
    """

    path: str | None = Field(default=None, max_length=512)
    login: int | None = Field(default=None, gt=0)
    password: str | None = Field(default=None, max_length=256)
    server: str | None = Field(default=None, max_length=128)
    portable: bool = False
    confirm: str = ""


class MT5ProbeRequest(BaseModel):
    path: str = Field(min_length=3, max_length=512)
    portable: bool = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    store = Store(SETTINGS.db_path)
    seed(store)
    engine = TradingEngine(store)
    cloud = CloudSync(store, engine)
    app.state.store = store
    app.state.engine = engine
    app.state.cloud = cloud
    engine.start()
    cloud.start()
    try:
        yield
    finally:
        cloud.stop()
        engine.stop()
        store.close()


app = FastAPI(title="Vaelor MT5 Bridge", version=VERSION, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=SETTINGS.allowed_origins,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=False,
    max_age=600,
)


@app.middleware("http")
async def private_network_access(request: Request, call_next):
    """Let an HTTPS page (the Vaelor site) reach this loopback bridge.

    Chrome's Private Network Access preflight asks for
    ``Access-Control-Request-Private-Network``; without the matching response
    header the browser blocks the request even though the server is local.
    """
    if request.method == "OPTIONS" and request.headers.get(
        "access-control-request-private-network"
    ):
        response = await call_next(request)
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def require_token(
    request: Request,
    x_bridge_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> None:
    supplied = x_bridge_token or token or ""
    if not hmac.compare_digest(supplied, SETTINGS.token):
        raise HTTPException(status_code=401, detail="invalid bridge token")


def engine_of(request: Request) -> TradingEngine:
    return request.app.state.engine


def _fail(exc: Exception) -> HTTPException:
    if isinstance(exc, (ValueError, RiskError)):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, BrokerError):
        detail = str(exc) if not exc.hint else f"{exc} — {exc.hint}"
        return HTTPException(
            status_code=409,
            detail={"error": detail, "retcode": exc.retcode, "hint": exc.hint},
        )
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=502, detail=str(exc))


# --------------------------------------------------------------------------
# Health & status
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Pairing page
# --------------------------------------------------------------------------

# Served by the bridge itself on loopback only. The page embeds the token so
# the browser can hand it to the site automatically; other websites cannot
# read it because CORS only allows the Vaelor site and localhost dev origins.
_PAIR_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vaelor MT5 bridge - Connect</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0a0d13; color: #e7e2df; font-family: Consolas, 'Courier New', monospace; }}
  .card {{ max-width: 560px; padding: 40px 36px; border: 1px solid #2a2230; border-radius: 14px;
           background: #120d11; text-align: center; }}
  h1 {{ font-size: 1.15rem; letter-spacing: 0.08em; margin: 0 0 6px; }}
  .ok {{ color: #7bd88f; font-size: 0.8rem; margin-bottom: 18px; }}
  a.btn {{ display: inline-block; margin: 6px 0 14px; padding: 13px 26px; border-radius: 10px;
           background: linear-gradient(135deg, #e2456c, #7c0f2e); color: #fff; font-weight: 700;
           text-decoration: none; letter-spacing: 0.04em; }}
  a.btn:hover {{ filter: brightness(1.12); }}
  pre {{ text-align: left; background: #080506; border: 1px solid #2a2230; border-radius: 8px;
         padding: 12px 14px; font-size: 0.8rem; color: #c9a24b; overflow-x: auto; }}
  p {{ font-size: 0.78rem; color: #8f8a90; line-height: 1.6; }}
  .note {{ margin-top: 14px; font-size: 0.7rem; color: #5c5052; }}
</style>
</head>
<body>
<div class="card">
  <h1>VAELOR MT5 BRIDGE IS RUNNING</h1>
  <div class="ok">Connected and ready on this computer.</div>
  <a class="btn" id="auto" href="{target}">Connect the website automatically</a>
  <p>Redirecting in <span id="count">3</span> seconds… <a href="#" id="cancel" style="color:#c9a24b">cancel</a></p>
  <p>Manual fallback — paste these two lines into the Execution page:</p>
  <pre>URL   : http://127.0.0.1:{port}
Token : {token}</pre>
  <div class="note">This page is served by the bridge on your own machine.
  Nothing is sent to the internet except the connection details you paste.</div>
</div>
<script>
  var timer = setTimeout(function () {{ location.replace(document.getElementById('auto').href); }}, 3000);
  document.getElementById('cancel').addEventListener('click', function (e) {{
    e.preventDefault(); clearTimeout(timer);
    document.getElementById('count').textContent = '0';
  }});
  var n = 3;
  setInterval(function () {{ if (n > 0) document.getElementById('count').textContent = String(--n); }}, 1000);
</script>
</body>
</html>"""


@app.get("/pair", response_class=HTMLResponse)
def pair_page() -> str:
    """One-click pairing page: redirects to the site with the token in the
    URL fragment (fragments are never sent to any server)."""
    import base64
    import json as _json

    payload = base64.b64encode(
        _json.dumps({"url": f"http://127.0.0.1:{SETTINGS.port}", "token": SETTINGS.token}).encode()
    ).decode()
    target = f"{SETTINGS.site_url}/execution#connect={payload}"
    return _PAIR_TEMPLATE.format(target=target, port=SETTINGS.port, token=SETTINGS.token)


@app.get("/health")
def health(request: Request) -> dict:
    engine = engine_of(request)
    return {
        "ok": True,
        "service": "vaelor-mt5-bridge",
        "version": VERSION,
        "mode": engine.provider.mode,
        "provider": engine.provider.name,
        "connected": engine.provider.connected,
        "tokenRequired": True,
    }


@app.get("/api/status", dependencies=[Depends(require_token)])
def status(request: Request) -> dict:
    return engine_of(request).status()


@app.get("/api/config", dependencies=[Depends(require_token)])
def config(request: Request) -> dict:
    engine = engine_of(request)
    return {
        "mode": engine.provider.mode,
        "provider": engine.provider.name,
        "host": SETTINGS.host,
        "port": SETTINGS.port,
        "cloudUrl": SETTINGS.cloud_url,
        "cloudSync": SETTINGS.cloud_sync,
        "allowLiveTrades": SETTINGS.allow_live_trades,
        "version": VERSION,
    }


@app.get("/api/symbols", dependencies=[Depends(require_token)])
def symbols(request: Request) -> dict:
    return {"symbols": engine_of(request).symbols()}


@app.get("/api/quote", dependencies=[Depends(require_token)])
def quote(request: Request, symbol: str = Query(min_length=2)) -> dict:
    try:
        return engine_of(request).quote(symbol)
    except Exception as exc:
        raise _fail(exc) from exc


# --------------------------------------------------------------------------
# MetaTrader 5 connection
# --------------------------------------------------------------------------

@app.get("/api/mt5/diagnostics", dependencies=[Depends(require_token)])
def mt5_diagnostics(request: Request) -> dict:
    return engine_of(request).mt5_diagnostics()


@app.post("/api/mt5/connect", dependencies=[Depends(require_token)])
def mt5_connect(request: Request, payload: MT5ConnectRequest) -> dict:
    try:
        return engine_of(request).connect_mt5(
            path=payload.path,
            login=payload.login,
            password=payload.password,
            server=payload.server,
            portable=payload.portable,
        )
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/mt5/probe", dependencies=[Depends(require_token)])
def mt5_probe(request: Request, payload: MT5ProbeRequest) -> dict:
    from .mt5ctl import probe

    return probe(payload.path, portable=payload.portable)


@app.post("/api/mt5/disconnect", dependencies=[Depends(require_token)])
def mt5_disconnect(request: Request) -> dict:
    try:
        return engine_of(request).disconnect_mt5()
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/mt5/reconnect", dependencies=[Depends(require_token)])
def mt5_reconnect(request: Request) -> dict:
    try:
        return engine_of(request).reconnect_mt5()
    except Exception as exc:
        raise _fail(exc) from exc


# --------------------------------------------------------------------------
# Book
# --------------------------------------------------------------------------

@app.get("/api/positions", dependencies=[Depends(require_token)])
def positions(request: Request) -> dict:
    engine = engine_of(request)
    try:
        return {"positions": engine.provider.positions(), "orders": engine.provider.orders()}
    except Exception as exc:
        raise _fail(exc) from exc


@app.get("/api/history", dependencies=[Depends(require_token)])
def history(request: Request, days: int = Query(default=30, ge=1, le=365)) -> dict:
    engine = engine_of(request)
    try:
        return {"trades": engine.provider.history(days), "days": days}
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/orders", dependencies=[Depends(require_token)])
def place_order(request: Request, payload: OrderRequest) -> dict:
    try:
        return engine_of(request).place_order(payload)
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/positions/close-all", dependencies=[Depends(require_token)])
def close_all(request: Request, payload: dict | None = None) -> dict:
    strategy_id = (payload or {}).get("strategyId")
    try:
        return engine_of(request).close_all(strategy_id)
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/positions/{ticket}/modify", dependencies=[Depends(require_token)])
def modify(request: Request, ticket: int, payload: ModifyRequest) -> dict:
    try:
        return engine_of(request).modify_position(ticket, payload)
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/positions/{ticket}/close", dependencies=[Depends(require_token)])
def close(request: Request, ticket: int, payload: CloseRequest | None = None) -> dict:
    try:
        volume = payload.volume if payload else None
        return engine_of(request).close_position(ticket, volume=volume)
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/positions/{ticket}/breakeven", dependencies=[Depends(require_token)])
def breakeven(request: Request, ticket: int) -> dict:
    try:
        return engine_of(request).breakeven(ticket)
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/positions/{ticket}/trail", dependencies=[Depends(require_token)])
def trail(request: Request, ticket: int, payload: TrailRequest) -> dict:
    try:
        return engine_of(request).trail(ticket, payload.distancePips)
    except Exception as exc:
        raise _fail(exc) from exc


# --------------------------------------------------------------------------
# Risk & safety
# --------------------------------------------------------------------------

@app.get("/api/risk", dependencies=[Depends(require_token)])
def get_risk(request: Request) -> dict:
    return engine_of(request).get_risk()


@app.put("/api/risk", dependencies=[Depends(require_token)])
def set_risk(request: Request, payload: RiskConfig) -> dict:
    try:
        return engine_of(request).set_risk(payload)
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/kill", dependencies=[Depends(require_token)])
def kill(request: Request, payload: KillRequest) -> dict:
    try:
        return engine_of(request).kill(payload)
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/live", dependencies=[Depends(require_token)])
def live_interlock(request: Request, payload: LiveToggle) -> dict:
    """Unlock or re-lock live order routing without editing .env or restarting."""
    if payload.enabled and payload.confirm != "ENABLE LIVE":
        raise HTTPException(
            status_code=400,
            detail='unlocking live trading requires the typed confirmation "ENABLE LIVE"',
        )
    try:
        return engine_of(request).set_live_allowed(payload.enabled)
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/mode", dependencies=[Depends(require_token)])
def set_mode(request: Request, payload: ModeRequest) -> dict:
    try:
        return engine_of(request).set_mode(payload)
    except Exception as exc:
        raise _fail(exc) from exc


# --------------------------------------------------------------------------
# Strategies, signals, performance, backtests
# --------------------------------------------------------------------------

@app.get("/api/strategies", dependencies=[Depends(require_token)])
def list_strategies(request: Request) -> dict:
    return {"strategies": engine_of(request).list_strategies()}


@app.post("/api/strategies", dependencies=[Depends(require_token)])
def register_strategy(request: Request, payload: StrategyRegistration) -> dict:
    try:
        saved = engine_of(request).sync_strategy(payload.strategy)
        return {"ok": True, "strategy": saved}
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/strategies/validate", dependencies=[Depends(require_token)])
def validate_strategy_manifest(request: Request, payload: StrategyRegistration) -> dict:
    """Validate a manifest without registering it (used by the strategy editor)."""
    try:
        manifest = validate_strategy(payload.strategy)
        return {"ok": True, "id": manifest.id, "warmupBars": warmup_bars(manifest)}
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/strategies/sync", dependencies=[Depends(require_token)])
def sync_strategies(request: Request) -> dict:
    return {"ok": True, "cloud": request.app.state.cloud.sync_once()}


@app.post("/api/strategies/{sid}/toggle", dependencies=[Depends(require_token)])
def toggle_strategy(request: Request, sid: str, payload: StrategyToggle) -> dict:
    try:
        return {"ok": True, "strategy": engine_of(request).set_strategy_enabled(sid, payload.enabled, payload.autoExecute)}
    except Exception as exc:
        raise _fail(exc) from exc


@app.get("/api/signals", dependencies=[Depends(require_token)])
def list_signals(request: Request, status: str | None = None) -> dict:
    return {"signals": engine_of(request).list_signals(status)}


@app.post("/api/signals", dependencies=[Depends(require_token)])
def add_signal(request: Request, payload: SignalRegistration) -> dict:
    try:
        return {"ok": True, "signal": engine_of(request).add_signal(payload.signal)}
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/signals/{sid}/approve", dependencies=[Depends(require_token)])
def approve_signal(request: Request, sid: str, payload: SignalDecision | None = None) -> dict:
    try:
        decision = payload or SignalDecision()
        return engine_of(request).approve_signal(sid, decision.volume, decision.note)
    except Exception as exc:
        raise _fail(exc) from exc


@app.post("/api/signals/{sid}/reject", dependencies=[Depends(require_token)])
def reject_signal(request: Request, sid: str, payload: SignalDecision | None = None) -> dict:
    try:
        decision = payload or SignalDecision()
        return engine_of(request).reject_signal(sid, decision.note)
    except Exception as exc:
        raise _fail(exc) from exc


@app.get("/api/performance", dependencies=[Depends(require_token)])
def performance(request: Request) -> dict:
    return engine_of(request).performance()


@app.post("/api/backtest", dependencies=[Depends(require_token)])
def backtest(request: Request, payload: BacktestRequest) -> dict:
    try:
        return engine_of(request).backtest(payload)
    except Exception as exc:
        raise _fail(exc) from exc


@app.get("/api/backtests", dependencies=[Depends(require_token)])
def list_backtests(request: Request) -> dict:
    return {"backtests": engine_of(request).list_backtests()}


@app.get("/api/backtests/{bid}", dependencies=[Depends(require_token)])
def get_backtest(request: Request, bid: str) -> dict:
    try:
        return engine_of(request).get_backtest(bid)
    except Exception as exc:
        raise _fail(exc) from exc


@app.get("/api/cloud/status", dependencies=[Depends(require_token)])
def cloud_status(request: Request) -> dict:
    return request.app.state.cloud.status()


@app.post("/api/cloud/sync", dependencies=[Depends(require_token)])
def cloud_sync(request: Request) -> dict:
    return {"ok": True, "cloud": request.app.state.cloud.sync_once()}


@app.get("/api/audit", dependencies=[Depends(require_token)])
def audit(request: Request, limit: int = Query(default=100, ge=1, le=500)) -> dict:
    return {"entries": request.app.state.store.list_audit(limit)}


@app.get("/api/snapshot", dependencies=[Depends(require_token)])
def snapshot(request: Request) -> dict:
    engine = engine_of(request)
    quotes: dict[str, Any] = {}
    try:
        for pos in engine.provider.positions():
            if pos["symbol"] not in quotes:
                quotes[pos["symbol"]] = engine.provider.quote(pos["symbol"])
    except Exception:
        pass
    return {
        "status": engine.status(),
        "positions": engine.provider.positions(),
        "orders": engine.provider.orders(),
        "quotes": quotes,
        "performance": engine.performance(),
        "signals": engine.list_signals(),
        "audit": request.app.state.store.list_audit(60),
        "serverTime": __import__("time").time(),
    }

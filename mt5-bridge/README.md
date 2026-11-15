# Vaelor MT5 Bridge

Local execution and backtesting service for the Vaelor site. It binds to
`127.0.0.1` only, talks to a MetaTrader 5 terminal through the official Python
package, and falls back to a fully featured simulation broker when MT5 is not
available. The browser desk (`/execution`) talks to this service; AI agents
publish strategies and signals through the Vaelor MCP server, and the bridge
syncs them every minute.

```
browser /execution ──HTTP──▶ 127.0.0.1:8899 ──▶ MetaTrader 5 terminal
                                    │
                                    └────────▶ SQLite (strategies, signals,
                                                paper book, backtests, audit)

Vaelor Worker (MCP + REST) ──▶ /api/strategies, /api/signals, /api/performance
        ▲                                    │
        └────────── AI-authored strategies ──┘
```

## Quick start

```powershell
cd mt5-bridge
.\run.ps1
```

The first run creates `.venv`, installs dependencies, copies `.env.example` to
`.env`, and prints the pairing token. Open the site's **Execution** page, paste
the bridge URL (`http://127.0.0.1:8899`) and the token, then press **Connect**.

Manual equivalent:

```powershell
uv venv .venv --python 3.11
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
copy .env.example .env
.\.venv\Scripts\python.exe -c "from app.config import SETTINGS; print(SETTINGS.token)"
.\.venv\Scripts\python.exe -m uvicorn app.api:app --host 127.0.0.1 --port 8899
```

## Background service (no console window)

The console window is only a launcher — the trading engine runs inside the
bridge process. To run without a window, install the service once:

```powershell
cd mt5-bridge
powershell -ExecutionPolicy Bypass -File .\install-service.ps1
```

This registers the Windows scheduled task **Vaelor MT5 Bridge**, which:

- starts the bridge hidden at every logon and checks it every minute,
- restarts it if the process ever dies (and on failure),
- never starts a second instance while one is running,
- keeps MetaTrader 5 attached: **if you close terminal64.exe the bridge
  relaunches it and logs the account back in** (`MT5_AUTO_CONNECT=1`),
- logs everything to `mt5-bridge\logs\bridge.log`.

After that you can close the console, close the website and even close
MetaTrader — the desk keeps running. Your open positions live at the broker,
so they stay managed regardless; the bridge only needs to be alive to place
new orders, move stops and run the auto-execution scan.

Manage it with:

```powershell
.\service-run.ps1 -Status          # running? pid, log, task state
.\service-run.ps1                  # start hidden (idempotent)
.\service-run.ps1 -Stop            # stop the bridge
.\install-service.ps1 -Uninstall   # remove the scheduled task
```

An explicit **Disconnect** on the Execution page is respected: supervision
stays off until you press **Connect** again. Set `MT5_AUTO_CONNECT=0` in
`.env` to disable supervised re-attach entirely. The bridge still binds to
`127.0.0.1` only - the website reaches it through the browser on the same
machine, so no port is ever exposed to the internet.

## Cloud-hosted bridge (Windows VPS)

Instead of running the bridge on your own machine, you can run it on a cloud
Windows VPS that has MetaTrader 5 installed and your account logged in. The
robot keeps trading there 24/7 while your local PC stays closed and asleep -
no shell, no pop-ups, no "keep the system awake" problem.

```powershell
# on the VPS (Windows Server / Windows 10/11 + MT5 installed, logged in)
cd vaelor-mt5-bridge
powershell -ExecutionPolicy Bypass -File .\install-service.ps1   # background task
# .env on the VPS:
#   BRIDGE_HOST=0.0.0.0
#   BRIDGE_PUBLIC_HOST=203.0.113.10        # the VPS public IP (or a domain)
#   BRIDGE_ALLOWED_ORIGIN_REGEX=https?://((\d{1,3}\.){3}\d{1,3}|localhost|127\.0\.0\.1)(:\d+)?
#   BRIDGE_MODE=live
#   ALLOW_LIVE_TRADES=1
#   MT5_AUTO_CONNECT=1
```

Then on your local machine open the pairing page of the VPS:

```
http://203.0.113.10:8899/pair
```

-> **Connect the website automatically**. The Execution page now pairs with the
cloud bridge; the site polls `https://<vps>:8899/api/...` and the bridge places
trades through the VPS MetaTrader 5 terminal. Your local MT5 can be closed -
the VPS keeps running and the desk keeps trading.

Trade safety is unchanged: the typed `LIVE` confirmation, the hard live-order
interlock, the per-trade lot cap, the symbol whitelist, the daily-loss/drawdown
guards, the kill switch and the prop-firm signal-only lock all still apply on the
cloud host. The VPS must be left running (a cloud host is "always on", so the
robot can trade around the clock).

## Modes and safety interlocks

| Mode | What happens |
| --- | --- |
| `auto` (default) | Tries MT5. If the terminal is not running or not authorized, starts the simulation broker and reports why in the UI. |
| `simulation` | Virtual account, live-style quotes, persistent paper positions and deals. |
| `live` | Real terminal, real orders. Requires `ALLOW_LIVE_TRADES=1` **and** a typed `LIVE` confirmation in the UI. |

Hard guards, enforced server-side:

- one loopback bind, token required on every API call except `/health`;
- live order routing is refused unless `ALLOW_LIVE_TRADES=1`;
- per-trade lot cap, max open positions, symbol whitelist, daily-loss and
  drawdown guards, market-order switch, kill switch (`confirm: "KILL"`);
- cloud strategies always arrive **disabled** — an AI cannot enable trading by
  publishing a manifest;
- every order, rejection, stop-out and strategy toggle is written to the audit
  log (`GET /api/audit`);
- `idempotencyKey` on orders makes retries safe;
- **prop-firm signal-only lock** (`POST /api/prop`): refuses every opening
  order — manual, approved or auto — while closes and stop moves still work.

## Live signals and prop-firm mode

Enabled rule strategies are evaluated by the bridge on the **last closed bar**
using the same DSL code as the backtester, so the chart, the signal and the
measured result agree. Each pending ticket carries entry, stop, target,
suggested lots, R multiple and a management plan (breakeven at 1R, optional
trail after 1R, never widen the stop). Tickets expire after two bars and are
deduplicated per closed bar; the scan runs every 15 seconds and on demand via
`POST /api/signals/scan`.

For prop firms, turn on **Signal-only** in the Safety section. The bridge then
refuses every opening order while signals, alerts and the indicator keep
working, so the trader executes manually.

### Signal-only MT5 indicator

`GET /api/strategies/{id}/indicator.mq5` returns a MetaTrader 5 indicator
generated from that strategy's conditions, stop, target and trail rules. It is
an indicator, **not** an EA: no `OrderSend`, no `CTrade`, no trade include. It
draws arrows, entry/stop/target lines, a panel with lots and the management
plan, and raises alerts. Install it under `MQL5/Indicators`, compile in
MetaEditor (F7) and attach it to the matching symbol and timeframe. Python and
external strategies cannot be translated and are rejected with an explanation.

## Enabling the real terminal

1. Install MetaTrader 5, log in (demo first), and enable
   **Tools → Options → Expert Advisors → Allow algorithmic trading**.
2. Set `MT5_TERMINAL_PATH` in `.env`. If the terminal cannot stay logged in,
   also set `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER`.
3. Keep `BRIDGE_MODE=auto` (or `live`).
4. Verify the UI header says **LIVE** and that the account number matches.
5. Only then set `ALLOW_LIVE_TRADES=1` and restart the bridge.
6. Confirm the symbol names your broker uses (for example `XAUUSD.a`). The
   bridge resolves suffixes automatically and lists the actual symbols in the
   order ticket.

If MT5 returns `Authorization failed`, the terminal is installed but no account
is logged in — the bridge stays in simulation and says so. Nothing is faked:
simulated fills are always labelled `SIMULATION` in the UI and in the API.

## Strategy model

A strategy is a JSON manifest. AI agents publish it with the
`register_strategy` MCP tool; the bridge imports it on the next sync.

```json
{
  "id": "gold-ema-trend",
  "name": "Gold EMA trend + RSI filter",
  "author": "desk",
  "symbols": ["XAUUSD"],
  "timeframe": "H1",
  "direction": "both",
  "entryLong":  { "all": [
    { "type": "ema_cross", "fast": 20, "slow": 50, "direction": "up" },
    { "type": "rsi", "period": 14, "op": "above", "value": 50 }
  ]},
  "entryShort": { "all": [
    { "type": "ema_cross", "fast": 20, "slow": 50, "direction": "down" },
    { "type": "rsi", "period": 14, "op": "below", "value": 50 }
  ]},
  "exit": { "any": [
    { "type": "ema_cross", "fast": 20, "slow": 50, "direction": "down" }
  ]},
  "stop":   { "type": "atr", "mult": 2.0 },
  "target": { "type": "atr", "mult": 4.0 },
  "trail":  { "type": "atr", "mult": 1.5 },
  "risk":   { "riskPct": 1.0, "maxPositions": 1 },
  "tags":   ["trend", "metals"]
}
```

Conditions: `ema_cross`, `sma_cross`, `price_vs_ema`, `price_vs_sma`, `rsi`,
`macd`, `breakout`, `bollinger`, `atr_filter`, `always`.
Stops/targets: `{"type":"atr","mult":n}`, `{"type":"pips","pips":n}`,
`{"type":"percent","pct":n}`.

Signals are queued by AI agents (`submit_signal` MCP tool) and appear in the
**Signals** panel. They execute only when you approve them, or automatically if
the strategy is enabled **and** has `autoExecute: true` **and** the kill switch
is off.

### Python strategies

`POST /api/strategies/python` accepts a `.py` file, raw source, or a
converter-style JSON bundle (`metadata.language: "python"` plus `source`/`code`).
The bridge analyses the module and picks one of two honest modes:

| Mode | Detection | Behaviour |
|---|---|---|
| `python` | defines `on_bar(ctx)` and does not import `MetaTrader5` | backtested in an isolated `python -I` subprocess |
| `external` | imports `MetaTrader5` / calls `mt5.*` | registered with metadata and source only; never executed or backtested |

```python
META = {"warmup": 60}

def on_bar(ctx):
    fast, slow = ctx.ema(20), ctx.ema(50)
    if ctx.value(fast) is None or ctx.value(slow) is None:
        return None
    if not ctx.has_position and ctx.crossover(fast, slow):
        return {"signal": "buy", "stop_atr": 2, "target_atr": 4}
    if not ctx.has_position and ctx.crossunder(fast, slow):
        return {"signal": "sell", "stop_atr": 2, "target_atr": 4}
    if ctx.has_position and ctx.crossunder(fast, slow):
        return {"signal": "close"}
    return None
```

Signals are evaluated on closed bars and filled at the next bar's open with the
same spread, commission, stop-before-target ordering and risk gates as the DSL
engine. The runner gets restricted builtins and an import allowlist (no
filesystem, network, subprocess or `os`); a strategy that needs those is an
`external` EA. `list_strategies` strips `code` and reports `hasCode` / `runtime`
so the desk can label it without shipping the source to the browser.

## Backtesting

`POST /api/backtest` runs the manifest bar by bar on historical data:

- next-bar-open fills, spread and commission, conservative stop-before-target
  inside a candle, ATR/pip/percent stops, ATR trailing, risk-based sizing and a
  leverage cap;
- results include trades, equity curve, win rate, profit factor, expectancy in
  R, Sharpe, max drawdown, score and a confidence label (Wilson lower bound);
- `start`/`end` (or a `1mo`/`3mo`/`1y` style window chosen in the UI) select the
  exact test period. `M1` is supported; bar caps keep one request responsive and
  the response says when the window was shortened. Broker index names are
  aliased (`US30` → `DJIUSD`, `NAS100` → `NDXUSD`, `SPX500` → `SPXUSD`);
- every result carries a `report`: day / week / month aggregates (net P/L, wins,
  losses, best and worst trade, opening and closing equity), an exit-reason
  breakdown, and the complete trade list. Bars returned by the terminal are
  clamped to the requested window, so a fallback fetch can never leak a
  different period into the statistics.

Python strategies with `runtime="python"` take the same path through
`app/python_backtest.py` (subprocess, 180 s timeout, identical stats/report).
`runtime="external"` is refused with an explanatory 400: the bridge will not
pretend to backtest an EA that places its own orders.

Live MT5 uses the terminal's own history. Simulation uses the Vaelor Worker's
real futures history where a mapping exists and a deterministic synthetic
series otherwise (both are labelled in the response).

## API surface

```
GET  /health                       public liveness + mode
GET  /api/status                   account, risk, cloud, counts
GET  /api/snapshot                 everything the desk needs in one poll
GET  /api/symbols                  tradable symbols with specs
GET  /api/positions                open positions + pending orders
GET  /api/history?days=30          closed deals
POST /api/orders                   market/limit order
POST /api/positions/{t}/modify     SL/TP
POST /api/positions/{t}/close      full or partial close
POST /api/positions/{t}/breakeven  stop to entry
POST /api/positions/{t}/trail      trailing stop in pips
POST /api/positions/close-all      flatten (optional strategyId)
GET/PUT /api/risk                  risk configuration
POST /api/kill                     kill switch
POST /api/mode                     simulation/live switch
POST /api/prop                     prop-firm signal-only lock
GET/POST /api/live-config          timeframe, broker symbols, strategy for live desk
GET  /api/strategies               registry + measured performance
POST /api/strategies               register a manifest
GET  /api/strategies/{id}          full registry row (source included)
DELETE /api/strategies/{id}        delete a strategy and its pending tickets
POST /api/strategies/python        register a .py strategy or converter bundle
POST /api/strategies/{id}/toggle   enable/pause + autoExecute
GET  /api/strategies/{id}/indicator.mq5  signal-only MT5 indicator
POST /api/strategies/sync          pull the cloud registry now
GET  /api/signals                  signal queue
POST /api/signals/scan             evaluate enabled strategies now
POST /api/signals/{id}/approve     execute at market
POST /api/signals/{id}/reject      discard
GET  /api/performance              success-rate table
POST /api/backtest                 run a backtest
GET  /api/backtests[/{id}]         history of runs
GET  /api/audit                    immutable action log
GET  /api/cloud/status|sync        Worker sync state
```

All calls except `/health` need `X-Bridge-Token: <token>`.

## Tests

```powershell
cd mt5-bridge
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

The suite covers indicator/backtest invariants, metrics, order lifecycle,
partial closes, idempotency, risk caps, signals, performance and manual
backtests against the simulation broker.

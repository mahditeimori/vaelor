---
title: MetaTrader 5 Execution Desk
order: 9
section: "5"
description: Connect your own MetaTrader 5 terminal, backtest on broker history, measure strategy success and route orders safely.
---

# 5. MetaTrader 5 Execution Desk

The Execution Desk turns this site into a front end for **your own** MetaTrader 5
terminal. It is not a managed account and it never holds funds. A small bridge
program runs on your PC, talks to the MetaTrader 5 terminal you already use, and
exposes a loopback API that the site's Execution page can call.

```
Execution page (browser)
        │  http://127.0.0.1:8899  (token required)
        ▼
Vaelor MT5 bridge (your PC, Python)
        │  MetaTrader5 Python package
        ▼
Your MetaTrader 5 terminal  ──►  your broker
```

## 5.1 Why a local bridge

Browsers cannot open a socket to MetaTrader. Brokers also do not expose a public
REST API for retail terminals. The bridge solves both problems without asking you
to hand over account credentials:

| Concern | How it is handled |
|---|---|
| Credentials | Used for one `mt5.initialize` call, held in memory, never written to disk |
| Positions and history | Read from the terminal the bridge is attached to |
| Transport | Loopback only (`127.0.0.1`); never exposed to the internet |
| Orders | Signed by your terminal, filled by your broker |
| Audit | Local SQLite table of every action, plus optional cloud sync |

## 5.2 Requirements

* Windows 10 or 11 — the official `MetaTrader5` Python package is Windows-only.
* MetaTrader 5 installed by your broker, with at least one account logged in.
* Python 3.11, or [uv](https://docs.astral.sh/uv/) which can provision it.
* One free TCP port. The default is **8899**.

Any broker works. The bridge auto-detects every terminal installed for your
Windows user, including broker-branded folders and portable copies.

## 5.3 Quick start

1. Download [`vaelor-mt5-bridge.zip`](/downloads/vaelor-mt5-bridge.zip).
2. Unzip it to a folder you control, for example `C:\Vaelor\mt5-bridge`.
3. Double-click `run.cmd`. The first run creates `.venv`, installs dependencies
   and writes `.env`.
4. The console prints a URL and a token:

   ```
   URL   : http://127.0.0.1:8899
   Token : 5rT...redacted...
   ```

5. Open the Execution page, paste both values and press **Connect**.
6. Pick your terminal from the detected list and press **Connect** on that row.

The page then polls the bridge automatically. There is no refresh button by
design — the account, book, strategies, signals and audit log all update in
place.

## 5.4 Terminal discovery

The bridge finds terminals from three independent sources so nothing is missed:

1. **MetaQuotes profiles** — `%APPDATA%\MetaQuotes\Terminal\*\origin.txt` names
   the install directory of every terminal that has ever run.
2. **Running processes** — `terminal64.exe` paths, including portable copies.
3. **Install roots** — `Program Files`, `Program Files (x86)` and
   `%LOCALAPPDATA%\Programs` are scanned for `terminal64.exe`.

A terminal that has never been launched still appears; it simply has no data
directory yet.

### "Authorization failed"

That message means **no account is logged in** in the terminal the bridge tried,
not that the code is broken. Open MetaTrader 5, sign in with
`File > Login to Trade Account`, then connect again. If you prefer, use the
optional sign-in fields on the Execution page; those values are used for a single
call and discarded.

## 5.5 AutoTrading

Reading quotes, positions and history works as soon as an account is logged in.
Sending orders additionally requires AutoTrading in MetaTrader 5:

1. Press the **AutoTrading** button in the terminal toolbar.
2. Open `Tools > Options > Expert Advisors`.
3. Tick **Allow algorithmic trading**.

The bridge cannot and will not toggle this for you — it is your terminal's own
safety switch. Until it is on, live orders are rejected with retcode **10027**
and a plain-English explanation.

## 5.6 The live interlock

Real orders need two independent keys:

1. `ALLOW_LIVE_TRADES=1` in `mt5-bridge/.env`, followed by a bridge restart;
2. a typed `LIVE` confirmation in the Execution page.

With either key missing the order is refused. A run without a connected terminal
uses the **simulation broker**: fills are virtual, balances are tracked locally,
and every fill is labelled `simulation` in the UI and the audit log. Simulation
results are never presented as live results.

Default `.env` values are deliberately conservative:

```ini
BRIDGE_MODE=auto
ALLOW_LIVE_TRADES=0
CLOUD_SYNC=1
```

`BRIDGE_MODE=auto` tries the terminal first and falls back to simulation with a
stated reason.

## 5.7 Risk gates

Every order passes the same server-side gate before it reaches the broker:

| Gate | Default | Effect |
|---|---|---|
| Kill switch | off | Blocks all new orders instantly |
| Max lots per trade | 2.0 | Rejects oversized tickets |
| Max open positions | 5 | Rejects new entries at the cap |
| Symbol whitelist | empty (all) | Restricts the desk to named symbols |
| Market orders | allowed | Can be disabled to force limit orders |
| Daily loss | 3% | Halts new risk after the limit |
| Max drawdown | 10% | Halts new risk after the limit |

The kill switch can flatten the book in the same action. Releasing it is a
separate, explicit confirmation.

## 5.8 Order lifecycle

1. The ticket is validated in the browser and again by the bridge.
2. Risk gates run; the terminal connection is confirmed.
3. Stops are checked against the broker's minimum distance.
4. The filling mode is chosen from what the symbol supports (FOK, IOC, RETURN).
5. `order_send` is called; requotes and unsupported filling modes retry.
6. A non-zero retcode is surfaced verbatim with a hint — never masked as a fill.

Supported management actions: modify SL/TP, break-even, trail by pips, partial
close, full close and close-all. Every action is written to the audit log.

## 5.9 Strategies from people and AI

Strategies are published through the MCP tools
(`register_strategy`, `submit_signal`) or the REST registry:

| Endpoint | Purpose |
|---|---|
| `GET /api/strategies` | Registry with measured performance |
| `POST /api/strategies` | Publish a manifest |
| `DELETE /api/strategies/{id}` | Retire a strategy |
| `POST /api/signals` | Queue a signal |
| `GET /api/signals?status=pending` | Read the queue |
| `POST /api/signals/{id}/status` | Record the desk's decision |
| `GET/POST /api/performance` | Read or publish measured results |

Two rules are enforced by the registry, not the UI:

* a published strategy is always created **disabled** and with auto-execute off;
* a signal is always created **pending** and only the bridge can approve,
  execute or reject it.

Supported conditions: `ema_cross`, `sma_cross`, `price_vs_ema`, `price_vs_sma`,
`rsi`, `macd`, `breakout`, `bollinger`, `atr_filter`, `always`. Stops and
targets accept `atr`, `pips` and `percent` rules. Manifests are validated twice:
by the registry at publish time (so the author gets an actionable error) and by
the execution engine before anything runs.

## 5.10 Measuring success

Results come from two evidence sources, never from a number supplied by the
author:

* **backtest** — event-driven, next-bar-open fills, spread and commission,
  conservative stop-before-target ordering, ATR/pip/percent stops, ATR trailing,
  risk-based sizing and a leverage cap. Runs on your broker's own history.
* **live** — closed deals attributed to a strategy by magic number.

Metrics: win rate, profit factor, expectancy in R, Sharpe, maximum drawdown,
average bars held, and a 0–100 composite score that is penalised by the Wilson
lower bound so small samples cannot score highly. Confidence is labelled
`insufficient`, `low`, `medium` or `high`. Live evidence takes over from backtest
only after ten closed trades.

## 5.11 Bridge API reference

All routes except `/health` require the `x-bridge-token` header.

| Route | Method | Notes |
|---|---|---|
| `/health` | GET | Unauthenticated liveness probe |
| `/api/status` | GET | Mode, account, risk, cloud, counts |
| `/api/mt5/diagnostics` | GET | Package, terminals, active session |
| `/api/mt5/connect` | POST | Terminal path, optional one-shot login |
| `/api/mt5/disconnect` | POST | Return to simulation |
| `/api/mt5/reconnect` | POST | Reattach without credentials |
| `/api/symbols`, `/api/quote` | GET | Broker instruments and live quotes |
| `/api/positions`, `/api/history` | GET | Open book and closed deals |
| `/api/orders` | POST | Market or limit order |
| `/api/positions/{ticket}/*` | POST | modify, close, breakeven, trail |
| `/api/risk`, `/api/kill`, `/api/mode` | GET/PUT/POST | Safety controls |
| `/api/strategies*`, `/api/signals*` | GET/POST | Registry and queue |
| `/api/backtest`, `/api/backtests` | POST/GET | Historical simulation |
| `/api/audit`, `/api/snapshot` | GET | Traceability and bulk view |

The bridge answers Chrome's Private Network Access preflight with
`Access-Control-Allow-Private-Network: true`, which is what lets an HTTPS page
reach a loopback service.

## 5.12 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page says bridge offline | Bridge not running or wrong port | Start `run.cmd`; confirm the URL |
| `Token rejected` | Token belongs to another bridge data folder | Copy the token printed at startup |
| `Authorization failed` | No account logged in | Sign in inside MetaTrader 5 |
| `retcode 10027` | AutoTrading off | Enable the toolbar button and Expert Advisors option |
| `retcode 10016` | Stop too close | Move the stop outside the broker's minimum distance |
| `retcode 10030` | Unsupported filling mode | The bridge retries automatically; check symbol settings if it persists |
| No terminals detected | MT5 installed for another Windows user | Run the bridge as the user who installed it |
| Port 8899 busy | Another process owns it | Start with `run.ps1 -Port 8900` and pair that URL |

## 5.13 Security model

* The bridge binds to loopback and refuses non-token requests.
* Passwords are never persisted; the audit log stores login and server only.
* The token is stored in your browser's local storage, not on our servers.
* Cloud sync sends strategy manifests, signal decisions and measured metrics —
  never credentials, balances or positions.
* Every state-changing action is auditable locally, and order rejections are
  recorded with the broker's retcode.

Execution is provided for the account owner's own terminal. Nothing in this
section constitutes investment advice, and no result shown by a backtest is a
promise of future performance.

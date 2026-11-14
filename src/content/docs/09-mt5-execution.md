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

1. Download [`vaelor-mt5-bridge.zip`](/downloads/vaelor-mt5-bridge.zip?v=1.2.0).
2. Unzip it to a folder you control, for example `C:\Vaelor\mt5-bridge`.
3. Double-click `run.cmd`. The first run creates `.venv`, installs dependencies
   and writes `.env`; the console prints a URL and a token and saves both to
   `connect.txt` and `token.txt` next to `run.cmd`.
4. A **Connect page** opens in your browser automatically (the bridge serves it
   at `http://127.0.0.1:8899/pair`). Press **Connect the website
   automatically** — the Execution page pairs itself with zero typing.
5. Pick your terminal from the detected list and press **Connect** on that row.

Manual fallback: paste the URL and token from `connect.txt` into the
Execution page and press **Connect**.

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

1. the **Enable live trading** button in the Safety section of the Execution page —
   you confirm a warning and type `ENABLE LIVE`. The unlock is stored in your local
   bridge database, so it survives restarts; **Lock live trading** puts it back on
   at any time. You never edit a file or restart the bridge.
2. a typed `LIVE` confirmation on each real order.

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

`ALLOW_LIVE_TRADES=1` remains available for headless installs (it unlocks at
startup); the website button is the normal path. `BRIDGE_MODE=auto` tries the
terminal first and falls back to simulation with a stated reason.

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

## 5.8 Live signals and manual management

The Signal section of the Execution page is fed by the bridge itself. Every
enabled **rule (DSL)** strategy is evaluated on the **last closed bar** of its
timeframe with exactly the same code the backtester uses, so the chart, the
signal and the measured result cannot disagree.

Each ticket states everything needed to place and manage the trade by hand:

| Field | Meaning |
|---|---|
| Side, symbol, timeframe | What to trade and on which chart |
| Entry | The closed bar's price; the ticket is valid while the level holds |
| SL / TP | Absolute prices computed from the strategy's stop and target rules |
| Lots | Suggested size at your configured risk per trade (default 1%) |
| R / RR | Stop distance in R and the reward-to-risk ratio |
| Management | Plan for moving the stop (see below) |
| Note | One-line summary of the setup |

Management defaults, taken from the strategy manifest:

* move the stop to **breakeven at 1R** — the trade becomes risk-free;
* when the strategy defines a `trail`, trail the stop after 1R (ATR multiple,
  pips or percent);
* take profit at the target, or close early when the exit rule fires;
* **never widen the stop**.

Pending strategy tickets expire after two bars (minimum one hour) so an old
level is never treated as actionable. Identical closed bars are deduplicated.
The feed refreshes every 15 seconds; **Scan now** evaluates immediately.

**Copy** puts the whole ticket on the clipboard, ready to paste into the MT5
order window. Nothing is sent to the broker by the signal machinery.

## 5.9 Prop-firm mode: signal-only

Prop firms usually forbid robots that manage the account. Turn on
**Signal-only** in the Safety section and the bridge refuses **every opening
order** — manual tickets, approved signals and auto-execution alike. The lock
is stored in the bridge database and survives restarts.

Closing a position and moving a stop stay available because they reduce risk.
Signals, alerts and the MT5 indicator keep working, so you remain in full
manual control of the account. `GET /api/status` reports the lock as
`safety.propSafe`.

### 5.9.1 Signal-only MT5 indicator

The strategy table has an **MT5** column. For each rule strategy, **Indicator**
downloads `<id>-vaelor-signal.mq5`: a MetaTrader 5 indicator generated from
that strategy's own conditions, stop, target and trail rules.

The file is intentionally an **indicator, not an Expert Advisor**. It contains
no `OrderSend`, no `CTrade` and no trade include, so it can never trade the
account:

* buy/sell arrows on the closed bar that satisfies the rules;
* horizontal entry, stop and target lines;
* a panel with suggested lots and the management plan;
* an alert on each new signal, plus a note when the chart timeframe does not
  match the strategy.

To install it: in MetaTrader 5 open **File → Open Data Folder → MQL5 →
Indicators**, copy the `.mq5` file there, open it in MetaEditor (F4), compile
with F7, then drag it from the Navigator onto the matching symbol and
timeframe. Python `on_bar` strategies and external EAs cannot be translated
automatically; the button is disabled for them and explains why.

## 5.10 Order lifecycle

1. The ticket is validated in the browser and again by the bridge.
2. Risk gates run; the terminal connection is confirmed.
3. Stops are checked against the broker's minimum distance.
4. The filling mode is chosen from what the symbol supports (FOK, IOC, RETURN).
5. `order_send` is called; requotes and unsupported filling modes retry.
6. A non-zero retcode is surfaced verbatim with a hint — never masked as a fill.

Supported management actions: modify SL/TP, break-even, trail by pips, partial
close, full close and close-all. Every action is written to the audit log.

## 5.11 Strategies from people and AI

Strategies are published through the MCP tools
(`register_strategy`, `submit_signal`) or the REST registry:

| Endpoint | Purpose |
|---|---|
| `GET /api/strategies` | Registry with measured performance |
| `POST /api/strategies` | Publish a manifest |
| `POST /api/strategies/python` | Publish a `.py` file or converter JSON bundle |
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

### 5.11.1 Bring your own strategy (the editor)

The **Strategy registry** panel on `/execution` has an *Add your own strategy*
editor. The preferred format is a **JSON manifest**: the bridge evaluates and
executes the rules itself, so it can backtest them on your broker's history and
enforce the risk gates uniformly, with no user code involved.

Python is also accepted, in two clearly separated modes:

| Mode | What it is | What the bridge does |
|---|---|---|
| `python` | A strategy module exposing `on_bar(ctx)` | Runs it in an isolated subprocess and **backtests** it |
| `external` | A full EA/bot that imports `MetaTrader5` and places its own orders | Stores it as reference; never executed or backtested by the bridge |

Anything that cannot be expressed as rules — including an `external` EA — can
also live in your own tooling and submit **signals** through the registry.

A complete example:

```json
{
  "id": "my-gold-cross",
  "name": "My Gold EMA cross",
  "author": "your name",
  "description": "20/50 EMA cross on gold with an ATR stop and a 2R target.",
  "symbols": ["XAUUSD"],
  "timeframe": "H1",
  "direction": "both",
  "entryLong":  { "all": [{ "type": "ema_cross", "fast": 20, "slow": 50, "direction": "up" }] },
  "entryShort": { "all": [{ "type": "ema_cross", "fast": 20, "slow": 50, "direction": "down" }] },
  "exit":       { "any": [{ "type": "ema_cross", "fast": 20, "slow": 50, "direction": "down" }] },
  "stop":   { "type": "atr", "mult": 2 },
  "target": { "type": "atr", "mult": 4 },
  "risk":   { "riskPct": 1, "maxPositions": 1 }
}
```

Field reference:

| Field | Values |
|---|---|
| `symbols` | Up to 8 broker symbols, e.g. `XAUUSD`, `EURUSD` |
| `timeframe` | `M1` `M5` `M15` `M30` `H1` `H4` `D1` `W1` |
| `direction` | `long`, `short` or `both` |
| `entry` / `entryLong` / `entryShort` | `{ "all": [...], "any": [...] }` condition groups |
| `exit` | Optional exit condition group |
| `stop` / `target` / `trail` | `{ "type": "atr", "mult": n }`, `{ "type": "pips", "pips": n }` or `{ "type": "percent", "pct": n }` |
| `risk` | `riskPct` (0.05–10 % of equity per trade), `maxPositions`, optional `maxLots` |

Condition fields by type: cross types take `fast`, `slow`, `direction`;
`price_vs_ema`/`price_vs_sma` take `period`, `op`; `rsi` takes `period`, `op`,
`value`; `macd` takes `fast`, `slow`, `period`, `direction`; `breakout` takes
`lookback`, `side` (`high`/`low`); `bollinger` takes `period`, `mult`, `side`
(`upper`/`lower`) and optional `mode` (`touch`/`close_outside`); `atr_filter`
takes `period`, `min`; `always` takes nothing.

Workflow: **Insert example → edit → Validate** (the bridge checks the manifest
and reports the warm-up bar requirement without saving it) → **Register
strategy**. The registered strategy arrives **disabled**: run a backtest on your
broker's history first, then enable it from the table when the numbers justify
it.

### 5.11.2 Drop a file instead of pasting

The editor accepts a file two ways: the *Load file* button, or by **dragging a
file onto the editor** and dropping it. A `.json` or `.py` file (plain text is
also fine) is read locally in the browser; nothing is uploaded until you press
**Register strategy**. The panel then shows the file name and the detected mode
(`Rules`, `PY on_bar` or `PY external`).

* A JSON manifest is parsed and validated exactly as if you had pasted it.
* A Python file is analysed by the bridge: if it imports `MetaTrader5` or calls
  `mt5.*`, it is registered as `external`; otherwise it must expose
  `on_bar(ctx)` and becomes a backtestable `python` strategy.
* Converter-style JSON bundles — `metadata.language: "python"` plus a `source`
  or `code` string (for example the output of a Python→JSON converter) — are
  unwrapped and treated as Python source rather than rejected as an invalid
  manifest.

### 5.11.3 The Python `on_bar` contract

A backtestable Python strategy is a single module with an `on_bar(ctx)` entry
point. The bridge calls it once per closed bar, oldest first, and acts on the
returned signal at the **next bar's open**:

```python
META = {"warmup": 60, "name": "EMA 20/50 cross"}

def on_bar(ctx):
    fast = ctx.ema(20)
    slow = ctx.ema(50)
    if ctx.value(fast) is None or ctx.value(slow) is None:   # warm-up
        return None
    if not ctx.has_position and ctx.crossover(fast, slow):
        return {"signal": "buy", "stop_atr": 2, "target_atr": 4}
    if not ctx.has_position and ctx.crossunder(fast, slow):
        return {"signal": "sell", "stop_atr": 2, "target_atr": 4}
    if ctx.has_position and ctx.crossunder(fast, slow):
        return {"signal": "close"}
    return None
```

`ctx` exposes the current bar (`ctx.open`, `high`, `low`, `close`, `volume`,
`time`, `bar`), account/state (`ctx.position`, `ctx.has_position`,
`ctx.equity`, `ctx.initial_balance`, `ctx.bars_since_entry()`), and indicators
returning whole series: `sma`, `ema`, `rsi`, `atr` (read one point with
`ctx.value(series, offset)`), plus `crossover`, `crossunder`, `highest`,
`lowest`, `highest_close`, `lowest_close` and `ctx.log("...")`. A signal is a
dict (or a plain `"buy"`/`"sell"`/`"close"` string) keyed by `signal` (also
accepts `action`/`side`), with optional `sl`/`tp` prices, `stop_atr`,
`target_atr`, `trail_atr` multipliers, `stop_pips`/`target_pips`, `lots` and
`trail`. Return `None` to do nothing. If `META["warmup"]` is set, bars before
it are not signalled (default 30).

The runner executes in its own process (`python -I`) with an import allowlist
and restricted builtins: no file system, network, subprocess or `os` access, and
no `dunder` traversal. A strategy that needs any of those is an `external` EA
and must run itself — the bridge will not execute it, and its backtest button is
disabled with the reason shown.

### 5.11.4 External Python and MQL5 strategies

If you already have a self-contained bot that connects to the terminal itself
(typically `import MetaTrader5` and `mt5.order_send`), drop the `.py` file in as
usual. It is registered with its metadata and source for reference, labelled
`PY external`, and excluded from backtests. Run it in your own environment (or
attach it as an EA in MetaTrader 5); the desk will still attribute its closed
deals to the strategy when they carry the matching magic number, and the
measured live results appear in the registry next to rule-based strategies.

## 5.12 Measuring success

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

### 5.12.1 Choosing the test window and reading the report

Backtests run from the **Test window** picker in Section 07, not from a fixed
two-year default: last 10 days, 1, 2, 3 or 6 months, 1 or 2 years, or a custom
`From`/`To` date pair. `M1` is available alongside `M5`–`D1`; indices such as
**US30 (Dow Jones)** and **NAS100 (Nasdaq 100)** are in the symbol list next to
gold, silver and the FX majors.

The engine fetches the broker's own bars for that exact window. Long windows on
low timeframes are capped so one request stays responsive (M1: 60,000 bars,
M5: 40,000, M15/M30: 30,000, H1 and above: 20,000); when the cap bites the result
says so and the report shows the window actually tested.

Every run returns four views of the same trades:

* **Monthly / Weekly / Daily** — per period: trade count, wins, losses, win rate,
  net P/L, best and worst trade, and opening/closing equity. Click a row to filter
  the full trade list to that period.
* **Exit reasons** — P/L grouped by the decision that closed the trade (stop
  loss, take profit, exit signal, still open at the end), so the cost of each
  rule is visible rather than buried in a total.
* **All trades** — every fill from the first to the last, with entry/exit, lots,
  P/L, R multiple, bars held and exit reason. **Download CSV** exports the same
  list.
* **Equity curve** — sampled from the same run, so the curve and the tables can
  never disagree.

Days are UTC, matching MT5 timestamps.

If the four report views stay empty after a run, the local bridge is older than
the page: Section 01 shows `bridge v… · update`. Close the bridge, install the
current `.zip` from Section 01 and restart it, then run the backtest again.

## 5.13 Bridge API reference

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
| `/api/risk`, `/api/kill`, `/api/mode`, `/api/prop` | GET/PUT/POST | Safety controls, including the signal-only lock |
| `/api/strategies*`, `/api/signals*` | GET/POST | Registry, queue and `/api/strategies/python` |
| `/api/signals/scan` | POST | Evaluate enabled strategies now |
| `/api/strategies/{id}/indicator.mq5` | GET | Download the signal-only MT5 indicator |
| `/api/backtest`, `/api/backtests` | POST/GET | Historical simulation |
| `/api/audit`, `/api/snapshot` | GET | Traceability and bulk view |

The bridge answers Chrome's Private Network Access preflight with
`Access-Control-Allow-Private-Network: true`, which is what lets an HTTPS page
reach a loopback service.

## 5.14 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page says bridge offline | Bridge not running or wrong port | Start `run.cmd` **on the PC where MetaTrader 5 is installed**; keep its window open; confirm the URL. `http://127.0.0.1:8899` is correct — it means "this computer" |
| `Token rejected` | Token belongs to another bridge data folder | Copy the token printed at startup |
| `Authorization failed` | No account logged in | Sign in inside MetaTrader 5 |
| `retcode 10027` | AutoTrading off | Enable the toolbar button and Expert Advisors option |
| `retcode 10016` | Stop too close | Move the stop outside the broker's minimum distance |
| `retcode 10030` | Unsupported filling mode | The bridge retries automatically; check symbol settings if it persists |
| No terminals detected | MT5 installed for another Windows user | Run the bridge as the user who installed it |
| Port 8899 busy | Another process owns it | Automatic: the launcher reuses a running bridge (URL + token saved to `connect.txt`) or picks the next free port 8899–8925 |

## 5.15 Security model

* The bridge binds to loopback and refuses non-token requests.
* The pairing token is handed to the browser only through the bridge's own
  `/pair` page on loopback (one click, no copy/paste); cross-origin access to
  that page is limited to the Vaelor site, so other websites cannot read it.
* Passwords are never persisted; the audit log stores login and server only.
* The token is stored in your browser's local storage, not on our servers.
* Cloud sync sends strategy manifests, signal decisions and measured metrics —
  never credentials, balances or positions.
* Every state-changing action is auditable locally, and order rejections are
  recorded with the broker's retcode.
* Python `on_bar` strategies run on your machine in a separate, isolated
  interpreter with an import allowlist and restricted builtins; `external` EAs
  are stored, never executed. No strategy file is ever sent to our servers
  except the manifest metadata you choose to sync.

Execution is provided for the account owner's own terminal. Nothing in this
section constitutes investment advice, and no result shown by a backtest is a
promise of future performance.

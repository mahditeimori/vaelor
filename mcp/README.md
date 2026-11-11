# Trading LLC — AI channel (Cloudflare Worker, v2.0.0)

A **public, no-config channel** any AI can connect to:

> You teach the AI (manual + company code live on the site) → the AI analyzes →
> it publishes to Cloudflare KV → **the live site renders the result immediately.**

No rebuild, no redeploy, no localhost, no JSON editing.

```
                    read/search manual, company code
      AI  ───────────────────────────────────────────────▶  Worker (Cloudflare edge)
          ◀───────────────────────────────────────────────        │
                    publish_analysis → KV "AI_STATE"             │
                                                                 ▼
                        https://vaelor.pages.dev  (fetches GET /api/analysis)
```

## Public endpoints

Base URL: **https://trading-llc-mcp.mahdi-t8256.workers.dev**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | MCP over HTTP (JSON-RPC 2.0, stateless) |
| `GET`  | `/api/analysis` | Latest published analysis (JSON) |
| `POST` | `/api/analysis` | Publish analysis (same payload as the MCP tool) |
| `GET`  | `/api/health` | `{"ok":true,"service":"trading-llc-mcp"}` |
| `GET`  | `/api/terminal/state` | Institutional macro/COT/volume-OI state (KV only, safe for 60s polling) |
| `GET`  | `/api/macro/status` | Sync health + cron job registry |
| `POST` | `/api/macro/refresh` | Force CFTC + futures volume/OI refresh (optional Bearer `MACRO_REFRESH_TOKEN`) |
| `GET`  | `/api/finviz?code=GC&p=w1` | Finviz COT chart proxy → `image/png` |
| `GET`  | `/api/chart?id=gold&range=5d&interval=15m` | OHLCV bars for the on-site price chart (Yahoo proxy, TradingView fallback) |

CORS is open (`*`), so browser apps and cloud AIs can call it directly.

## Macro / COT automation (zero-touch)

All live market data is sourced and cached automatically — no manual refresh anywhere on the site.

| Source | Endpoint | Cadence | KV key prefix |
|--------|----------|---------|---------------|
| CFTC Legacy / Disaggregated / TFF | `syncCOT()` | daily 00:05 UTC + Friday 15:30–16:30 ET release window (poll every 5 min) | `macro:cot:<id>` |
| Yahoo Finance v8 chart + CFTC OI fallback | `syncVolumeOi()` | hourly EOD volume/OI | `macro:vol:<id>` |
| Finviz COT chart images | `finvizImage()` | on-demand via `/api/finviz` (5-min cache) | n/a |

- Cron: `*/5 * * * *` → `runScheduled()` derives the Friday release window, daily integrity sync, and hourly volume/OI from cache staleness.
- Bootstrap: first HTTP request after a cold/empty cache seeds CFTC + volume in the background.
- Frontend (`#institutional-chart-section`) polls `/api/terminal/state` every 60 s with cache-busting; KPIs, chart data and Finviz panels re-render in place.

```powershell
# Force an immediate full refresh
curl.exe -X POST "https://trading-llc-mcp.mahdi-t8256.workers.dev/api/macro/refresh"

# Check sync health
curl.exe "https://trading-llc-mcp.mahdi-t8256.workers.dev/api/macro/status"

# Get live terminal state (what the site consumes)
curl.exe "https://trading-llc-mcp.mahdi-t8256.workers.dev/api/terminal/state"

# Finviz COT chart (PNG)
curl.exe -o cot.png "https://trading-llc-mcp.mahdi-t8256.workers.dev/api/finviz?code=GC&p=w1"

# OHLCV bars for the price chart (TradingView-free fallback)
curl.exe "https://trading-llc-mcp.mahdi-t8256.workers.dev/api/chart?id=gold&range=5d&interval=15m"
```

### Price chart engine

The terminal renders TradingView Advanced Real-Time when `tv.js` is reachable. If the CDN or
WebSocket is blocked, it switches automatically to a bundled Lightweight Charts engine fed by
`/api/chart` (Yahoo OHLC, 60 s cache). Gold/silver use the **FOREX.com** broker symbols
(`FOREXCOM:XAUUSD`, `FOREXCOM:XAGUSD`) inside TradingView; the fallback tracks the COMEX futures
contracts (`GC=F`, `SI=F`) because Yahoo has no XAUUSD/XAGUSD spot ticker.

Range allowlist: `1d,5d,1mo,3mo,6mo,1y,2y`. Interval allowlist: `1m,5m,15m,30m,1h,1d,1wk`.

Instruments: Gold (088691), Silver (084691), DXY (098662), Nasdaq spot+futures (209742), S&P 500 (13874A), Dow (124603).

## Connect an AI (paste one URL)

Give the AI this MCP endpoint:

```
https://trading-llc-mcp.mahdi-t8256.workers.dev/mcp
```

| AI | Where |
|----|-------|
| Claude Desktop / claude.ai | Settings → **Connectors** → *Add custom connector* → paste URL |
| ChatGPT (connectors / custom GPT actions) | Add MCP server or import the OpenAPI/REST endpoints |
| Gemini (MCP-capable builds) | Connector settings → add MCP server URL |
| Anything that can POST JSON | Call `POST /api/analysis` directly |

### Suggested prompt

> Read the Trading LLC manual and company code from the MCP server, then analyze
> the market. When you're done, call `publish_analysis` with your regime call,
> signals, confidence and decisions.

## Tools

| Tool | Purpose |
|------|---------|
| `get_manual_index` | List every manual document |
| `read_manual` | Read one document (`{"slug":"01-overview"}`) |
| `search_manual` | Full-text search (`{"query":"circuit breaker"}`) |
| `get_company_code` | Departments / roles / formulas / parameters JSON |
| `publish_analysis` | Publish regime call, signals, confidence, decisions |
| `get_latest_analysis` | Read back the latest published analysis |

Manual documents are fetched live from `https://vaelor.pages.dev/docs/<slug>`
and HTML-stripped inside the Worker, so the AI always reads the deployed version.

## Publishing payload

```json
{
  "regime": "reflation",
  "summary": "Two or three sentences.",
  "confidence": 0.62,
  "signals": { "compositeFlag": "LONG", "cotZ": 1.4, "oiShock": "NONE" },
  "decisions": [
    {
      "instrument": "ES",
      "action": "LONG",
      "thesis": "Why.",
      "invalidation": "What kills it."
    }
  ],
  "source": "claude"
}
```

```powershell
curl.exe -X POST "https://trading-llc-mcp.mahdi-t8256.workers.dev/api/analysis" `
  -H "content-type: application/json" --data-binary "@payload.json"
```

The landing page polls `GET /api/analysis` on load and renders **REGIME CALL**,
**COMPOSITE FLAG**, **CONFIDENCE** and the decisions list.

## Deploy / update

```powershell
# wrangler must be authenticated (wrangler login)
$env:HTTPS_PROXY="http://127.0.0.1:10808"
$env:NO_PROXY="127.0.0.1,localhost,::1"
wrangler deploy --config mcp/wrangler.toml
```

- Config: `mcp/wrangler.toml` (worker name, KV binding `AI_STATE`, crons `*/5 * * * *`, `PAGES_ORIGIN`)
- Code: `mcp/worker.js` + `mcp/lib/` (instruments, csv, cftc, yahoo, pipeline)
- KV namespace: `a1776533b5cb4299accd800aac8d2256` bound as `AI_STATE`
- Pages project: `vaelor` (Git-connected, branch `main`) — static output, no root `wrangler.toml`
- Clear published state: `wrangler kv key delete --namespace-id=a1776533b5cb4299accd800aac8d2256 ai-state --remote`

## Local-only mode (legacy, optional)

`mcp/server.mjs` still runs the original dual transport (stdio / local HTTP on
port 8890) and writes `src/data/ai-state.json`. It is **not** used by the live
site anymore — the Worker + KV is the source of truth.

```powershell
npm run mcp:http   # http://127.0.0.1:8890/mcp (this PC only)
npm run mcp        # stdio
```

## Notes

- `POST /api/analysis` is intentionally open so any AI can publish. If you want
  to lock it down later, add a shared secret check in `mcp/worker.js`.
- Cloud AIs cannot reach `127.0.0.1`; use the public Worker URL above.

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

CORS is open (`*`), so browser apps and cloud AIs can call it directly.

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
wrangler deploy
```

- Config: `wrangler.toml` (worker name, KV binding `AI_STATE`, `PAGES_ORIGIN`)
- Code: `mcp/worker.js`
- KV key: `ai-state` in namespace `a1776533b5cb4299accd800aac8d2256`
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

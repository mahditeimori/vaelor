# Trading LLC — MCP Server (v1.1.0)

Gives your AI a **two-way channel** into this website, the "regular" way:

> You teach the AI (the manual + company code live here) → the AI analyzes →
> it publishes results → **the website just shows them.**

```
        ┌──────────────┐   read_manual / search_manual
  AI ←──│  MCP server   │   get_company_code
        │ (mcp/server)  │
        └───────┬───────┘
                │ publish_analysis
                ▼
    src/data/ai-state.json  ──▶  landing page "Published analysis" section
```

## Two ways to connect — pick one, no config JSON editing required

### ① HTTP mode (recommended — the "regular" way, works for many AIs)

Run once (leave the window open, or install as a background task):

```powershell
cd E:\Opencode\tradingllc_site
npm run mcp:http
```

The server now answers at a **plain URL**:

```
http://127.0.0.1:8890/mcp
```

Any AI product that can add an **MCP server / connector by URL** can now use it:

| AI | Where to add the URL |
|----|----------------------|
| **Claude Desktop (2026 Cowork build)** | Settings → **Connectors** → *Add custom connector* → paste `http://127.0.0.1:8890/mcp` → Add. **No JSON editing needed.** |
| **Claude Desktop (older builds)** | Settings → Developer → *Add custom connector (URL)*, same URL. |
| **Gemini** (desktop/CLI app builds that support MCP URLs) | Connector settings → add MCP server URL. |
| **ChatGPT / Muse / others** | Anywhere they have an "Add MCP server by URL / Connectors" screen — paste the same URL. |

Order of use inside your AI:

1. *"Read the Trading LLC manual and company code, then analyze the market."*
   → the AI calls `get_manual_index` → `read_manual` → `get_company_code`
2. Discuss / correct / train it however you want.
3. Tell it to publish → it calls `publish_analysis` with its regime call,
   signals, confidence and decisions.
4. Open `http://127.0.0.1:3000` — the **Published analysis** section shows the
   results. Nothing else to do.

### ② stdio mode (for AIs configured by command, e.g. Gemini CLI, old-style JSON clients)

```powershell
npm run mcp
```

If (and only if) a client still wants a JSON entry, it is simply:

```json
{ "mcpServers": { "trading-llc-site": {
    "command": "node",
    "args": ["E:\\Opencode\\tradingllc_site\\mcp\\server.mjs"] } } }
```

Both transports expose the **same 6 tools**.

## Tools

| Tool | Purpose |
|------|---------|
| `get_manual_index` | List every manual document |
| `read_manual` | Read one document (the AI's textbook) |
| `search_manual` | Full-text search across the manual |
| `get_company_code` | Departments / roles / formulas / parameters JSON |
| `publish_analysis` | Publish regime call, signals, confidence, decisions to the site |
| `get_latest_analysis` | Read back the latest published analysis |

## Publishing → what the site shows

`publish_analysis` writes **atomically** (tmp-file + rename) to
`src/data/ai-state.json`, and the landing section renders:

- **REGIME CALL** card — regime + summary
- **COMPOSITE FLAG** card — flag, COT z, OI shock
- **CONFIDENCE** card — confidence %
- decisions list — instrument / action / thesis / invalidation

With `npm run dev` running the update appears on reload; for static hosting
pass `rebuild: true` to `publish_analysis` (it runs `npm run build`).

## Things to know

- **Port:** default 8890 → change with `node mcp/server.mjs --http --port 9000`.
- **Cloud AIs can't reach `127.0.0.1`.** ChatGPT web, Gemini web, and claude.ai
  run in the cloud; they can't connect to your local machine. Desktop/CLI apps
  on *this PC* (Claude Desktop, Gemini CLI, Muse desktop) **can**. To expose the
  URL from the cloud you'd need a public tunnel (e.g. a reverse proxy) — only do
  that with authentication, since these tools can edit files.
- **Raw `curl` tests** must send the headers the MCP transport expects:
  `Content-Type: application/json` and
  `Accept: application/json, text/event-stream`.
- Writes go through one shared contract file (`src/data/ai-state.json`);
  human-readable and version-controlled — the never-fades source of truth for
  the AI ↔ site handshake.

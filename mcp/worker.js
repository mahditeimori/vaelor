/**
 * Vaelor Trading LLC — Cloudflare Worker
 *
 * MCP endpoint:  https://<worker>.workers.dev/mcp
 * REST API:
 *   GET  /api/analysis          read latest AI analysis
 *   POST /api/analysis          publish AI analysis
 *   GET  /api/terminal/state    institutional macro/COT/volume state (KV only)
 *   GET  /api/macro/status      sync health + cron job registry
 *   POST /api/macro/refresh     force CFTC + futures refresh (optional MACRO_REFRESH_TOKEN)
 *   GET  /api/finviz?code=GC    Finviz COT chart proxy (image)
 *   GET  /api/health
 *
 * State: Cloudflare KV namespace bound as AI_STATE.
 * Manual docs: fetched live from the Pages site and HTML-stripped.
 *
 * Cron: every 5 minutes → runScheduled() decides the Friday release window,
 * daily integrity sync and hourly futures volume/OI sync from staleness.
 */
import {
  FINVIZ_CODES,
} from "./lib/instruments.js";
import {
  CHART_INTERVALS,
  CHART_RANGES,
  bootstrapIfStale,
  buildTerminalState,
  chartSeries,
  finvizImage,
  readStatus,
  runScheduled,
  syncCOT,
  syncVolumeOi,
} from "./lib/pipeline.js";
import {
  formatSignal,
  formatStrategy,
  getStrategy,
  listSignals,
  listStrategies,
  readPerformance,
  recordPerformance,
  retireStrategy,
  setSignalStatus,
  submitSignal,
  upsertStrategy,
} from "./lib/trading.js";

const FINVIZ_PERIODS = new Set(["d1", "w1", "m1"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    /* ================= MCP over HTTP ================= */
    if (path === "/mcp") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "POST only" }, 405);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonRpcError(null, -32700, "Parse error");
      }

      // Stateless: respond to every request independently (no session storage)
      const { jsonrpc = "2.0", id, method, params = {} } = body;

      /* initialize */
      if (method === "initialize") {
        return jsonResponse({
          jsonrpc,
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {
              tools: { listChanged: true },
            },
            serverInfo: { name: "trading-llc-site", version: "2.0.0" },
          },
        });
      }

      /* initialized notification (no response needed, but return empty ok) */
      if (method === "notifications/initialized") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      /* tools/list */
      if (method === "tools/list") {
        return jsonResponse({
          jsonrpc,
          id,
          result: {
            tools: [
              {
                name: "get_manual_index",
                title: "Get manual index",
                description:
                  "List every document of the Trading LLC operating manual. Call this first.",
                inputSchema: {},
              },
              {
                name: "read_manual",
                title: "Read manual document",
                description:
                  "Read one operating-manual document by slug (e.g. \"01-overview\").",
                inputSchema: {
                  type: "object",
                  properties: {
                    slug: {
                      type: "string",
                      description: 'Document slug from get_manual_index, e.g. "01-overview"',
                    },
                  },
                  required: ["slug"],
                },
              },
              {
                name: "search_manual",
                title: "Search manual",
                description: "Full-text search across the operating manual.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      description: 'Search phrase, e.g. "circuit breaker"',
                    },
                  },
                  required: ["query"],
                },
              },
              {
                name: "get_company_code",
                title: "Get company code",
                description:
                  "Read the company code JSON: departments, roles, hierarchy, formulas, parameters.",
                inputSchema: {},
              },
              {
                name: "publish_analysis",
                title: "Publish analysis",
                description:
                  "Publish trading analysis to the site. The landing page shows it in \"Published analysis\".",
                inputSchema: {
                  type: "object",
                  properties: {
                    regime: {
                      type: "string",
                      description: 'reflation | disinflation | stagflation | goldilocks | risk-off',
                    },
                    summary: {
                      type: "string",
                      description: "2-3 sentence executive summary",
                    },
                    confidence: {
                      type: "number",
                      minimum: 0,
                      maximum: 1,
                      description: "0-1 confidence in the call",
                    },
                    signals: {
                      type: "object",
                      properties: {
                        compositeFlag: { type: "string" },
                        cotZ: { type: "number" },
                        oiShock: { type: "string" },
                      },
                    },
                    decisions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          instrument: { type: "string" },
                          action: { type: "string" },
                          thesis: { type: "string" },
                          invalidation: { type: "string" },
                        },
                        required: ["instrument", "action"],
                      },
                    },
                    source: { type: "string" },
                    rebuild: { type: "boolean" },
                  },
                },
              },
              {
                name: "get_latest_analysis",
                title: "Get latest analysis",
                description: "Read the most recent analysis published to the site.",
                inputSchema: {},
              },
              {
                name: "register_strategy",
                title: "Register a strategy",
                description:
                  "Publish a strategy manifest to the execution desk. The strategy is stored disabled: the account " +
                  "owner must enable it (and optionally auto-execution) in the site's Execution page before it can trade. " +
                  "Conditions (each needs its fields): ema_cross/sma_cross {fast,slow,direction}, price_vs_ema/price_vs_sma " +
                  "{period,op}, rsi {period,op,value}, macd {fast,slow,period,direction}, breakout {lookback,side}, " +
                  "bollinger {period,mult,side}, atr_filter {period,min}, always. direction is up|down, op is " +
                  "above|below|cross_up|cross_down. Stops/targets: atr {mult}, pips {pips}, percent {pct}. " +
                  "direction=both needs entryLong+entryShort.",
                inputSchema: {
                  type: "object",
                  properties: {
                    strategy: {
                      type: "object",
                      description: "Strategy manifest (id, name, symbols, timeframe, entry/entryLong/entryShort, stop, target, risk).",
                    },
                    source: { type: "string", description: "Author label, e.g. claude-4" },
                  },
                  required: ["strategy"],
                },
              },
              {
                name: "list_strategies",
                title: "List strategies",
                description:
                  "List every published strategy with its measured success rate, profit factor, sample size and confidence.",
                inputSchema: {
                  type: "object",
                  properties: {
                    includeRetired: { type: "boolean", description: "Include retired strategies." },
                  },
                },
              },
              {
                name: "get_strategy",
                title: "Get one strategy",
                description: "Read a strategy manifest and its measured performance by id.",
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "string", description: 'Strategy id, e.g. "gold-ema-trend"' } },
                  required: ["id"],
                },
              },
              {
                name: "retire_strategy",
                title: "Retire a strategy",
                description: "Stop recommending a strategy. It stays readable but is marked retired and disabled.",
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
              },
              {
                name: "submit_signal",
                title: "Submit a trade signal",
                description:
                  "Queue a trade signal for the owner's MT5 desk. It appears in the signal queue and never executes " +
                  "unless the owner approves it, or the strategy is enabled with auto-execution and the kill switch is off.",
                inputSchema: {
                  type: "object",
                  properties: {
                    strategyId: { type: "string", description: "Id of a registered strategy." },
                    symbol: { type: "string", description: "Broker symbol, e.g. XAUUSD" },
                    side: { type: "string", enum: ["buy", "sell"] },
                    entry: { type: "number", description: "Optional limit price; omit for market." },
                    sl: { type: "number", description: "Stop loss price." },
                    tp: { type: "number", description: "Take profit price." },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    note: { type: "string", description: "Why this signal exists (max 400 chars)." },
                  },
                  required: ["strategyId", "symbol", "side"],
                },
              },
              {
                name: "list_signals",
                title: "List signals",
                description: "Read the signal queue, optionally filtered by status (pending, executed, rejected).",
                inputSchema: {
                  type: "object",
                  properties: {
                    status: {
                      type: "string",
                      enum: ["pending", "approved", "executed", "rejected", "expired", "cancelled"],
                    },
                    limit: { type: "integer", minimum: 1, maximum: 200 },
                  },
                },
              },
              {
                name: "get_performance",
                title: "Get measured performance",
                description:
                  "Read the success-rate table measured by the execution bridge (backtest or live evidence).",
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "string", description: "Optional strategy id." } },
                },
              },
              {
                name: "record_performance",
                title: "Record measured performance",
                description:
                  "Publish measured results for strategies. Intended for the execution bridge; numbers must be measured, never invented.",
                inputSchema: {
                  type: "object",
                  properties: {
                    generatedAt: { type: "string" },
                    mode: { type: "string", description: "live | simulation" },
                    strategies: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          successRate: { type: "number" },
                          profitFactor: { type: "number" },
                          score: { type: "number" },
                          trades: { type: "integer" },
                          confidence: { type: "string" },
                          evidence: { type: "string" },
                        },
                        required: ["id", "successRate", "trades"],
                      },
                    },
                    overall: { type: "object" },
                  },
                  required: ["strategies"],
                },
              },
            ],
          },
        });
      }

      /* tools/call */
      if (method === "tools/call") {
        const { name, arguments: args = {} } = params;
        try {
          let resultText;
          switch (name) {
            case "get_manual_index":
              resultText = await getManualIndex(env, request);
              break;
            case "read_manual":
              resultText = await readManual(env, args.slug, request);
              break;
            case "search_manual":
              resultText = await searchManual(env, args.query, request);
              break;
            case "get_company_code":
              resultText = await getCompanyCode(env, request);
              break;
            case "publish_analysis":
              resultText = await publishAnalysis(env, args);
              break;
            case "get_latest_analysis":
              resultText = await getLatestAnalysis(env);
              break;
            case "register_strategy": {
              const registered = await upsertStrategy(env, args.strategy ?? args, {
                source: args.source ?? "ai",
              });
              resultText = registered.ok
                ? `Registered ${registered.strategy.id} (${registered.created ? 'new' : 'updated'}).\n` +
                  formatStrategy(registered.strategy) +
                  "\nIt is disabled until the account owner enables it in the Execution page."
                : `Strategy rejected:\n- ${registered.errors.join('\n- ')}`;
              break;
            }
            case "list_strategies": {
              const strategies = await listStrategies(env, {
                includeRetired: args.includeRetired === true,
              });
              resultText = strategies.length
                ? strategies.map(formatStrategy).join("\n\n")
                : "No strategies published yet. Use register_strategy.";
              break;
            }
            case "get_strategy": {
              const strategy = await getStrategy(env, args.id);
              resultText = strategy
                ? formatStrategy(strategy)
                : `No strategy with id "${args.id}".`;
              break;
            }
            case "retire_strategy": {
              const retired = await retireStrategy(env, args.id);
              resultText = retired.ok
                ? `Retired ${retired.strategy.id}. It is disabled and hidden from the default list.`
                : retired.error;
              break;
            }
            case "submit_signal": {
              const queued = await submitSignal(env, args);
              resultText = queued.ok
                ? `Signal queued for the owner's desk:\n${formatSignal(queued.signal)}`
                : `Signal rejected: ${queued.error}`;
              break;
            }
            case "list_signals": {
              const signals = await listSignals(env, {
                status: args.status ?? null,
                limit: Math.min(Number(args.limit) || 25, 200),
              });
              resultText = signals.length
                ? signals.map(formatSignal).join("\n\n")
                : "No signals in the queue.";
              break;
            }
            case "get_performance": {
              const snapshot = await readPerformance(env);
              if (args.id) {
                const row = snapshot.byId?.[args.id];
                resultText = row
                  ? JSON.stringify(row, null, 2)
                  : `No measured performance for "${args.id}" yet.`;
              } else {
                resultText = snapshot.generatedAt
                  ? "Measured performance (from the execution bridge):\n" +
                    Object.values(snapshot.byId ?? {})
                      .map(
                        (row) =>
                          `${row.id}: success ${row.successRate}% · PF ${row.profitFactor ?? 'n/a'} · ` +
                          `${row.trades} trades · score ${row.score} · ${row.confidence} (${row.evidence})`,
                      )
                      .join("\n") +
                    `\nmode=${snapshot.mode} generatedAt=${snapshot.generatedAt}`
                  : "No performance reported yet. Connect the MT5 bridge and run a backtest.";
              }
              break;
            }
            case "record_performance": {
              const stored = await recordPerformance(env, args);
              resultText = stored.ok
                ? `Stored performance for ${Object.keys(stored.performance.byId).length} strategies.`
                : `Rejected: ${stored.error}`;
              break;
            }
            default:
              return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
          }
          return jsonResponse({
            jsonrpc,
            id,
            result: { content: [{ type: "text", text: resultText }] },
          });
        } catch (err) {
          return jsonRpcError(
            id,
            -32603,
            `Internal error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      return jsonRpcError(id, -32601, `Unknown method: ${method}`);
    }

    /* ================= REST API ================= */
    if (path === "/api/analysis") {
      if (request.method === "GET") {
        const state = await readState(env);
        return jsonResponse(state);
      }
      if (request.method === "POST") {
        let args;
        try {
          args = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        const message = await publishAnalysis(env, args);
        return jsonResponse({ ok: true, message });
      }
      return new Response(null, { status: 405, headers: corsHeaders() });
    }

    /* ================= STRATEGY REGISTRY / SIGNALS / PERFORMANCE ================= */
    if (path === "/api/strategies") {
      if (request.method === "GET") {
        const includeRetired = url.searchParams.get("includeRetired") === "1";
        return jsonResponse({
          strategies: await listStrategies(env, { includeRetired }),
        });
      }
      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        const raw = body.strategy ?? body;
        const result = await upsertStrategy(env, raw, { source: body.source ?? "ai" });
        if (!result.ok) return jsonResponse({ error: "invalid strategy", errors: result.errors }, 400);
        return jsonResponse(
          { ok: true, created: result.created, strategy: result.strategy },
          result.created ? 201 : 200,
        );
      }
      return new Response(null, { status: 405, headers: corsHeaders() });
    }

    const strategyMatch = path.match(/^\/api\/strategies\/([A-Za-z0-9._-]{2,64})$/);
    if (strategyMatch) {
      const id = strategyMatch[1];
      if (request.method === "GET") {
        const strategy = await getStrategy(env, id);
        return strategy
          ? jsonResponse({ strategy })
          : jsonResponse({ error: "strategy not found" }, 404);
      }
      if (request.method === "DELETE") {
        const result = await retireStrategy(env, id);
        return result.ok
          ? jsonResponse({ ok: true, strategy: result.strategy })
          : jsonResponse({ error: result.error }, 404);
      }
      return new Response(null, { status: 405, headers: corsHeaders() });
    }

    if (path === "/api/signals") {
      if (request.method === "GET") {
        const status = url.searchParams.get("status");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
        const signals = await listSignals(env, { status, limit });
        return jsonResponse({ signals, count: signals.length, status: status ?? "all" });
      }
      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        const result = await submitSignal(env, body.signal ?? body);
        if (!result.ok) return jsonResponse({ error: result.error }, 400);
        return jsonResponse({ ok: true, signal: result.signal }, 201);
      }
      return new Response(null, { status: 405, headers: corsHeaders() });
    }

    const signalMatch = path.match(/^\/api\/signals\/([A-Za-z0-9._-]{2,64})\/status$/);
    if (signalMatch) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: corsHeaders() });
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }
      const result = await setSignalStatus(env, signalMatch[1], body.status, {
        note: body.note,
        ticket: body.ticket,
        actor: body.actor,
      });
      return result.ok
        ? jsonResponse({ ok: true, signal: result.signal })
        : jsonResponse({ error: result.error }, 400);
    }

    const signalGet = path.match(/^\/api\/signals\/([A-Za-z0-9._-]{2,64})$/);
    if (signalGet && request.method === "GET") {
      const signal = (await listSignals(env, { limit: 500 })).find((s) => s.id === signalGet[1]);
      return signal ? jsonResponse({ signal }) : jsonResponse({ error: "signal not found" }, 404);
    }

    if (path === "/api/performance") {
      if (request.method === "GET") {
        const snapshot = await readPerformance(env);
        if (url.searchParams.get("id")) {
          const row = snapshot.byId?.[url.searchParams.get("id")];
          return row ? jsonResponse({ performance: row }) : jsonResponse({ error: "no data" }, 404);
        }
        return jsonResponse(snapshot);
      }
      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        const result = await recordPerformance(env, body);
        return result.ok
          ? jsonResponse({ ok: true, count: Object.keys(result.performance.byId).length })
          : jsonResponse({ error: result.error }, 400);
      }
      return new Response(null, { status: 405, headers: corsHeaders() });
    }

    if (path === "/api/health") {
      return jsonResponse({ ok: true, service: "trading-llc-mcp" });
    }

    /* ================= INSTITUTIONAL MACRO TERMINAL ================= */
    if (path === "/api/terminal/state") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: corsHeaders() });
      try {
        const bootstrap = await bootstrapIfStale(env, ctx);
        const state = await buildTerminalState(env);
        return jsonResponse({ ...state, bootstrap });
      } catch (err) {
        return jsonResponse(
          { error: "state assembly failed", detail: String(err?.message ?? err) },
          500,
        );
      }
    }

    if (path === "/api/macro/status") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: corsHeaders() });
      try {
        return jsonResponse(await readStatus(env));
      } catch (err) {
        return jsonResponse({ error: String(err?.message ?? err) }, 500);
      }
    }

    if (path === "/api/macro/refresh") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: corsHeaders() });
      const expected = env.MACRO_REFRESH_TOKEN;
      if (expected) {
        const got = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (got !== expected) return jsonResponse({ error: "unauthorized" }, 401);
      }
      const results = { cot: await syncCOT(env), volume: await syncVolumeOi(env) };
      return jsonResponse({ ok: true, ...results });
    }

    if (path === "/api/finviz") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: corsHeaders() });
      const code = (url.searchParams.get("code") ?? "GC").toUpperCase();
      const period = (url.searchParams.get("p") ?? "w1").toLowerCase();
      if (!FINVIZ_CODES.has(code)) {
        return jsonResponse({ error: "unknown finviz code", allowed: [...FINVIZ_CODES] }, 400);
      }
      if (!FINVIZ_PERIODS.has(period)) {
        return jsonResponse({ error: "invalid period", allowed: [...FINVIZ_PERIODS] }, 400);
      }
      const img = await finvizImage(code, period);
      if (!img.ok) {
        return jsonResponse(
          { error: img.error, detail: "Finviz rejected the request; retrying next sync cycle." },
          502,
        );
      }
      return new Response(img.body, {
        headers: {
          ...corsHeaders(),
          "content-type": img.type,
          "cache-control": "public, max-age=300",
        },
      });
    }

    if (path === "/api/chart") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: corsHeaders() });
      const id = (url.searchParams.get("id") ?? "gold").toLowerCase();
      const range = (url.searchParams.get("range") ?? "5d").toLowerCase();
      const interval = (url.searchParams.get("interval") ?? "15m").toLowerCase();
      if (!CHART_RANGES.has(range)) {
        return jsonResponse({ error: "invalid range", allowed: [...CHART_RANGES] }, 400);
      }
      if (!CHART_INTERVALS.has(interval)) {
        return jsonResponse({ error: "invalid interval", allowed: [...CHART_INTERVALS] }, 400);
      }
      try {
        const series = await chartSeries(id, range, interval);
        if (!series) return jsonResponse({ error: "no chart data for instrument", id }, 502);
        return new Response(JSON.stringify(series), {
          headers: {
            ...corsHeaders(),
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=60",
          },
        });
      } catch (err) {
        return jsonResponse({ error: String(err?.message ?? err) }, 502);
      }
    }

    return new Response(null, { status: 404, headers: corsHeaders() });
  },

  /** Cloudflare Cron Trigger: every 5 minutes. */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduled(env).catch(() => {}));
  },
};

/* ================= helpers ================= */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "content-type": "application/json" },
  });
}

function jsonRpcError(id, code, message) {
  return jsonResponse(
    { jsonrpc: "2.0", id, error: { code, message } },
    200 // MCP errors are returned with HTTP 200 per spec
  );
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
  };
}

/* ================= KV state ================= */

async function readState(env) {
  if (!env?.AI_STATE) {
    return {
      version: 1,
      generatedAt: null,
      source: null,
      summary: "MCP worker not configured — bind AI_STATE KV namespace in wrangler.toml",
      regime: null,
      confidence: null,
      signals: { compositeFlag: null, cotZ: null, oiShock: null },
      decisions: [],
    };
  }
  const raw = await env.AI_STATE.get("ai-state");
  if (!raw) {
    return {
      version: 1,
      generatedAt: null,
      source: null,
      summary: "",
      regime: null,
      confidence: null,
      signals: { compositeFlag: null, cotZ: null, oiShock: null },
      decisions: [],
    };
  }
  return JSON.parse(raw);
}

async function writeState(env, state) {
  if (!env?.AI_STATE) {
    throw new Error("AI_STATE KV namespace not bound");
  }
  await env.AI_STATE.put("ai-state", JSON.stringify(state, null, 2));
}

/* ================= tools ================= */

const DEFAULT_PAGES_ORIGIN = "https://vaelor.pages.dev";

/** Site origin comes from wrangler.toml [vars] PAGES_ORIGIN, with a safe fallback. */
function pagesOrigin(env) {
  const origin = (env && env.PAGES_ORIGIN) || DEFAULT_PAGES_ORIGIN;
  return String(origin).replace(/\/+$/, "");
}

const DOC_SLUGS = [
  "01-overview",
  "02-governance",
  "03-roles",
  "04-workflows",
  "05-market-structure",
  "06-incident-response",
  "07-payload-library",
  "08-configuration",
];

async function getManualIndex(env, request) {
  const origin = pagesOrigin(env);
  const lines = DOC_SLUGS.map((s) => `- ${s} → ${origin}/docs/${s}`);
  lines.push("- company-code → " + origin + "/docs/company-code");
  return "Trading LLC manual documents:\n" + lines.join("\n");
}

async function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageText(env, slug) {
  const url = `${pagesOrigin(env)}/docs/${slug}`;
  const res = await fetch(url, { headers: { "accept": "text/html" } });
  if (!res.ok) throw new Error(`Document not found: ${slug} (HTTP ${res.status})`);
  const html = await res.text();
  return stripHtml(html);
}

async function readManual(env, slug, request) {
  const safe = String(slug).replace(/\.md$/i, "").replace(/[^a-z0-9-]/gi, "");
  const text = await fetchPageText(env, safe);
  return text || `(empty document: ${safe})`;
}

async function searchManual(env, query, request) {
  const q = String(query).toLowerCase();
  const hits = [];
  for (const slug of DOC_SLUGS) {
    try {
      const text = await fetchPageText(env, slug);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          hits.push(`${slug}:${i + 1}: ${lines[i].trim()}`);
          if (hits.length >= 30) break;
        }
      }
    } catch {
      // skip docs that 404
    }
    if (hits.length >= 30) break;
  }
  // also search company code
  try {
    const ccText = await fetchPageText("company-code", request);
    const lines = ccText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        hits.push(`company-code:${i + 1}: ${lines[i].trim()}`);
        if (hits.length >= 30) break;
      }
    }
  } catch {}
  return hits.length
    ? hits.join("\n")
    : `No matches for "${query}".`;
}

async function getCompanyCode(env, request) {
  return fetchPageText(env, "company-code");
}

async function publishAnalysis(env, args) {
  const state = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: args.source ?? "ai",
    summary: args.summary ?? "",
    regime: args.regime ?? null,
    confidence: args.confidence ?? null,
    signals: {
      compositeFlag: args.signals?.compositeFlag ?? null,
      cotZ: args.signals?.cotZ ?? null,
      oiShock: args.signals?.oiShock ?? null,
    },
    decisions: (args.decisions ?? []).map((d) => ({
      instrument: d.instrument,
      action: d.action,
      thesis: d.thesis ?? "",
      invalidation: d.invalidation ?? "",
    })),
  };
  await writeState(env, state);
  return `Published to KV. regime=${state.regime ?? "—"} flag=${state.signals.compositeFlag ?? "—"} decisions=${state.decisions.length}`;
}

async function getLatestAnalysis(env) {
  const s = await readState(env);
  if (!s.generatedAt) {
    return "No analysis published yet. Use publish_analysis.";
  }
  return JSON.stringify(s, null, 2);
}

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

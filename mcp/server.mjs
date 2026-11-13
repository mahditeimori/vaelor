#!/usr/bin/env node
/**
 * Trading LLC — MCP server with TWO transports:
 *
 *   node mcp/server.mjs            → stdio   (classic local config: Claude Desktop developer JSON, Gemini CLI, etc.)
 *   node mcp/server.mjs --http     → HTTP    (plain URL, no config-file editing: Claude Connectors UI + many AIs)
 *                                    http://127.0.0.1:8890/mcp
 *   optional: --port 8890
 *
 * Tools (same on both transports):
 *   get_manual_index · read_manual · search_manual · get_company_code
 *   publish_analysis · get_latest_analysis
 *   register_strategy · list_strategies · get_strategy · retire_strategy
 *   submit_signal · list_signals · get_performance · record_performance
 *
 * Trading tools talk to the Vaelor Worker (strategy registry + signal queue),
 * which the local MT5 bridge then pulls from. Set VAELOR_API to override the
 * Worker URL, and VAELOR_TOKEN if the deployment ever requires a bearer token.
 *
 * In HTTP mode every request is handled statelessly (no session storage),
 * which is what URL-based MCP clients (Claude custom connectors, ChatGPT,
 * Gemini, Muse, ...) expect.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = path.join(ROOT, 'src', 'content', 'docs');
const STATE_FILE = path.join(ROOT, 'src', 'data', 'ai-state.json');
const COMPANY_CODE = path.join(ROOT, 'src', 'data', 'company_code.json');

const SERVER_INFO = { name: 'trading-llc-site', version: '1.1.0' };

/* ================= trading registry (Worker-backed) ================= */

const VAELOR_API = (process.env.VAELOR_API || 'https://trading-llc-mcp.mahdi-t8256.workers.dev').replace(/\/+$/, '');

async function api(pathname, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (process.env.VAELOR_TOKEN) headers.authorization = `Bearer ${process.env.VAELOR_TOKEN}`;
  let response;
  try {
    response = await fetch(`${VAELOR_API}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(
      `Cannot reach the Vaelor registry at ${VAELOR_API} (${err?.message ?? err}). ` +
        'Check the network or set VAELOR_API.',
    );
  }
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const detail = payload?.errors?.join('; ') || payload?.error || payload?.detail || response.statusText;
    throw new Error(`${response.status} ${detail}`);
  }
  return payload;
}

/* ================= helpers ================= */

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function listDocs() {
  return fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')).sort();
}

function text(message) {
  return { content: [{ type: 'text', text: message }] };
}

const decisionSchema = z.object({
  instrument: z.string().describe('e.g. GC, DX, ES'),
  action: z.enum(['watch', 'prepare', 'execute', 'hold', 'avoid']).describe('Recommended stance'),
  thesis: z.string().optional().describe('One-line reasoning'),
  invalidation: z.string().optional().describe('What kills this thesis'),
});

function publishAnalysis(args) {
  const state = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: args.source ?? 'ai',
    summary: args.summary ?? '',
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
      thesis: d.thesis ?? '',
      invalidation: d.invalidation ?? '',
    })),
  };

  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, STATE_FILE);

  let rebuilt = false;
  if (args.rebuild === true) {
    const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawn(bin, ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    rebuilt = res.status === 0;
  }

  return text(
    `Published to ${path.relative(ROOT, STATE_FILE)}.\n` +
      `regime=${state.regime ?? '—'} flag=${state.signals.compositeFlag ?? '—'} decisions=${state.decisions.length}\n` +
      (rebuilt
        ? 'Static site rebuilt. Refresh the browser to see it.'
        : 'Dev server (npm run dev) picks this up live; for a static deploy run `npm run build`.'),
  );
}

/* ================= tool registration (shared by both transports) ================= */

function createServer() {
  const server = new McpServer(SERVER_INFO);

  server.registerTool('get_manual_index', {
    title: 'Get manual index',
    description: 'List every document of the Trading LLC operating manual. Call this first to see what can be read.',
    inputSchema: {},
  }, async () => text(
    'Trading LLC manual documents:\n' +
    listDocs().map((f) => `- ${f} → /docs/${f.replace(/\.md$/, '')}`).join('\n') +
    '\n\nPlus: /docs/company-code (company code model), /dashboard (mock market terminal).',
  ));

  server.registerTool('read_manual', {
    title: 'Read manual document',
    description: 'Read one operating-manual document by file name. This is the source knowledge the AI learns from.',
    inputSchema: { file: z.string().describe('File name from get_manual_index, e.g. 01-overview.md') },
  }, async ({ file }) => {
    const safe = path.basename(String(file));
    const full = path.join(DOCS_DIR, safe);
    if (!fs.existsSync(full)) return text(`Unknown document: ${safe}. Call get_manual_index first.`);
    return text(fs.readFileSync(full, 'utf-8'));
  });

  server.registerTool('search_manual', {
    title: 'Search manual',
    description: 'Full-text search across the operating manual. Returns matching lines with their documents.',
    inputSchema: { query: z.string().describe('Search phrase, e.g. "circuit breaker" or "COT z-score"') },
  }, async ({ query }) => {
    const q = String(query).toLowerCase();
    const hits = [];
    for (const f of listDocs()) {
      const lines = fs.readFileSync(path.join(DOCS_DIR, f), 'utf-8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(q)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    return text(hits.length ? hits.slice(0, 30).join('\n') : `No matches for "${query}".`);
  });

  server.registerTool('get_company_code', {
    title: 'Get company code',
    description: 'Read the full company code JSON: departments, roles, hierarchy, formulas, workflows, parameters.',
    inputSchema: {},
  }, async () => text(JSON.stringify(readJson(COMPANY_CODE), null, 2)));

  server.registerTool('publish_analysis', {
    title: 'Publish analysis',
    description:
      'Publish the AI trading analysis to the website. The landing page displays it in the "Published analysis" section. ' +
      'Call this after reading/training on the manual. Set rebuild=true only when serving the static build.',
    inputSchema: {
      regime: z.string().optional().describe('reflation | disinflation | stagflation | goldilocks | risk-off'),
      summary: z.string().optional().describe('2-3 sentence executive summary'),
      confidence: z.number().min(0).max(1).optional().describe('0-1 confidence in the call'),
      signals: z.object({
        compositeFlag: z.string().optional().describe('Aligned | Watch | None'),
        cotZ: z.number().optional(),
        oiShock: z.string().optional(),
      }).optional(),
      decisions: z.array(decisionSchema).optional(),
      source: z.string().optional().describe('Author label, e.g. "claude-4"'),
      rebuild: z.boolean().optional().describe('Run `npm run build` after writing (for static hosting)'),
    },
  }, async (args) => publishAnalysis(args));

  server.registerTool('get_latest_analysis', {
    title: 'Get latest analysis',
    description: 'Read the most recent analysis published to the site (or a notice if none exists).',
    inputSchema: {},
  }, async () => {
    const s = readJson(STATE_FILE);
    return s.generatedAt ? text(JSON.stringify(s, null, 2)) : text('No analysis published yet. Use publish_analysis.');
  });

  /* ---- strategy registry ---- */

  server.registerTool('register_strategy', {
    title: 'Register a strategy',
    description:
      'Publish a strategy manifest to the execution desk. It is stored disabled: the account owner must enable it ' +
      '(and optionally auto-execution) in the Execution page before it can trade. Conditions (each needs its fields): ' +
      'ema_cross/sma_cross {fast,slow,direction}, price_vs_ema/price_vs_sma {period,op}, rsi {period,op,value}, ' +
      'macd {fast,slow,period,direction}, breakout {lookback,side}, bollinger {period,mult,side}, atr_filter {period,min}, ' +
      'always. direction is up|down, op is above|below|cross_up|cross_down. Stops/targets: atr {mult}, pips {pips}, ' +
      'percent {pct}. direction=both needs entryLong+entryShort.',
    inputSchema: {
      strategy: z.any().describe('Strategy manifest object'),
      source: z.string().optional().describe('Author label, e.g. claude-4'),
    },
  }, async ({ strategy, source }) => {
    const result = await api('/api/strategies', { method: 'POST', body: { strategy, source } });
    return text(
      `Registered ${result.strategy.id} (${result.created ? 'new' : 'updated'}).\n` +
        `state: disabled until the owner enables it in the Execution page\n` +
        `symbols: ${result.strategy.symbols.join(', ')} · ${result.strategy.timeframe} · ${result.strategy.direction}`,
    );
  });

  server.registerTool('list_strategies', {
    title: 'List strategies',
    description: 'List published strategies with their measured success rate, profit factor, sample size and confidence.',
    inputSchema: {
      includeRetired: z.boolean().optional().describe('Include retired strategies'),
    },
  }, async ({ includeRetired }) => {
    const { strategies } = await api(`/api/strategies${includeRetired ? '?includeRetired=1' : ''}`);
    if (!strategies.length) return text('No strategies published yet. Use register_strategy.');
    return text(
      strategies
        .map((s) => {
          const p = s.performance;
          return (
            `${s.id} — ${s.name}\n` +
            `  author ${s.author} · ${s.symbols.join(', ')} · ${s.timeframe} · ${s.direction}` +
            `${s.retired ? ' · RETIRED' : ''}\n` +
            `  trigger locally: ${s.enabled ? 'enabled' : 'disabled'} · autoExecute: ${s.autoExecute ? 'on' : 'off'}\n` +
            `  performance: ` +
            (p
              ? `success ${p.successRate}% · PF ${p.profitFactor ?? 'n/a'} · ${p.trades} trades · ${p.confidence} (${p.evidence})`
              : 'not measured yet')
          );
        })
        .join('\n\n'),
    );
  });

  server.registerTool('get_strategy', {
    title: 'Get one strategy',
    description: 'Read a strategy manifest and its measured performance by id.',
    inputSchema: { id: z.string().describe('Strategy id, e.g. gold-ema-trend') },
  }, async ({ id }) => {
    const { strategy } = await api(`/api/strategies/${encodeURIComponent(id)}`);
    return text(JSON.stringify(strategy, null, 2));
  });

  server.registerTool('retire_strategy', {
    title: 'Retire a strategy',
    description: 'Stop recommending a strategy. It stays readable, is marked retired and cannot trade.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const { strategy } = await api(`/api/strategies/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return text(`Retired ${strategy.id}. It is disabled and hidden from the default list.`);
  });

  /* ---- signals ---- */

  server.registerTool('submit_signal', {
    title: 'Submit a trade signal',
    description:
      "Queue a trade signal for the owner's MT5 desk. Nothing executes unless the owner approves it, or the strategy " +
      'is enabled with auto-execution and the kill switch is off.',
    inputSchema: {
      strategyId: z.string(),
      symbol: z.string().describe('Broker symbol, e.g. XAUUSD'),
      side: z.enum(['buy', 'sell']),
      entry: z.number().optional().describe('Limit price; omit for market'),
      sl: z.number().optional(),
      tp: z.number().optional(),
      confidence: z.number().min(0).max(1).optional(),
      note: z.string().optional(),
    },
  }, async (args) => {
    const { signal } = await api('/api/signals', { method: 'POST', body: args });
    return text(
      `Signal queued: ${signal.id}\n` +
        `  ${signal.side.toUpperCase()} ${signal.symbol} · ${signal.strategyId} · entry ${signal.entry ?? 'market'}\n` +
        `  sl ${signal.sl ?? '—'} · tp ${signal.tp ?? '—'} · confidence ${signal.confidence ?? '—'}`,
    );
  });

  server.registerTool('list_signals', {
    title: 'List signals',
    description: 'Read the signal queue, optionally filtered by status.',
    inputSchema: {
      status: z.enum(['pending', 'approved', 'executed', 'rejected', 'expired', 'cancelled']).optional(),
      limit: z.number().min(1).max(200).optional(),
    },
  }, async ({ status, limit }) => {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (limit) query.set('limit', String(limit));
    const { signals } = await api(`/api/signals${query.size ? `?${query}` : ''}`);
    if (!signals.length) return text('No signals in the queue.');
    return text(
      signals
        .map(
          (s) =>
            `${s.id} [${s.status}] ${s.side.toUpperCase()} ${s.symbol} · ${s.strategyId}\n` +
            `  entry ${s.entry ?? 'market'} · sl ${s.sl ?? '—'} · tp ${s.tp ?? '—'} · ${s.createdAt}` +
            (s.decisionNote ? `\n  decision: ${s.decisionNote}` : ''),
        )
        .join('\n\n'),
    );
  });

  /* ---- performance ---- */

  server.registerTool('get_performance', {
    title: 'Get measured performance',
    description: 'Read the success-rate table measured by the execution bridge (backtest or live evidence).',
    inputSchema: { id: z.string().optional() },
  }, async ({ id }) => {
    const snapshot = await api('/api/performance');
    if (id) {
      const row = snapshot.byId?.[id];
      return text(row ? JSON.stringify(row, null, 2) : `No measured performance for "${id}" yet.`);
    }
    const rows = Object.values(snapshot.byId ?? {});
    if (!rows.length) return text('No performance reported yet. Connect the MT5 bridge and run a backtest.');
    return text(
      'Measured performance (from the execution bridge):\n' +
        rows
          .map(
            (r) =>
              `${r.id}: success ${r.successRate}% · PF ${r.profitFactor ?? 'n/a'} · ${r.trades} trades · ` +
              `score ${r.score} · ${r.confidence} (${r.evidence})`,
          )
          .join('\n') +
        `\nmode=${snapshot.mode} generatedAt=${snapshot.generatedAt}`,
    );
  });

  server.registerTool('record_performance', {
    title: 'Record measured performance',
    description:
      'Publish measured results. Intended for the execution bridge: numbers must be measured, never invented.',
    inputSchema: {
      generatedAt: z.string().optional(),
      mode: z.string().optional(),
      strategies: z.array(z.any()).describe('Rows: {id, successRate, profitFactor, score, trades, confidence, evidence}'),
      overall: z.any().optional(),
    },
  }, async (args) => {
    const result = await api('/api/performance', { method: 'POST', body: args });
    return text(`Stored performance for ${result.count} strategies.`);
  });

  return server;
}

/* ================= stdio transport (default) ================= */

async function runStdio() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write('[trading-llc-site] MCP server ready on stdio\n');
}

/* ================= streamable HTTP transport (--http) ================= */

async function runHttp(port) {
  const httpServer = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, mcp-session-id, mcp-protocol-version, authorization',
    };
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (url.pathname !== '/mcp') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'use /mcp' })); return; }

    // GET streams (server->client SSE) are not supported in stateless mode
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(405); res.end(); return; }

    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    // read JSON body
    let body;
    try {
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
        req.on('error', reject);
      });
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    // stateless: a fresh server+transport per request (no session storage)
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // stateless
      enableJsonResponse: true,        // plain JSON responses (easy for every client)
    });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      process.stderr.write(`[trading-llc-site] request error: ${(err && err.message) || err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } }));
      }
    }
  });

  httpServer.listen(port, '127.0.0.1', () => {
    process.stderr.write(`[trading-llc-site] MCP HTTP server ready → http://127.0.0.1:${port}/mcp\n`);
    process.stderr.write('[trading-llc-site] Put that URL into any AI connector that accepts an MCP server URL.\n');
  });
}

/* ================= entry ================= */

const args = process.argv.slice(2);
const httpMode = args.includes('--http');
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) || 8890 : 8890;

if (httpMode) await runHttp(port);
else await runStdio();
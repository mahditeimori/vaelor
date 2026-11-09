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
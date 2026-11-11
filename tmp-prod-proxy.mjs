/**
 * One-off verification proxy: serves the LIVE production Pages build
 * (fetched through the machine proxy) at http://127.0.0.1:3101 and
 * points its data-api at the same origin so /api/* is proxied to the Worker.
 * Temporary test scaffolding only.
 */
import { createServer } from 'node:http';

const SITE = 'https://vaelor.pages.dev';
const WORKER = 'https://trading-llc-mcp.mahdi-t8256.workers.dev';
const PORT = 3101;
const cache = new Map();

async function fetchWithRetry(url, accept, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, {
        headers: { accept: accept ?? '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const isApi = url.pathname.startsWith('/api/');
  const target = (isApi ? WORKER : SITE) + url.pathname + url.search;

  if (!isApi && cache.has(target)) {
    const hit = cache.get(target);
    res.writeHead(hit.status, { 'content-type': hit.type, 'cache-control': 'no-store' });
    res.end(hit.body);
    return;
  }

  try {
    const upstream = await fetchWithRetry(target, req.headers.accept);
    let body = Buffer.from(await upstream.arrayBuffer());
    let type = upstream.headers.get('content-type') ?? 'application/octet-stream';

    if (!isApi && type.includes('text/html')) {
      body = Buffer.from(
        body
          .toString('utf8')
          .replaceAll('data-api="https://trading-llc-mcp.mahdi-t8256.workers.dev"', 'data-api="http://127.0.0.1:3101"'),
        'utf8',
      );
    }

    if (!isApi && upstream.ok) cache.set(target, { status: upstream.status, type, body });

    res.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`prod-verify http://127.0.0.1:${PORT}/terminal/`);
});

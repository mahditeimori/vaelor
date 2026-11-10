/**
 * GET /api/finviz?code=GC&p=w1
 * Server-side proxy for Finviz futures COT charts. Sends browser headers to
 * bypass the upstream bot screen, caches images in memory for 5 minutes and
 * degrades to a 502 JSON note when the upstream blocks the request.
 */
import type { APIRoute } from 'astro';
import { FINVIZ_CODES } from '../../lib/instruments';

export const prerender = false;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ALLOWED_PERIODS = new Set(['d1', 'w1', 'm1']);
const TTL_MS = 5 * 60_000;

interface CacheEntry {
  at: number;
  type: string;
  buf: ArrayBuffer;
}

const memCache = new Map<string, CacheEntry>();

export const GET: APIRoute = async ({ url }) => {
  const code = (url.searchParams.get('code') ?? 'GC').toUpperCase();
  const period = (url.searchParams.get('p') ?? 'w1').toLowerCase();

  if (!FINVIZ_CODES.has(code)) {
    return new Response(
      JSON.stringify({ error: 'unknown finviz code', allowed: [...FINVIZ_CODES] }),
      { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }
  if (!ALLOWED_PERIODS.has(period)) {
    return new Response(JSON.stringify({ error: 'invalid period', allowed: ['d1', 'w1', 'm1'] }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const key = `${code}:${period}`;
  const cached = memCache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return new Response(cached.buf, {
      headers: { 'content-type': cached.type, 'cache-control': 'public, max-age=300' },
    });
  }

  const upstream = `https://finviz.com/futures_charts.ashx?t=${code}&p=${period}`;
  try {
    const res = await fetch(upstream, {
      headers: {
        'user-agent': UA,
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        referer: 'https://finviz.com/futures.ashx',
      },
      signal: AbortSignal.timeout(30_000),
    });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const buf = await res.arrayBuffer();

    // Upstream returned a challenge/HTML page instead of the PNG.
    if (!res.ok || !type.startsWith('image/')) {
      return new Response(
        JSON.stringify({
          error: 'finviz_upstream_blocked',
          detail: 'The upstream data source rejected the request from this network.',
          code,
          period,
        }),
        { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    memCache.set(key, { at: Date.now(), type, buf });
    if (memCache.size > 64) {
      const oldest = memCache.keys().next().value;
      if (oldest) memCache.delete(oldest);
    }
    return new Response(buf, {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=300' },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: 'finviz_fetch_failed',
        detail: String((e as Error)?.message ?? e),
        code,
        period,
      }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }
};

/**
 * GET /api/terminal/state
 * Aggregated macro/COT/volume-OI state for the terminal frontend.
 * Reads only local JSON caches (no network) — safe for 60-second polling.
 */
import type { APIRoute } from 'astro';
import { ensureScheduler } from '../../../lib/scheduler';
import { buildTerminalState } from '../../../lib/pipeline';

export const prerender = false;

export const GET: APIRoute = async () => {
  ensureScheduler();
  try {
    const state = await buildTerminalState();
    return new Response(JSON.stringify(state), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'state assembly failed', detail: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }
};

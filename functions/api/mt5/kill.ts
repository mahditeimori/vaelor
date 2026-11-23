/**
 * POST /api/mt5/kill — per-member MT5-connection kill switch (cloud record).
 *
 * This endpoint only stores the member's choice so the checkbox survives a
 * reload or another browser. A Cloudflare Function runs in Cloudflare's
 * network and cannot reach the member's `127.0.0.1` bridge, so the browser
 * itself calls the local bridge (`/api/kill-state` and `/api/shutdown`) after
 * this record is saved.
 */
import type { Handler } from '../auth/_lib';
import { fail, getSessionContext, json, readJson, sameOriginError } from '../auth/_lib';

interface KillToggleRequest {
  enabled?: boolean;
}

export const onRequestPost: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  const originError = sameOriginError(request, env);
  if (originError) return fail(403, originError);

  const payload: KillToggleRequest = (await readJson<KillToggleRequest>(request)) ?? {};
  const enabled = payload.enabled === true;

  await env.AUTH.put(
    `k:${context.user.id}`,
    JSON.stringify({ enabled, at: Date.now() }),
    { expirationTtl: 30 * 86400 },
  );

  return json({ ok: true, enabled });
};

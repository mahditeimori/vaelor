/**
 * GET /api/mt5/kill-state — read the per-member MT5-connection kill switch
 * (the record written by POST /api/mt5/kill).
 */
import type { Handler } from '../auth/_lib';
import { fail, getSessionContext, json } from '../auth/_lib';

interface KillStateRecord {
  enabled?: boolean;
}

export const onRequestGet: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  const record = await env.AUTH.get<KillStateRecord>(`k:${context.user.id}`, 'json');
  return json({ ok: true, enabled: record?.enabled === true });
};

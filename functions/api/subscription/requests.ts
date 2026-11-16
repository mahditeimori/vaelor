/**
 * GET /api/subscription/requests
 *
 * Owner-only. Lists pending upgrade requests that any signed-in member sent
 * from their own browser, so the console is no longer limited to the owner's
 * localStorage.
 */
import type { Handler } from '../auth/_lib';
import { fail, getSessionContext, isOwnerEmail, json } from '../auth/_lib';
import { REQUEST_INDEX, type UpgradeRequest } from './request';

export const onRequestGet: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  if (!isOwnerEmail(env, context.user.email)) return fail(403, 'not_owner', 'Owner access required.');

  const raw = await env.AUTH.get(REQUEST_INDEX, 'json');
  const index = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];

  const requests: UpgradeRequest[] = [];
  for (const id of index) {
    const record = await env.AUTH.get<UpgradeRequest>(`subreq:${id}`, 'json');
    if (!record) continue;
    if (record.status !== 'pending') continue;
    requests.push(record);
  }

  requests.sort((a, b) => b.at - a.at);
  return json({ ok: true, requests: requests.slice(0, 100) });
};

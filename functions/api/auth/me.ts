/**
 * GET /api/auth/me — the only identity authority the client trusts.
 *
 * 401 means "not signed in"; the client clears its local mirror only then.
 * Any other failure (network, 5xx) must leave local state untouched so a
 * temporary outage never logs a paying member out.
 */
import type { Handler } from './_lib';
import { authPayload, fail, getSessionContext, json } from './_lib';

export const onRequestGet: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  return json({ ok: true, ...authPayload(env, context.user, context.subscription) });
};

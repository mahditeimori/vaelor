/**
 * POST /api/subscription/grant — owner-only entitlement write.
 *
 * This is the only place a tier becomes real. `/api/auth/me` reads the record
 * written here, and every browser mirrors it on the next page load, so a grant
 * reaches the member no matter which machine the owner used.
 *
 * Body: { email | username, tier: 'operator' | 'desk' | 'free', days?, requestId? }
 */
import type { Handler } from '../auth/_lib';
import {
  fail,
  getSessionContext,
  getUser,
  isOwnerEmail,
  json,
  normaliseUsername,
  putSubscription,
  readJson,
  resolveEmail,
  sameOriginError,
  type SubscriptionRecord,
} from '../auth/_lib';
import { REQUEST_INDEX, type UpgradeRequest } from './request';

interface Body {
  email?: string;
  username?: string;
  tier?: string;
  days?: number;
  requestId?: string;
}

const MAX_DAYS = 3650;

export const onRequestPost: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  if (!isOwnerEmail(env, context.user.email)) return fail(403, 'not_owner', 'Owner access required.');
  const originError = sameOriginError(request, env);
  if (originError) return fail(403, originError);

  const body = await readJson<Body>(request);
  if (!body) return fail(400, 'bad_request', 'Expected a JSON body.');

  const identifier = (body.email ?? '').trim() || normaliseUsername(body.username ?? '');
  if (!identifier) return fail(400, 'member_missing', 'Provide the member email or username.');

  const email = await resolveEmail(env, identifier);
  if (!email) return fail(404, 'user_not_found', 'No member with that email or username.');

  const user = await getUser(env, email);
  if (!user) return fail(404, 'user_not_found', 'No member with that email or username.');

  const tier = body.tier;
  if (tier !== 'operator' && tier !== 'desk' && tier !== 'free') {
    return fail(400, 'tier_invalid', 'tier must be operator, desk or free.');
  }

  const now = Date.now();
  let subscription: SubscriptionRecord;
  if (tier === 'free') {
    subscription = { tier: 'free', status: 'canceled', startedAt: null, expiresAt: null };
  } else {
    const days = Math.min(Math.max(Math.round(Number(body.days) || 30), 1), MAX_DAYS);
    subscription = {
      tier,
      status: 'active',
      startedAt: now,
      expiresAt: now + days * 86_400_000,
    };
  }

  await putSubscription(env, user.id, subscription);

  // Close the request that triggered this grant, if any.
  const requestId = (body.requestId ?? '').trim();
  if (requestId) {
    const record = await env.AUTH.get<UpgradeRequest>(`subreq:${requestId}`, 'json');
    if (record && record.userId === user.id) {
      await env.AUTH.put(
        `subreq:${requestId}`,
        JSON.stringify({ ...record, status: 'approved', approvedAt: now }),
        { expirationTtl: 60 * 60 * 24 * 180 },
      );
      const index = await env.AUTH.get<string[]>(REQUEST_INDEX, 'json');
      if (Array.isArray(index)) {
        await env.AUTH.put(REQUEST_INDEX, JSON.stringify(index.filter((id) => id !== requestId)));
      }
    }
  }

  console.log(`subscription grant @${user.username} -> ${tier} by ${context.user.email}`);
  return json({
    ok: true,
    subscription,
    user: { username: user.username, email: user.email, name: user.name },
  });
};

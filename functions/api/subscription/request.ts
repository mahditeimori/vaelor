/**
 * POST /api/subscription/request
 *
 * A signed-in member asks for a paid plan. The request is written to KV so the
 * owner console can see it from any browser; it never changes entitlement by
 * itself. Only `/api/subscription/grant` (owner-only) writes a tier.
 */
import type { Handler } from '../auth/_lib';
import {
  fail,
  getSessionContext,
  json,
  randomToken,
  readJson,
  requestIp,
  tooManyAttempts,
} from '../auth/_lib';

type PlanId = 'operator' | 'desk';

interface Body {
  plan?: string;
  period?: string;
}

export interface UpgradeRequest {
  id: string;
  userId: string;
  username: string;
  email: string;
  plan: PlanId;
  planName: string;
  price: string;
  period: 'monthly' | 'annual';
  at: number;
  status: 'pending' | 'approved' | 'dismissed';
}

export const REQUEST_INDEX = 'subreqidx';
const REQUEST_TTL = 60 * 60 * 24 * 180;

const CATALOGUE: Record<PlanId, { name: string; monthly: number; annual: number }> = {
  operator: { name: 'Operator', monthly: 49, annual: 490 },
  desk: { name: 'Desk', monthly: 199, annual: 1990 },
};

export const onRequestPost: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');

  const { user } = context;
  if (await tooManyAttempts(env, `subreq:${user.id}`, 5, 3600)) {
    return fail(429, 'rate_limited', 'You already sent several requests. Wait an hour or email the desk.');
  }

  const body = await readJson<Body>(request);
  const plan = body?.plan;
  if (plan !== 'operator' && plan !== 'desk') {
    return fail(400, 'plan_invalid', 'Choose the Operator or Desk plan.');
  }
  const period = body?.period === 'annual' ? 'annual' : 'monthly';
  const entry = CATALOGUE[plan];
  const price = period === 'annual' ? `$${entry.annual}/yr` : `$${entry.monthly}/mo`;

  // One pending request per member and plan keeps the owner list clean.
  const rawIndex = await env.AUTH.get(REQUEST_INDEX, 'json');
  const index = Array.isArray(rawIndex) ? rawIndex.filter((id): id is string => typeof id === 'string') : [];
  for (const id of index.slice(0, 40)) {
    const existing = await env.AUTH.get<UpgradeRequest>(`subreq:${id}`, 'json');
    if (
      existing &&
      existing.status === 'pending' &&
      existing.userId === user.id &&
      existing.plan === plan
    ) {
      return json({ ok: true, duplicate: true, id: existing.id, planName: entry.name });
    }
  }

  const record: UpgradeRequest = {
    id: randomToken(8),
    userId: user.id,
    username: user.username,
    email: user.email,
    plan,
    planName: entry.name,
    price,
    period,
    at: Date.now(),
    status: 'pending',
  };

  await env.AUTH.put(`subreq:${record.id}`, JSON.stringify(record), { expirationTtl: REQUEST_TTL });
  await env.AUTH.put(REQUEST_INDEX, JSON.stringify([record.id, ...index].slice(0, 200)));

  console.log(`subscription request @${user.username} -> ${plan} (${price}) from ${requestIp(request)}`);
  return json({ ok: true, id: record.id, planName: entry.name, price });
};

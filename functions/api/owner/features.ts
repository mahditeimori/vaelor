/**
 * GET  /api/owner/features — list the owner-managed capability catalog.
 * POST /api/owner/features — owner-only; appends
 *                            { feature: { key, label, section, tier, price } }
 *                            to the catalog stored in KV key `features:owner`.
 *
 * Storage (AUTH KV): `features:owner` — JSON array of
 *   { key, label, section: 'Terminal'|'Execution'|'Playbook'|'Other',
 *     tier: 'free'|'operator'|'desk', price: number, addedAt: number }
 * Keys are lowercase slugs (e.g. `cross-session-hedging`) so the catalog is
 * renderable and addressable in the owner dashboard.
 */
import type { Env, Handler } from '../auth/_lib';
import { fail, getSessionContext, isOwnerEmail, json, readJson, requestIp, sameOriginError, tooManyAttempts } from '../auth/_lib';

export const FEATURES_KV_KEY = 'features:owner';

const MAX_CAPABILITIES = 500;
const SECTIONS = ['Terminal', 'Execution', 'Playbook', 'Other'];

export interface Capability {
  key: string;
  label: string;
  section: string;
  tier: string;
  price: number;
  addedAt: number;
}

async function readCapabilities(env: Env): Promise<Capability[]> {
  const raw = await env.AUTH.get<Capability[]>(FEATURES_KV_KEY, 'json');
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is Capability =>
      Boolean(c) && typeof c?.key === 'string' && c.key.length > 0 && typeof c?.label === 'string',
  );
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

interface PostBody {
  feature?: Partial<Capability>;
}

export const onRequestGet: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  if (!isOwnerEmail(env, context.user.email)) return fail(403, 'not_owner', 'Owner access required.');

  const features = await readCapabilities(env);
  return json({ ok: true, features });
};

export const onRequestPost: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  if (!isOwnerEmail(env, context.user.email)) return fail(403, 'not_owner', 'Owner access required.');
  const originError = sameOriginError(request, env);
  if (originError) return fail(403, originError);
  if (await tooManyAttempts(env, `owner-feature:${context.user.id}`, 10, 3600)) {
    return fail(429, 'rate_limited', 'Too many feature edits. Try again later.');
  }
  const ip = requestIp(request);
  if (await tooManyAttempts(env, `owner-feature:${ip}`, 60, 3600)) {
    return fail(429, 'rate_limited', 'Too many feature edits from this network.');
  }

  const body = await readJson<PostBody>(request);
  const input = body?.feature;
  if (!input || typeof input !== 'object') {
    return fail(400, 'feature_missing', 'Expected { feature: { key, label, ... } }.');
  }

  const key = slugify(String(input.key ?? ''));
  const label = String(input.label ?? '').trim();
  if (!key) return fail(400, 'key_invalid', 'Give the capability a lowercase key.');
  if (!label) return fail(400, 'label_invalid', 'The capability needs a name.');

  const section = SECTIONS.includes(String(input.section ?? '')) ? String(input.section) : 'Other';
  let tier = 'free';
  if (input.tier === 'operator' || input.tier === 'desk') tier = input.tier;
  const price = Math.max(0, Number(input.price ?? 0) || 0);

  const feature: Capability = { key, label, section, tier, price, addedAt: Date.now() };
  const next = [...(await readCapabilities(env)), feature].slice(0, MAX_CAPABILITIES);
  await env.AUTH.put(FEATURES_KV_KEY, JSON.stringify(next));

  console.log(`owner capability added: ${key} (${label}) by ${context.user.email}`);
  return json({ ok: true, feature, features: next });
};

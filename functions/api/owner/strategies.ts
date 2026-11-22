/**
 * GET  /api/owner/strategies
 *   Owner (session user is in OWNER_EMAILS): the full list, mode 'owner'.
 *   Signed-in members: the rows their tier can see — `visibleTiers` empty
 *   means everyone, otherwise the row shows to a member whose tier is listed
 *   (free < operator < desk). Non-owner, non-member sessions get 401.
 * POST /api/owner/strategies — owner-only append of
 *                              { strategy: { title, description, strategyId?, visibleTiers? } }
 *                              to KV key `strategies:owner`.
 *
 * Storage (AUTH KV): `strategies:owner` — JSON array of
 *   { title, description, strategyId, visibleTiers: string[], addedAt: number }
 */
import type { Env, Handler } from '../auth/_lib';
import { fail, getSessionContext, isOwnerEmail, json, readJson } from '../auth/_lib';

export const STRATEGIES_KV_KEY = 'strategies:owner';

const MAX_STRATEGIES = 200;
const TIER_RANK: Record<string, number> = { free: 0, operator: 1, desk: 2 };
const TIER_VALUES = ['free', 'operator', 'desk'];

export interface Strategy {
  title: string;
  description: string;
  strategyId: string;
  visibleTiers: string[];
  addedAt: number;
}

async function readStrategies(env: Env): Promise<Strategy[]> {
  const raw = await env.AUTH.get<Strategy[]>(STRATEGIES_KV_KEY, 'json');
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is Strategy => Boolean(s) && typeof s?.title === 'string' && s.title.length > 0,
  );
}

export const onRequestGet: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');

  const strategies = await readStrategies(env);
  if (isOwnerEmail(env, context.user.email)) {
    return json({ ok: true, mode: 'owner', strategies });
  }

  const tier = context.subscription.tier;
  const visible = strategies.filter((s) => {
    const tiers = Array.isArray(s.visibleTiers) ? s.visibleTiers : [];
    return tiers.length === 0 || tiers.includes(tier);
  });
  return json({ ok: true, mode: 'member', tier, strategies: visible });
};

interface PostBody {
  strategy?: Partial<Strategy>;
}

export const onRequestPost: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  if (!isOwnerEmail(env, context.user.email)) return fail(403, 'not_owner', 'Owner access required.');

  const body = await readJson<PostBody>(request);
  const input = body?.strategy;
  if (!input || typeof input !== 'object') {
    return fail(400, 'strategy_missing', 'Expected { strategy: { title, description, ... } }.');
  }

  const title = String(input.title ?? '').trim();
  if (!title) return fail(400, 'title_invalid', 'Name the strategy.');
  const description = String(input.description ?? '').trim();
  const strategyId = String(input.strategyId ?? '').trim().slice(0, 32);
  const visibleTiers = Array.isArray(input.visibleTiers)
    ? input.visibleTiers.filter((t): t is string => TIER_VALUES.includes(String(t)))
    : [];

  const strategy: Strategy = { title, description, strategyId, visibleTiers, addedAt: Date.now() };
  const next = [...(await readStrategies(env)), strategy].slice(0, MAX_STRATEGIES);
  await env.AUTH.put(STRATEGIES_KV_KEY, JSON.stringify(next));

  console.log(`owner strategy added: ${title} by ${context.user.email}`);
  return json({ ok: true, strategy, strategies: next });
};

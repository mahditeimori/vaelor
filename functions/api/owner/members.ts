/**
 * GET    /api/owner/members — owner-only inventory of the AUTH KV:
 *        registered members (`u:<email>`) with current subscriptions, plus
 *        live sessions (`sid:<id>`) with the owning user id.
 * POST   /api/owner/members/delete — see members/delete.ts (owner-only removal of one user).
 *
 * Client: src/scripts/owner.ts — "User detail" panel on the Owner console.
 */
import type { Env, Handler, SessionRecord, UserRecord } from '../auth/_lib';
import { fail, getSessionContext, getSubscription, isOwnerEmail, json } from '../auth/_lib';

/**
 * `list()` exists on the real KV namespace but is missing from KVLike in
 * _lib.ts, so re-type it here. The REST API returns `keys: [{ name }]`; older
 * shapes returned plain strings, so both are accepted.
 */
export interface KVListPage {
  keys: Array<string | { name?: string; key?: string }>;
  cursor?: string;
}

export type KVWithList = Env['AUTH'] & {
  list(params?: { prefix?: string; limit?: number; cursor?: string }): Promise<KVListPage>;
};

export const MAX_MEMBERS = 300;
export const MAX_SESSIONS = 200;

export async function listKeys(kv: KVWithList, prefix: string, cap: number): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const params: { prefix: string; limit: number; cursor?: string } = { prefix, limit: 500 };
    if (cursor) params.cursor = cursor;
    const page = await kv.list(params);
    for (const entry of page.keys) {
      const name = typeof entry === 'string' ? entry : entry.name ?? entry.key;
      if (name) names.push(name);
    }
    cursor = page.cursor;
  } while (cursor && names.length < cap);
  return names.slice(0, cap);
}

export interface OwnerMember {
  id: string;
  email: string;
  username: string;
  name: string;
  firstName: string;
  lastName: string;
  providers: string[];
  createdAt: number;
  subscription: { tier: string; status: string; startedAt: number | null; expiresAt: number | null };
  daysLeft: number;
}

export interface OwnerSession {
  id: string;
  userId: string;
  email: string;
  provider: string;
  createdAt: number;
  expiresAt: number;
}

export async function findMember(
  env: Env,
  kv: KVWithList,
  filter: { username: string; email: string; id: string },
): Promise<UserRecord | null> {
  const username = filter.username.trim().toLowerCase();
  const email = filter.email.trim().toLowerCase();
  const id = filter.id.trim();
  for (const keyName of await listKeys(kv, 'u:', MAX_MEMBERS)) {
    const user = await env.AUTH.get<UserRecord>(keyName, 'json');
    if (!user) continue;
    const matchesUsername = Boolean(username) && user.username.toLowerCase() === username;
    const matchesEmail = Boolean(email) && user.email === email;
    const matchesId = Boolean(id) && user.id === id;
    if (matchesUsername || matchesEmail || matchesId) return user;
  }
  return null;
}

export const onRequestGet: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  if (!isOwnerEmail(env, context.user.email)) return fail(403, 'not_owner', 'Owner access required.');

  const kv = env.AUTH as KVWithList;

  const now = Date.now();
  const members: OwnerMember[] = [];
  for (const keyName of await listKeys(kv, 'u:', MAX_MEMBERS)) {
    const user = await env.AUTH.get<UserRecord>(keyName, 'json');
    if (!user) continue;
    const subscription = await getSubscription(env, user.id);
    members.push({
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      firstName: user.name.split(' ')[0] ?? user.name,
      lastName: user.name.split(' ').slice(1).join(' '),
      providers: user.providers,
      createdAt: user.createdAt,
      subscription,
      daysLeft: subscription.expiresAt
        ? Math.max(0, Math.ceil((subscription.expiresAt - now) / 86_400_000))
        : 0,
    });
  }
  members.sort((a, b) => b.createdAt - a.createdAt);

  const sessions: OwnerSession[] = [];
  for (const keyName of await listKeys(kv, 'sid:', MAX_SESSIONS)) {
    const record = await env.AUTH.get<SessionRecord>(keyName, 'json');
    if (!record || !(record.expiresAt > now)) continue;
    sessions.push({
      id: keyName.slice('sid:'.length),
      userId: record.userId,
      email: record.email,
      provider: record.provider,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    });
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt);

  return json({ ok: true, members, sessions });
};

/**
 * POST /api/owner/members/delete — owner-only removal of one member.
 *
 * Deletes the member's `u:<email>`, `un:<username>` and `s:<userId>` records
 * plus every active `sid:` session so their other browsers stop working.
 *
 * Lives in its own file because Pages Functions map one file to one URL path;
 * the handler cannot live in `../members.ts` (that file serves GET
 * /api/owner/members).
 */
import type { Env, Handler, SessionRecord } from '../../auth/_lib';
import { fail, getSessionContext, isOwnerEmail, json, readJson, requestIp, sameOriginError, tooManyAttempts } from '../../auth/_lib';
import { findMember, listKeys, MAX_SESSIONS, type KVWithList } from '../members';

interface DeleteBody {
  username?: string;
  email?: string;
  id?: string;
}

export const onRequestPost: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  if (!isOwnerEmail(env, context.user.email)) return fail(403, 'not_owner', 'Owner access required.');
  const originError = sameOriginError(request, env);
  if (originError) return fail(403, originError);
  if (await tooManyAttempts(env, `owner-delete:${context.user.id}`, 5, 3600)) {
    return fail(429, 'rate_limited', 'Too many delete requests. Try again later.');
  }
  const ip = requestIp(request);
  if (await tooManyAttempts(env, `owner-delete:${ip}`, 30, 3600)) {
    return fail(429, 'rate_limited', 'Too many delete requests from this network.');
  }

  const body = await readJson<DeleteBody>(request);
  const username = String(body?.username ?? '').trim();
  const email = String(body?.email ?? '').trim();
  const id = String(body?.id ?? '').trim();
  if (!username && !email && !id) {
    return fail(400, 'user_not_provided', 'Pass username, email and/or id.');
  }

  const kv = env.AUTH as KVWithList;
  const target = await findMember(env, kv, { username, email, id });
  if (!target) return fail(404, 'user_not_found');

  await env.AUTH.delete(`u:${target.email}`);
  await env.AUTH.delete(`un:${target.username.toLowerCase()}`);
  await env.AUTH.delete(`s:${target.id}`);

  // Remove active sessions of this user so their other browsers can't
  // continue while their account records are gone.
  const now = Date.now();
  let sessionsRemoved = 0;
  for (const keyName of await listKeys(kv, 'sid:', MAX_SESSIONS)) {
    const record = await env.AUTH.get<SessionRecord>(keyName, 'json');
    if (!record || record.userId !== target.id) continue;
    if (!(record.expiresAt > now)) continue;
    await env.AUTH.delete(keyName);
    sessionsRemoved += 1;
  }

  console.log(`owner member deleted: ${target.username} (${target.email}) by ${context.user.email}`);
  return json({
    ok: true,
    deleted: { email: target.email, username: target.username, id: target.id, sessionsRemoved },
  });
};

/**
 * POST /api/auth/admin-password — owner-issued password reset.
 *
 * Needed when transactional email (Resend) is not configured: the owner signs
 * in normally, then sets a temporary password for a member who is locked out.
 * Only addresses listed in OWNER_EMAILS may call it, so a compromised member
 * session cannot take over another account.
 */
import type { Handler } from './_lib';
import {
  fail,
  getSessionContext,
  getUser,
  hashPassword,
  isEmail,
  isOwnerEmail,
  json,
  normaliseEmail,
  putUser,
  readJson,
  requestIp,
  sameOriginError,
  tooManyAttempts,
} from './_lib';

interface Body {
  email?: string;
  password?: string;
}

export const onRequestPost: Handler = async ({ request, env }) => {
  const context = await getSessionContext(request, env);
  if (!context) return fail(401, 'not_authenticated');
  if (!isOwnerEmail(env, context.user.email)) {
    return fail(403, 'not_owner', 'Owner access required.');
  }
  const originError = sameOriginError(request, env);
  if (originError) return fail(403, originError);
  if (await tooManyAttempts(env, `admin-password:${context.user.id}`, 5, 3600)) {
    return fail(429, 'rate_limited', 'Too many reset requests. Try again later.');
  }
  const ip = requestIp(request);
  if (await tooManyAttempts(env, `admin-password:${ip}`, 12, 3600)) {
    return fail(429, 'rate_limited', 'Too many reset requests from this network.');
  }

  const body = await readJson<Body>(request);
  const email = normaliseEmail(body?.email ?? '');
  const password = body?.password ?? '';
  if (!isEmail(email)) return fail(400, 'email_invalid', 'Enter a valid member email.');
  if (password.length < 8) return fail(400, 'password_weak', 'Use at least 8 characters.');

  const user = await getUser(env, email);
  if (!user) return fail(404, 'user_not_found', 'No member with that email.');

  user.pw = await hashPassword(password);
  await putUser(env, user);
  return json({ ok: true, message: `Password reset for ${user.email}.` });
};
